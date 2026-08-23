import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Algorithm, hash } from "@node-rs/argon2";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { generate } from "otplib";
import { Pool } from "pg";
import { Reflector } from "@nestjs/core";
import { AuthGuard, AuthService, ROLES_ROUTE } from "./auth.js";
import { DomainError } from "./core.js";

loadEnv({ path: resolve(process.cwd(), ".env"), quiet: true });
if (!process.env.DATABASE_URL) loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://botcrm:botcrm_dev_password@localhost:5432/botcrm";
const workspaceId = "00000000-0000-4000-8000-000000000001";

test("Argon2id sessions and TOTP MFA protect an authenticated user", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const userId = randomUUID();
  const email = `auth-${randomUUID()}@botcrm.test`;
  const password = `Strong-${randomUUID()}!`;
  const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  await pool.query("insert into users(id,workspace_id,email,display_name,password_hash,password_changed_at,role) values($1,$2,$3,'Auth Integration',$4,now(),'OPERATOR')", [userId, workspaceId, email, passwordHash]);
  const previousAuthRequired = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  const auth = new AuthService();
  await auth.onModuleInit();
  try {
    assert.equal(await auth.principal({}), undefined);
    const login = await auth.login({ workspace: "ws_demo", email, password }, { ip: "127.0.0.2", userAgent: "integration-test" });
    assert.ok(login.token);
    assert.equal(login.user.role, "OPERATOR");
    const principal = await auth.principal({ authorization: `Bearer ${login.token}` });
    assert.equal(principal?.userId, userId);
    const setup = await auth.setupMfa(login.user);
    assert.ok(setup.uri.startsWith("otpauth://"));
    const firstCode = await generate({ secret: setup.secret });
    assert.deepEqual(await auth.verifyMfaSetup(login.user, firstCode), { enabled: true });
    await auth.logout(login.user);
    assert.equal(await auth.principal({ authorization: `Bearer ${login.token}` }), undefined);
    await assert.rejects(() => auth.login({ workspace: "ws_demo", email, password }, { ip: "127.0.0.2" }), (error: unknown) => error instanceof DomainError && error.code === "mfa_required");
    const secondCode = await generate({ secret: setup.secret });
    const second = await auth.login({ workspace: "ws_demo", email, password, totp: secondCode }, { ip: "127.0.0.2", userAgent: "integration-test-2" });
    assert.equal(second.user.mfaEnabled, true);
    const sessions = await auth.sessions(second.user);
    assert.ok(sessions.some((session) => session.current));
    const disableCode = await generate({ secret: setup.secret });
    assert.deepEqual(await auth.disableMfa(second.user, password, disableCode), { enabled: false });
    const reflector = new Reflector();
    const handler = () => undefined;
    Reflect.defineMetadata(ROLES_ROUTE, ["OWNER"], handler);
    const request = { headers: { authorization: `Bearer ${second.token}`, "x-workspace-id": "another-workspace" } as Record<string, string>, auth: undefined as unknown };
    const context = { getHandler: () => handler, getClass: () => class TestController {}, switchToHttp: () => ({ getRequest: () => request }) } as any;
    await assert.rejects(() => new AuthGuard(reflector, auth).canActivate(context), (error: unknown) => error instanceof DomainError && error.code === "forbidden");
    Reflect.defineMetadata(ROLES_ROUTE, ["OPERATOR"], handler);
    assert.equal(await new AuthGuard(reflector, auth).canActivate(context), true);
    assert.equal(request.headers["x-workspace-id"], workspaceId);
    await auth.revokeSession(second.user, second.user.sessionId!);
    assert.equal(await auth.principal({ authorization: `Bearer ${second.token}` }), undefined);
  } finally {
    process.env.AUTH_REQUIRED = previousAuthRequired;
    await auth.onModuleDestroy();
    await pool.query("delete from auth_login_attempts where lower(email)=lower($1)", [email]);
    await pool.query("delete from users where id=$1", [userId]);
    await pool.end();
  }
});
test("Owner manages users and revocable service tokens", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const auth = new AuthService();
  const previousAuthRequired = process.env.AUTH_REQUIRED;
  process.env.AUTH_REQUIRED = "true";
  await auth.onModuleInit();
  const owner = { userId: "00000000-0000-4000-8000-000000000002", workspaceId, email: "owner@botcrm.local", displayName: "Евгений", role: "OWNER" as const, mfaEnabled: false };
  const email = `managed-${randomUUID()}@botcrm.test`;
  let userId: string | undefined;
  let tokenId: string | undefined;
  try {
    const created = await auth.createUser(owner, { email, displayName: "Managed User", password: `Managed-${randomUUID()}!`, role: "OPERATOR" });
    userId = created.userId;
    assert.ok((await auth.listUsers(owner)).some((user) => user.userId === userId));
    assert.equal((await auth.updateUser(owner, userId!, { role: "SUPERVISOR" })).role, "SUPERVISOR");
    const token = await auth.createServiceToken(owner, { name: `SDK ${randomUUID()}` });
    tokenId = token.id;
    assert.ok(token.token.startsWith("botcrm_svc_"));
    const service = await auth.principal({ "x-service-token": token.token });
    assert.equal(service?.role, "SERVICE");
    assert.equal(service?.workspaceId, workspaceId);
    await auth.revokeServiceToken(owner, token.id);
    assert.equal(await auth.principal({ "x-service-token": token.token }), undefined);
  } finally {
    process.env.AUTH_REQUIRED = previousAuthRequired;
    await auth.onModuleDestroy();
    if (tokenId) await pool.query("delete from service_tokens where id=$1", [tokenId]);
    await pool.query("delete from auth_login_attempts where lower(email)=lower($1)", [email]);
    if (userId) await pool.query("delete from users where id=$1", [userId]);
    await pool.end();
  }
});
test("legacy service token defaults to the bootstrap workspace", async () => {
  const previousServiceToken = process.env.SERVICE_TOKEN;
  const previousServiceWorkspace = process.env.SERVICE_TOKEN_WORKSPACE_ID;
  const previousBootstrapWorkspace = process.env.BOOTSTRAP_WORKSPACE_ID;
  const token = `legacy-${randomUUID()}-${randomUUID()}`;
  const bootstrapWorkspace = randomUUID();
  process.env.SERVICE_TOKEN = token;
  delete process.env.SERVICE_TOKEN_WORKSPACE_ID;
  process.env.BOOTSTRAP_WORKSPACE_ID = bootstrapWorkspace;
  try {
    const principal = await new AuthService().principal({ "x-service-token": token, "x-workspace-id": bootstrapWorkspace });
    assert.equal(principal?.workspaceId, bootstrapWorkspace);
    assert.equal(principal?.role, "SERVICE");
  } finally {
    if (previousServiceToken === undefined) delete process.env.SERVICE_TOKEN; else process.env.SERVICE_TOKEN = previousServiceToken;
    if (previousServiceWorkspace === undefined) delete process.env.SERVICE_TOKEN_WORKSPACE_ID; else process.env.SERVICE_TOKEN_WORKSPACE_ID = previousServiceWorkspace;
    if (previousBootstrapWorkspace === undefined) delete process.env.BOOTSTRAP_WORKSPACE_ID; else process.env.BOOTSTRAP_WORKSPACE_ID = previousBootstrapWorkspace;
  }
});
test("RBAC protects owners and preserves an active workspace owner", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const auth = new AuthService();
  const testWorkspaceId = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const memberId = randomUUID();
  await pool.query("insert into workspaces(id,name,timezone) values($1,$2,'UTC')", [testWorkspaceId, `RBAC ${testWorkspaceId}`]);
  await pool.query(`insert into users(id,workspace_id,email,display_name,role) values
    ($1,$4,$5,'Workspace Owner','OWNER'),
    ($2,$4,$6,'Workspace Admin','ADMIN'),
    ($3,$4,$7,'Workspace Member','OPERATOR')`, [ownerId, adminId, memberId, testWorkspaceId, `owner-${testWorkspaceId}@test.local`, `admin-${testWorkspaceId}@test.local`, `member-${testWorkspaceId}@test.local`]);
  await auth.onModuleInit();
  const owner = { userId: ownerId, workspaceId: testWorkspaceId, email: `owner-${testWorkspaceId}@test.local`, displayName: "Workspace Owner", role: "OWNER" as const, mfaEnabled: false };
  const admin = { userId: adminId, workspaceId: testWorkspaceId, email: `admin-${testWorkspaceId}@test.local`, displayName: "Workspace Admin", role: "ADMIN" as const, mfaEnabled: false };
  try {
    await assert.rejects(() => auth.updateUser(admin, ownerId, { role: "ADMIN" }), (error: unknown) => error instanceof DomainError && error.status === 403 && error.code === "owner_protected");
    await assert.rejects(() => auth.updateUser(admin, ownerId, { disabled: true }), (error: unknown) => error instanceof DomainError && error.status === 403 && error.code === "owner_protected");
    await assert.rejects(() => auth.updateUser(admin, memberId, { role: "OWNER" }), (error: unknown) => error instanceof DomainError && error.status === 403 && error.code === "owner_assignment_forbidden");
    assert.equal((await auth.updateUser(admin, memberId, { role: "SUPERVISOR" })).role, "SUPERVISOR");
    await assert.rejects(() => auth.updateUser(admin, memberId, { role: "SERVICE" as any }), (error: unknown) => error instanceof DomainError && error.status === 400 && error.code === "invalid_user_role");
    await assert.rejects(() => auth.updateUser(admin, memberId, { disabled: "yes" as any }), (error: unknown) => error instanceof DomainError && error.status === 400 && error.code === "invalid_user_update");
    await assert.rejects(() => auth.updateUser(owner, ownerId, { role: "ADMIN" }), (error: unknown) => error instanceof DomainError && error.status === 409 && error.code === "self_role_change_forbidden");
    await assert.rejects(() => auth.updateUser(owner, ownerId, { disabled: true }), (error: unknown) => error instanceof DomainError && error.status === 409 && error.code === "self_disable_forbidden");
    const externalOwner = { ...owner, userId: randomUUID() };
    await assert.rejects(() => auth.updateUser(externalOwner, ownerId, { role: "ADMIN" }), (error: unknown) => error instanceof DomainError && error.status === 409 && error.code === "last_owner_required");
    assert.equal((await auth.updateUser(owner, memberId, { role: "OWNER" })).role, "OWNER");
  } finally {
    await auth.onModuleDestroy();
    await pool.query("delete from workspaces where id=$1", [testWorkspaceId]);
    await pool.end();
  }
});
test("database login limiter blocks account rotation and IP rotation", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const auth = new AuthService();
  const suffix = randomUUID();
  const accountEmail = `brute-${suffix}-account@botcrm.test`;
  const sharedIp = "127.0.20.50";
  const previous = {
    authRequired: process.env.AUTH_REQUIRED,
    pair: process.env.LOGIN_RATE_LIMIT_PAIR_MAX,
    email: process.env.LOGIN_RATE_LIMIT_EMAIL_MAX,
    ip: process.env.LOGIN_RATE_LIMIT_IP_MAX,
    window: process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES,
  };
  process.env.AUTH_REQUIRED = "true";
  process.env.LOGIN_RATE_LIMIT_PAIR_MAX = "2";
  process.env.LOGIN_RATE_LIMIT_EMAIL_MAX = "2";
  process.env.LOGIN_RATE_LIMIT_IP_MAX = "100";
  process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES = "15";
  await auth.onModuleInit();
  try {
    for (const ip of ["127.0.20.1", "127.0.20.2"]) {
      await assert.rejects(() => auth.login({ workspace: "ws_demo", email: accountEmail, password: "wrong-password" }, { ip }), (error: unknown) => error instanceof DomainError && error.code === "invalid_credentials");
    }
    await assert.rejects(() => auth.login({ workspace: "ws_demo", email: accountEmail, password: "wrong-password" }, { ip: "127.0.20.3" }), (error: unknown) => error instanceof DomainError && error.status === 429 && error.code === "login_rate_limited");

    await pool.query("delete from auth_login_attempts where email like $1", [`brute-${suffix}-%`]);
    process.env.LOGIN_RATE_LIMIT_EMAIL_MAX = "100";
    process.env.LOGIN_RATE_LIMIT_IP_MAX = "2";
    for (const index of [1, 2]) {
      await assert.rejects(() => auth.login({ workspace: "ws_demo", email: `brute-${suffix}-${index}@botcrm.test`, password: "wrong-password" }, { ip: sharedIp }), (error: unknown) => error instanceof DomainError && error.code === "invalid_credentials");
    }
    await assert.rejects(() => auth.login({ workspace: "ws_demo", email: `brute-${suffix}-3@botcrm.test`, password: "wrong-password" }, { ip: sharedIp }), (error: unknown) => error instanceof DomainError && error.status === 429 && error.code === "login_rate_limited");
  } finally {
    if (previous.authRequired === undefined) delete process.env.AUTH_REQUIRED; else process.env.AUTH_REQUIRED = previous.authRequired;
    if (previous.pair === undefined) delete process.env.LOGIN_RATE_LIMIT_PAIR_MAX; else process.env.LOGIN_RATE_LIMIT_PAIR_MAX = previous.pair;
    if (previous.email === undefined) delete process.env.LOGIN_RATE_LIMIT_EMAIL_MAX; else process.env.LOGIN_RATE_LIMIT_EMAIL_MAX = previous.email;
    if (previous.ip === undefined) delete process.env.LOGIN_RATE_LIMIT_IP_MAX; else process.env.LOGIN_RATE_LIMIT_IP_MAX = previous.ip;
    if (previous.window === undefined) delete process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES; else process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES = previous.window;
    await auth.onModuleDestroy();
    await pool.query("delete from auth_login_attempts where email like $1 or ip_address=$2::inet", [`brute-${suffix}-%`, sharedIp]);
    await pool.end();
  }
});
