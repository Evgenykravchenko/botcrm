import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./core.js";
import { RateLimitGuard } from "./rate-limit.js";

function context(request: Record<string, unknown>, headers: Record<string, string | number>) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: (name: string, value: string | number) => { headers[name] = value; } }),
    }),
  } as any;
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("global API rate limiter returns 429 and standard retry headers", async () => {
  const previousRedis = process.env.REDIS_URL;
  const previousMax = process.env.API_RATE_LIMIT_MAX;
  const previousWindow = process.env.API_RATE_LIMIT_WINDOW_SECONDS;
  delete process.env.REDIS_URL;
  process.env.API_RATE_LIMIT_MAX = "2";
  process.env.API_RATE_LIMIT_WINDOW_SECONDS = "60";
  const guard = new RateLimitGuard();
  const headers: Record<string, string | number> = {};
  const request = { method: "GET", url: "/api/v1/contacts", ip: "192.0.2.10" };
  try {
    await guard.onModuleInit();
    assert.equal(await guard.canActivate(context(request, headers)), true);
    assert.equal(await guard.canActivate(context(request, headers)), true);
    await assert.rejects(() => guard.canActivate(context(request, headers)), (error: unknown) => error instanceof DomainError && error.status === 429 && error.code === "rate_limited");
    assert.equal(headers["X-RateLimit-Limit"], 2);
    assert.equal(headers["X-RateLimit-Remaining"], 0);
    assert.ok(Number(headers["Retry-After"]) > 0);
  } finally {
    await guard.onModuleDestroy();
    restore("REDIS_URL", previousRedis);
    restore("API_RATE_LIMIT_MAX", previousMax);
    restore("API_RATE_LIMIT_WINDOW_SECONDS", previousWindow);
  }
});

test("login limiter follows an account across changing IP addresses", async () => {
  const previousRedis = process.env.REDIS_URL;
  const previousEmailMax = process.env.LOGIN_ROUTE_RATE_LIMIT_EMAIL_MAX;
  const previousEmailWindow = process.env.LOGIN_ROUTE_RATE_LIMIT_EMAIL_WINDOW_SECONDS;
  const previousIpMax = process.env.LOGIN_ROUTE_RATE_LIMIT_IP_MAX;
  delete process.env.REDIS_URL;
  process.env.LOGIN_ROUTE_RATE_LIMIT_EMAIL_MAX = "2";
  process.env.LOGIN_ROUTE_RATE_LIMIT_EMAIL_WINDOW_SECONDS = "900";
  process.env.LOGIN_ROUTE_RATE_LIMIT_IP_MAX = "100";
  const guard = new RateLimitGuard();
  const headers: Record<string, string | number> = {};
  try {
    await guard.onModuleInit();
    for (const ip of ["192.0.2.20", "192.0.2.21"]) {
      assert.equal(await guard.canActivate(context({ method: "POST", url: "/api/v1/auth/login", ip, body: { email: "owner@botcrm.local" } }, headers)), true);
    }
    await assert.rejects(
      () => guard.canActivate(context({ method: "POST", url: "/api/v1/auth/login", ip: "192.0.2.22", body: { email: "owner@botcrm.local" } }, headers)),
      (error: unknown) => error instanceof DomainError && error.code === "rate_limited",
    );
  } finally {
    await guard.onModuleDestroy();
    restore("REDIS_URL", previousRedis);
    restore("LOGIN_ROUTE_RATE_LIMIT_EMAIL_MAX", previousEmailMax);
    restore("LOGIN_ROUTE_RATE_LIMIT_EMAIL_WINDOW_SECONDS", previousEmailWindow);
    restore("LOGIN_ROUTE_RATE_LIMIT_IP_MAX", previousIpMax);
  }
});

test("login account buckets are isolated between workspaces", async () => {
  const previousRedis = process.env.REDIS_URL;
  const previousEmailMax = process.env.LOGIN_ROUTE_RATE_LIMIT_EMAIL_MAX;
  const previousIpMax = process.env.LOGIN_ROUTE_RATE_LIMIT_IP_MAX;
  delete process.env.REDIS_URL;
  process.env.LOGIN_ROUTE_RATE_LIMIT_EMAIL_MAX = "1";
  process.env.LOGIN_ROUTE_RATE_LIMIT_IP_MAX = "100";
  const guard = new RateLimitGuard();
  const headers: Record<string, string | number> = {};
  try {
    await guard.onModuleInit();
    assert.equal(await guard.canActivate(context({ method: "POST", url: "/api/v1/auth/login", ip: "192.0.2.30", body: { workspace: "first", email: "owner@example.test" } }, headers)), true);
    assert.equal(await guard.canActivate(context({ method: "POST", url: "/api/v1/auth/login", ip: "192.0.2.31", body: { workspace: "second", email: "owner@example.test" } }, headers)), true);
    await assert.rejects(
      () => guard.canActivate(context({ method: "POST", url: "/api/v1/auth/login", ip: "192.0.2.32", body: { workspace: "first", email: "owner@example.test" } }, headers)),
      (error: unknown) => error instanceof DomainError && error.code === "rate_limited",
    );
  } finally {
    await guard.onModuleDestroy();
    restore("REDIS_URL", previousRedis);
    restore("LOGIN_ROUTE_RATE_LIMIT_EMAIL_MAX", previousEmailMax);
    restore("LOGIN_ROUTE_RATE_LIMIT_IP_MAX", previousIpMax);
  }
});
