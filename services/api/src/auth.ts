import { Algorithm, hash, verify as verifyPassword } from "@node-rs/argon2";
import { CanActivate, ExecutionContext, Inject, Injectable, OnModuleDestroy, OnModuleInit, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { generateSecret, generateURI, verify as verifyTotp } from "otplib";
import { Pool } from "pg";
import { DomainError } from "./core.js";

export type UserRole = "OWNER" | "ADMIN" | "SUPERVISOR" | "OPERATOR" | "SERVICE";
const HUMAN_USER_ROLES = ["OWNER", "ADMIN", "SUPERVISOR", "OPERATOR"] as const;
function isHumanUserRole(value: unknown): value is Exclude<UserRole, "SERVICE"> { return HUMAN_USER_ROLES.includes(value as Exclude<UserRole, "SERVICE">); }
export interface AuthPrincipal { sessionId?: string; userId: string; workspaceId: string; email: string; displayName: string; role: UserRole; mfaEnabled: boolean; service?: boolean; }
export const PUBLIC_ROUTE = "botcrm:public";
export const ROLES_ROUTE = "botcrm:roles";
export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true);
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_ROUTE, roles);

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function secureEqual(left: string, right: string) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function argonOptions() { return { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }; }

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private dummyPasswordHash = "";
  async onModuleInit() {
    if (!process.env.DATABASE_URL) return;
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
    await this.pool.query("select 1");
    this.dummyPasswordHash = await hash(randomBytes(32).toString("base64url"), argonOptions());
    await this.bootstrapOwner();
  }
  async onModuleDestroy() { await this.pool?.end(); }
  private database() { if (!this.pool) throw new DomainError(503, "Authentication storage is unavailable", "auth_storage_unavailable"); return this.pool; }
  private encryptionKeys() {
    const master = process.env.MASTER_ENCRYPTION_KEY;
    if (!master || master.length < 32) throw new DomainError(503, "MASTER_ENCRYPTION_KEY must contain at least 32 characters", "encryption_key_missing");
    const primary = createHash("sha256").update(master).digest();
    const legacy = Buffer.from(master, "base64");
    return legacy.length === 32 && !legacy.equals(primary) ? [primary, legacy] : [primary];
  }
  private encryptionKey() { return this.encryptionKeys()[0]; }
  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }
  private decrypt(value: string) {
    const [version, iv, tag, encrypted] = value.split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) throw new DomainError(500, "Encrypted secret format is invalid", "secret_format_invalid");
    for (const key of this.encryptionKeys()) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
      } catch { /* Try the legacy base64-derived key used by early installations. */ }
    }
    throw new DomainError(500, "Encrypted secret cannot be decrypted", "secret_decryption_failed");
  }
  private async workspaceId(workspace = "ws_demo") {
    const pool = this.database();
    if (workspace === "ws_demo") return "00000000-0000-4000-8000-000000000001";
    const result = await pool.query("select id from workspaces where id::text=$1 or lower(name)=lower($1) limit 1", [workspace]);
    if (!result.rowCount) throw new DomainError(404, "Workspace not found", "workspace_not_found");
    return result.rows[0].id as string;
  }
  private async bootstrapOwner() {
    const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
    const email = process.env.BOOTSTRAP_OWNER_EMAIL ?? "owner@botcrm.local";
    if (!password || !this.pool) return;
    if (password.length < 12) throw new Error("BOOTSTRAP_OWNER_PASSWORD must contain at least 12 characters");
    const workspaceId = process.env.BOOTSTRAP_WORKSPACE_ID ?? "00000000-0000-4000-8000-000000000001";
    const workspaceName = process.env.BOOTSTRAP_WORKSPACE_NAME?.trim() || "Bot Studio";
    const workspaceTimezone = process.env.BOOTSTRAP_WORKSPACE_TIMEZONE?.trim() || "Europe/Moscow";
    const passwordHash = await hash(password, argonOptions());
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("insert into workspaces(id,name,timezone) values($1,$2,$3) on conflict(id) do update set name=excluded.name,timezone=excluded.timezone", [workspaceId, workspaceName, workspaceTimezone]);
      const user = await client.query("select id,password_hash from users where workspace_id=$1 and lower(email)=lower($2) limit 1 for update", [workspaceId, email]);
      if (!user.rowCount) {
        await client.query("insert into users(workspace_id,email,display_name,password_hash,password_changed_at,role) values($1,lower($2),$3,$4,now(),'OWNER')", [workspaceId, email, process.env.BOOTSTRAP_OWNER_NAME?.trim() || "Владелец", passwordHash]);
        console.log("BotCRM auth: bootstrap owner created");
      } else if (!user.rows[0].password_hash) {
        await client.query("update users set password_hash=$2,password_changed_at=now() where id=$1", [user.rows[0].id, passwordHash]);
        console.log("BotCRM auth: bootstrap owner password initialized");
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally { client.release(); }
  }
  async login(input: { workspace?: string; email: string; password: string; totp?: string }, meta: { ip?: string; userAgent?: string }) {
    const pool = this.database();
    const workspaceId = await this.workspaceId(input.workspace);
    const email = input.email.trim().toLowerCase();
    const windowMinutes = Math.max(1, Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES ?? 15));
    const pairMax = Math.max(1, Number(process.env.LOGIN_RATE_LIMIT_PAIR_MAX ?? 5));
    const emailMax = Math.max(pairMax, Number(process.env.LOGIN_RATE_LIMIT_EMAIL_MAX ?? 10));
    const ipMax = Math.max(pairMax, Number(process.env.LOGIN_RATE_LIMIT_IP_MAX ?? 30));
    const attempts = await pool.query(`select
      count(*) filter(where lower(email)=$1 and ip_address is not distinct from $2::inet)::int pair_count,
      count(*) filter(where lower(email)=$1)::int email_count,
      count(*) filter(where ip_address is not distinct from $2::inet)::int ip_count
      from auth_login_attempts
      where workspace_id=$4 and succeeded=false and attempted_at>now()-($3::int*interval '1 minute')
        and (lower(email)=$1 or ip_address is not distinct from $2::inet)`, [email, meta.ip ?? null, windowMinutes, workspaceId]);
    const counters = attempts.rows[0] ?? {};
    if (Number(counters.pair_count ?? 0) >= pairMax || Number(counters.email_count ?? 0) >= emailMax || Number(counters.ip_count ?? 0) >= ipMax) {
      throw new DomainError(429, `Too many login attempts. Try again in ${windowMinutes} minutes`, "login_rate_limited");
    }
    const result = await pool.query("select id,workspace_id,email,display_name,password_hash,role,totp_secret_encrypted,disabled_at from users where workspace_id=$1 and lower(email)=$2 limit 1", [workspaceId, email]);
    const user = result.rows[0];
    const candidateHash = user?.password_hash || this.dummyPasswordHash;
    const passwordValid = Boolean(candidateHash) && await verifyPassword(candidateHash, input.password, argonOptions()).catch(() => false);
    if (!user || user.disabled_at || !passwordValid) {
      await pool.query("insert into auth_login_attempts(workspace_id,email,ip_address,succeeded) values($1,$2,$3,false)", [workspaceId, email, meta.ip ?? null]);
      throw new DomainError(401, "Invalid email or password", "invalid_credentials");
    }
    if (user.totp_secret_encrypted) {
      if (!input.totp) throw new DomainError(401, "Two-factor authentication code required", "mfa_required");
      const check = await verifyTotp({ secret: this.decrypt(user.totp_secret_encrypted), token: input.totp });
      if (!check.valid) {
        await pool.query("insert into auth_login_attempts(workspace_id,email,ip_address,succeeded) values($1,$2,$3,false)", [workspaceId, email, meta.ip ?? null]);
        throw new DomainError(401, "Invalid two-factor authentication code", "invalid_mfa_code");
      }
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + Number(process.env.SESSION_TTL_HOURS ?? 168) * 3_600_000);
    const session = await pool.query("insert into auth_sessions(workspace_id,user_id,token_hash,user_agent,ip_address,expires_at) values($1,$2,$3,$4,$5,$6) returning id", [workspaceId, user.id, sha256(token), meta.userAgent?.slice(0, 500) ?? null, meta.ip ?? null, expiresAt]);
    await pool.query("update users set last_login_at=now() where id=$1", [user.id]);
    await pool.query("delete from auth_login_attempts where workspace_id=$1 and lower(email)=$2 and ip_address is not distinct from $3::inet and succeeded=false", [workspaceId, email, meta.ip ?? null]);
    await pool.query("insert into auth_login_attempts(workspace_id,email,ip_address,succeeded) values($1,$2,$3,true)", [workspaceId, email, meta.ip ?? null]);
    return { token, expiresAt: expiresAt.toISOString(), user: this.mapUser({ ...user, session_id: session.rows[0].id }) };
  }
  private mapUser(row: Record<string, any>): AuthPrincipal { return { sessionId: row.session_id, userId: row.id ?? row.user_id, workspaceId: row.workspace_id, email: row.email, displayName: row.display_name, role: row.role, mfaEnabled: Boolean(row.totp_secret_encrypted) }; }
  async principal(headers: Record<string, string | string[] | undefined>): Promise<AuthPrincipal | undefined> {
    const authorization = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
    const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const headerServiceToken = Array.isArray(headers["x-service-token"]) ? headers["x-service-token"][0] : headers["x-service-token"];
    const serviceToken = headerServiceToken || (process.env.SERVICE_TOKEN && bearerToken && secureEqual(bearerToken, process.env.SERVICE_TOKEN) ? bearerToken : undefined);
    if (process.env.SERVICE_TOKEN && serviceToken && secureEqual(serviceToken, process.env.SERVICE_TOKEN)) {
      const configuredWorkspace = process.env.SERVICE_TOKEN_WORKSPACE_ID ?? "ws_demo";
      const requestedWorkspace = Array.isArray(headers["x-workspace-id"]) ? headers["x-workspace-id"][0] : headers["x-workspace-id"];
      if (requestedWorkspace && requestedWorkspace !== configuredWorkspace) throw new DomainError(403, "Service token cannot access this workspace", "service_workspace_forbidden");
      return { userId: "service", workspaceId: configuredWorkspace, email: "service@botcrm.local", displayName: "Service account", role: "SERVICE", mfaEnabled: false, service: true };
    }
    if (serviceToken) {
      const result = await this.database().query("select id,workspace_id,name from service_tokens where token_hash=$1 and revoked_at is null and (expires_at is null or expires_at>now()) limit 1", [sha256(serviceToken)]);
      if (result.rowCount) {
        await this.database().query("update service_tokens set last_used_at=now() where id=$1", [result.rows[0].id]);
        return { userId: `service:${result.rows[0].id}`, workspaceId: result.rows[0].workspace_id, email: "service@botcrm.local", displayName: result.rows[0].name, role: "SERVICE", mfaEnabled: false, service: true };
      }
    }
    if (bearerToken) {
      const result = await this.database().query(`select s.id session_id,u.id,u.workspace_id,u.email,u.display_name,u.role,u.totp_secret_encrypted
        from auth_sessions s join users u on u.id=s.user_id
        where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now() and u.disabled_at is null limit 1`, [sha256(bearerToken)]);
      if (result.rowCount) {
        await this.database().query("update auth_sessions set last_seen_at=now() where id=$1 and last_seen_at<now()-interval '5 minutes'", [result.rows[0].session_id]);
        return this.mapUser(result.rows[0]);
      }
    }
    if (process.env.AUTH_REQUIRED === "false" && process.env.ALLOW_INSECURE_AUTH_BYPASS === "true") {
      const result = await this.database().query("select id,workspace_id,email,display_name,role,totp_secret_encrypted from users where role='OWNER' and disabled_at is null order by created_at limit 1");
      if (result.rowCount) return this.mapUser(result.rows[0]);
    }
    return undefined;
  }
  async listUsers(principal: AuthPrincipal) {
    const result = await this.database().query(`select id "userId",email,display_name "displayName",role,disabled_at "disabledAt",last_login_at "lastLoginAt",created_at "createdAt",totp_secret_encrypted is not null "mfaEnabled"
      from users where workspace_id=$1 order by disabled_at nulls first,created_at`, [principal.workspaceId]);
    return result.rows;
  }
  async createUser(principal: AuthPrincipal, input: { email: string; displayName: string; password: string; role: Exclude<UserRole, "SERVICE"> }) {
    if (!input.email?.trim() || !input.displayName?.trim() || input.password?.length < 12) throw new DomainError(400, "Email, name and a password of at least 12 characters are required", "invalid_user_input");
    if (!isHumanUserRole(input.role)) throw new DomainError(400, "A valid human user role is required", "invalid_user_role");
    if (principal.role !== "OWNER" && input.role === "OWNER") throw new DomainError(403, "Only an owner can create another owner", "forbidden");
    const passwordHash = await hash(input.password, argonOptions());
    try {
      const result = await this.database().query("insert into users(workspace_id,email,display_name,password_hash,password_changed_at,role) values($1,lower($2),$3,$4,now(),$5) returning id \"userId\",email,display_name \"displayName\",role,created_at \"createdAt\",false \"mfaEnabled\"", [principal.workspaceId, input.email.trim(), input.displayName.trim(), passwordHash, input.role]);
      return result.rows[0];
    } catch (error: any) { if (error?.code === "23505") throw new DomainError(409, "A user with this email already exists", "user_exists"); throw error; }
  }
  async updateUser(principal: AuthPrincipal, userId: string, input: { role?: Exclude<UserRole, "SERVICE">; disabled?: boolean }) {
    if (input.role !== undefined && !isHumanUserRole(input.role)) throw new DomainError(400, "A valid human user role is required", "invalid_user_role");
    if (input.disabled !== undefined && typeof input.disabled !== "boolean") throw new DomainError(400, "Disabled must be a boolean", "invalid_user_update");
    if (userId === principal.userId && input.disabled) throw new DomainError(409, "You cannot disable your own account", "self_disable_forbidden");
    if (userId === principal.userId && input.role && input.role !== principal.role) throw new DomainError(409, "You cannot change your own role", "self_role_change_forbidden");
    if (principal.role !== "OWNER" && input.role === "OWNER") throw new DomainError(403, "Only an owner can assign the owner role", "owner_assignment_forbidden");
    const pool = this.database();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select id from workspaces where id=$1 for update", [principal.workspaceId]);
      const targetResult = await client.query("select id,role,disabled_at from users where id=$1 and workspace_id=$2 for update", [userId, principal.workspaceId]);
      if (!targetResult.rowCount) throw new DomainError(404, "User not found", "user_not_found");
      const target = targetResult.rows[0];
      if (target.role === "OWNER" && principal.role !== "OWNER") throw new DomainError(403, "Administrators cannot change or disable an owner", "owner_protected");
      const removesActiveOwner = target.role === "OWNER" && !target.disabled_at && (input.disabled === true || (input.role && input.role !== "OWNER"));
      if (removesActiveOwner) {
        const activeOwners = await client.query("select count(*)::int count from users where workspace_id=$1 and role='OWNER' and disabled_at is null", [principal.workspaceId]);
        if (Number(activeOwners.rows[0]?.count ?? 0) <= 1) throw new DomainError(409, "The workspace must keep at least one active owner", "last_owner_required");
      }
      const result = await client.query(`update users set role=coalesce($3,role),disabled_at=case when $4::boolean is null then disabled_at when $4 then now() else null end
        where id=$1 and workspace_id=$2 returning id "userId",email,display_name "displayName",role,disabled_at "disabledAt",last_login_at "lastLoginAt",created_at "createdAt",totp_secret_encrypted is not null "mfaEnabled"`, [userId, principal.workspaceId, input.role ?? null, input.disabled ?? null]);
      if (input.disabled) await client.query("update auth_sessions set revoked_at=now() where user_id=$1 and revoked_at is null", [userId]);
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally { client.release(); }
  }  async listTeams(principal: AuthPrincipal) {
    const result = await this.database().query(`select t.id,t.name,t.created_at "createdAt",coalesce(jsonb_agg(jsonb_build_object('userId',u.id,'displayName',u.display_name,'email',u.email)) filter(where u.id is not null),'[]'::jsonb) members
      from teams t left join team_members tm on tm.team_id=t.id left join users u on u.id=tm.user_id
      where t.workspace_id=$1 group by t.id order by t.name`, [principal.workspaceId]);
    return result.rows;
  }
  async createTeam(principal: AuthPrincipal, name: string) {
    if (!name?.trim()) throw new DomainError(400, "Team name is required", "team_name_required");
    try { const result = await this.database().query("insert into teams(workspace_id,name) values($1,$2) returning id,name,created_at \"createdAt\"", [principal.workspaceId, name.trim()]); return { ...result.rows[0], members: [] }; }
    catch (error: any) { if (error?.code === "23505") throw new DomainError(409, "A team with this name already exists", "team_exists"); throw error; }
  }
  async setTeamMembers(principal: AuthPrincipal, teamId: string, userIds: string[]) {
    const pool = this.database();
    const client = await pool.connect();
    try {
      await client.query("begin");
      const team = await client.query("select id from teams where id=$1 and workspace_id=$2 for update", [teamId, principal.workspaceId]);
      if (!team.rowCount) throw new DomainError(404, "Team not found", "team_not_found");
      if (userIds.length) {
        const valid = await client.query("select id from users where workspace_id=$1 and id=any($2::uuid[]) and disabled_at is null", [principal.workspaceId, userIds]);
        if (valid.rowCount !== new Set(userIds).size) throw new DomainError(400, "One or more team members are invalid", "invalid_team_members");
      }
      await client.query("delete from team_members where team_id=$1", [teamId]);
      if (userIds.length) await client.query("insert into team_members(team_id,user_id) select $1,unnest($2::uuid[]) on conflict do nothing", [teamId, userIds]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    return (await this.listTeams(principal)).find((team) => team.id === teamId);
  }
  async deleteTeam(principal: AuthPrincipal, teamId: string) { const result = await this.database().query("delete from teams where id=$1 and workspace_id=$2 returning id", [teamId, principal.workspaceId]); if (!result.rowCount) throw new DomainError(404, "Team not found", "team_not_found"); return { ok: true }; }
  async listServiceTokens(principal: AuthPrincipal) {
    const result = await this.database().query("select id,name,token_prefix \"tokenPrefix\",created_at \"createdAt\",last_used_at \"lastUsedAt\",expires_at \"expiresAt\",revoked_at \"revokedAt\" from service_tokens where workspace_id=$1 order by created_at desc", [principal.workspaceId]);
    return result.rows;
  }
  async createServiceToken(principal: AuthPrincipal, input: { name: string; expiresAt?: string }) {
    if (!input.name?.trim()) throw new DomainError(400, "Token name is required", "token_name_required");
    const token = `botcrm_svc_${randomBytes(32).toString("base64url")}`;
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.valueOf())) throw new DomainError(400, "Token expiry is invalid", "token_expiry_invalid");
    const result = await this.database().query("insert into service_tokens(workspace_id,name,token_hash,token_prefix,created_by,expires_at) values($1,$2,$3,$4,$5,$6) returning id,name,token_prefix \"tokenPrefix\",created_at \"createdAt\",expires_at \"expiresAt\"", [principal.workspaceId, input.name.trim(), sha256(token), token.slice(0, 18), principal.userId, expiresAt]);
    return { ...result.rows[0], token };
  }
  async revokeServiceToken(principal: AuthPrincipal, tokenId: string) {
    const result = await this.database().query("update service_tokens set revoked_at=now() where id=$1 and workspace_id=$2 and revoked_at is null returning id", [tokenId, principal.workspaceId]);
    if (!result.rowCount) throw new DomainError(404, "Service token not found", "service_token_not_found");
    return { ok: true };
  }
  async logout(principal: AuthPrincipal) { if (principal.sessionId) await this.database().query("update auth_sessions set revoked_at=now() where id=$1 and user_id=$2", [principal.sessionId, principal.userId]); return { ok: true }; }
  async sessions(principal: AuthPrincipal) {
    const result = await this.database().query("select id,user_agent \"userAgent\",ip_address::text \"ipAddress\",created_at \"createdAt\",last_seen_at \"lastSeenAt\",expires_at \"expiresAt\",revoked_at \"revokedAt\",id=$2 \"current\" from auth_sessions where user_id=$1 order by created_at desc limit 50", [principal.userId, principal.sessionId ?? null]);
    return result.rows;
  }
  async revokeSession(principal: AuthPrincipal, sessionId: string) { const result = await this.database().query("update auth_sessions set revoked_at=now() where id=$1 and user_id=$2 and revoked_at is null returning id", [sessionId, principal.userId]); if (!result.rowCount) throw new DomainError(404, "Session not found", "session_not_found"); return { ok: true }; }
  async setupMfa(principal: AuthPrincipal) {
    const secret = generateSecret();
    const pool = this.database();
    await pool.query("delete from auth_mfa_challenges where user_id=$1 or expires_at<now()", [principal.userId]);
    await pool.query("insert into auth_mfa_challenges(user_id,encrypted_secret,expires_at) values($1,$2,now()+interval '10 minutes')", [principal.userId, this.encrypt(secret)]);
    return { secret, uri: generateURI({ issuer: "BotCRM", label: principal.email, secret }), expiresInSeconds: 600 };
  }
  async verifyMfaSetup(principal: AuthPrincipal, code: string) {
    const pool = this.database();
    const result = await pool.query("select id,encrypted_secret from auth_mfa_challenges where user_id=$1 and expires_at>now() order by created_at desc limit 1", [principal.userId]);
    if (!result.rowCount) throw new DomainError(410, "MFA setup challenge expired", "mfa_challenge_expired");
    const secret = this.decrypt(result.rows[0].encrypted_secret);
    if (!(await verifyTotp({ secret, token: code })).valid) throw new DomainError(400, "Invalid authentication code", "invalid_mfa_code");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("update users set totp_secret_encrypted=$2 where id=$1", [principal.userId, this.encrypt(secret)]);
      await client.query("delete from auth_mfa_challenges where user_id=$1", [principal.userId]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    return { enabled: true };
  }
  async disableMfa(principal: AuthPrincipal, password: string, code: string) {
    const pool = this.database();
    const result = await pool.query("select password_hash,totp_secret_encrypted from users where id=$1", [principal.userId]);
    const user = result.rows[0];
    if (!user?.totp_secret_encrypted || !user.password_hash || !(await verifyPassword(user.password_hash, password, argonOptions()))) throw new DomainError(401, "Invalid password", "invalid_credentials");
    if (!(await verifyTotp({ secret: this.decrypt(user.totp_secret_encrypted), token: code })).valid) throw new DomainError(400, "Invalid authentication code", "invalid_mfa_code");
    await pool.query("update users set totp_secret_encrypted=null where id=$1", [principal.userId]);
    return { enabled: false };
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector, @Inject(AuthService) private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined>; auth?: AuthPrincipal }>();
    const principal = await this.auth.principal(request.headers);
    if (!principal) throw new DomainError(401, "Authentication required", "authentication_required");
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_ROUTE, [context.getHandler(), context.getClass()]);
    if (roles?.length && !roles.includes(principal.role)) throw new DomainError(403, "Insufficient permissions", "forbidden");
    request.auth = principal;
    request.headers["x-workspace-id"] = principal.workspaceId;
    return true;
  }
}