import { CanActivate, ExecutionContext, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { RedisConnection } from "bullmq";
import { createHash } from "node:crypto";
import { redisConnection } from "./campaign-queue.js";
import { DomainError } from "./core.js";

type RateLimitRequest = {
  method?: string;
  url?: string;
  ip?: string;
  body?: { email?: unknown; workspace?: unknown };
  raw?: { socket?: { remoteAddress?: string } };
};

type RateLimitResponse = { header(name: string, value: string | number): void };
type Bucket = { scope: string; identity: string; max: number; windowSeconds: number };
type Counter = { count: number; resetAt: number };

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleInit, OnModuleDestroy {
  private redis?: RedisConnection;
  private readonly memory = new Map<string, Counter>();
  private lastMemorySweep = 0;

  async onModuleInit() {
    if (!process.env.REDIS_URL || process.env.RATE_LIMIT_REDIS === "false") return;
    const connection = new RedisConnection(redisConnection(process.env.REDIS_URL), { blocking: false, skipVersionCheck: true });
    try {
      await connection.client;
      this.redis = connection;
      console.log("BotCRM rate limit: Redis-backed");
    } catch (error) {
      await connection.close(true).catch(() => undefined);
      console.warn("BotCRM rate limit: Redis unavailable, using per-process fallback", error instanceof Error ? error.message : String(error));
    }
  }

  async onModuleDestroy() {
    await this.redis?.close(true).catch(() => undefined);
  }

  private memoryConsume(key: string, max: number, windowSeconds: number) {
    const now = Date.now();
    if (now - this.lastMemorySweep > 60_000) {
      this.lastMemorySweep = now;
      for (const [candidate, counter] of this.memory) if (counter.resetAt <= now) this.memory.delete(candidate);
    }
    const current = this.memory.get(key);
    const counter = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowSeconds * 1_000 } : current;
    counter.count += 1;
    this.memory.set(key, counter);
    return { count: counter.count, retryAfter: Math.max(1, Math.ceil((counter.resetAt - now) / 1_000)), max };
  }

  private async consume(bucket: Bucket) {
    const key = `botcrm:rate:${bucket.scope}:${digest(bucket.identity)}`;
    if (this.redis) {
      try {
        const client = await this.redis.client as any;
        const result = await client.eval(
          "local current=redis.call('INCR',KEYS[1]); if current==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]); end; return {current,redis.call('TTL',KEYS[1])}",
          1,
          key,
          bucket.windowSeconds,
        ) as [number | string, number | string];
        return { count: Number(result[0]), retryAfter: Math.max(1, Number(result[1])), max: bucket.max };
      } catch {
        // The database-backed login limiter remains active; use a local fallback for all routes until Redis recovers.
      }
    }
    return this.memoryConsume(key, bucket.max, bucket.windowSeconds);
  }

  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const request = http.getRequest<RateLimitRequest>();
    const response = http.getResponse<RateLimitResponse>();
    if (request.method === "OPTIONS") return true;

    const path = String(request.url ?? "").split("?", 1)[0];
    const ip = request.ip || request.raw?.socket?.remoteAddress || "unknown";
    const buckets: Bucket[] = [];

    if (path.endsWith("/auth/login")) {
      buckets.push({ scope: "login-ip", identity: ip, max: positiveInteger(process.env.LOGIN_ROUTE_RATE_LIMIT_IP_MAX, 20), windowSeconds: positiveInteger(process.env.LOGIN_ROUTE_RATE_LIMIT_IP_WINDOW_SECONDS, 60) });
      const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
      const workspace = typeof request.body?.workspace === "string" ? request.body.workspace.trim().toLowerCase() : "ws_demo";
      if (email) buckets.push({ scope: "login-account", identity: `${workspace}:${email}`, max: positiveInteger(process.env.LOGIN_ROUTE_RATE_LIMIT_EMAIL_MAX, 10), windowSeconds: positiveInteger(process.env.LOGIN_ROUTE_RATE_LIMIT_EMAIL_WINDOW_SECONDS, 900) });
    } else if (path.includes("/webhooks/")) {
      buckets.push({ scope: "webhook", identity: `${ip}:${path}`, max: positiveInteger(process.env.WEBHOOK_RATE_LIMIT_MAX, 3000), windowSeconds: positiveInteger(process.env.WEBHOOK_RATE_LIMIT_WINDOW_SECONDS, 60) });
    } else {
      buckets.push({ scope: "api", identity: ip, max: positiveInteger(process.env.API_RATE_LIMIT_MAX, 300), windowSeconds: positiveInteger(process.env.API_RATE_LIMIT_WINDOW_SECONDS, 60) });
    }

    let remaining = Number.POSITIVE_INFINITY;
    let reset = 1;
    let limit = Number.POSITIVE_INFINITY;
    for (const bucket of buckets) {
      const result = await this.consume(bucket);
      remaining = Math.min(remaining, Math.max(0, result.max - result.count));
      limit = Math.min(limit, result.max);
      reset = Math.max(reset, result.retryAfter);
      if (result.count > result.max) {
        response.header("Retry-After", result.retryAfter);
        response.header("X-RateLimit-Limit", result.max);
        response.header("X-RateLimit-Remaining", 0);
        response.header("X-RateLimit-Reset", result.retryAfter);
        throw new DomainError(429, "Too many requests. Try again later", "rate_limited");
      }
    }
    response.header("X-RateLimit-Limit", Number.isFinite(limit) ? limit : 0);
    response.header("X-RateLimit-Remaining", Number.isFinite(remaining) ? remaining : 0);
    response.header("X-RateLimit-Reset", reset);
    return true;
  }
}
