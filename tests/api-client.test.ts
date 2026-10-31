import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ApiError, apiRetryAt, botcrmApi, setAuthToken, subscribeToApiRateLimit, subscribeToRealtime } from "../app/api-client.js";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { hostname: "crm.example.test" },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  } });
  setAuthToken("test-session-one");
});
afterEach(() => {
  setAuthToken(); globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
});

test("overlapping reads share a request, but different resources and mutations do not", async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  globalThis.fetch = (async () => { calls++; await new Promise<void>((resolve) => releases.push(resolve)); return Response.json([]); }) as typeof fetch;
  const first = botcrmApi.contacts(); const second = botcrmApi.contacts(); const other = botcrmApi.conversations();
  assert.equal(calls, 2);
  releases.splice(0).forEach((release) => release()); await Promise.all([first, second, other]);
  const fresh = botcrmApi.contacts(); assert.equal(calls, 3); releases.shift()!(); await fresh;
  const a = botcrmApi.markConversationRead("test-conversation"); const b = botcrmApi.markConversationRead("test-conversation");
  assert.equal(calls, 5, "mutation requests must not be merged or replayed");
  releases.splice(0).forEach((release) => release()); await Promise.all([a, b]);
});

test("Retry-After pauses JSON, thumbnails and mutations until the deadline without replaying writes", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 9, 29) });
  let calls = 0; let notices = 0;
  const unsubscribe = subscribeToApiRateLimit(() => notices++);
  globalThis.fetch = (async () => { calls++; return calls === 1 ? Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "Retry-After": "12" } }) : Response.json([]); }) as typeof fetch;
  try {
    await assert.rejects(botcrmApi.contacts(), (error: unknown) => error instanceof ApiError && error.status === 429 && error.retryAt === Date.now() + 12000);
    assert.equal(notices, 1);
    await assert.rejects(botcrmApi.conversations(), { status: 429 });
    const thumbnail = botcrmApi.contentDiskPreview("test-bot", "/library/photo.jpg");
    for (let i=0;i<8;i++) await Promise.resolve();
    await assert.rejects(botcrmApi.markConversationRead("test-conversation"), { status: 429 });
    assert.equal(calls, 1, "paused consumers must not make HTTP requests");
    context.mock.timers.tick(12000);
    await thumbnail;
    assert.equal(apiRetryAt(), 0);
    await botcrmApi.contacts(); assert.equal(calls, 3);
  } finally { unsubscribe(); }
});

test("reads from before or during a mutation cannot replace its fresh result", async () => {
  let calls = 0; const releases: Array<() => void> = [];
  globalThis.fetch = (async () => { calls++; await new Promise<void>((resolve) => releases.push(resolve)); return Response.json([]); }) as typeof fetch;
  const old = botcrmApi.contacts();
  const write = botcrmApi.markConversationRead("test-conversation");
  const during = botcrmApi.contacts();
  assert.equal(calls, 3);
  releases[1](); await write;
  const fresh = botcrmApi.contacts(); assert.equal(calls, 4);
  releases[0](); await old;
  const sharedFresh = botcrmApi.contacts(); assert.equal(calls, 4, "an old request finishing must not evict a fresh in-flight read");
  releases[2](); releases[3](); await Promise.all([during, fresh, sharedFresh]);
});

test("HTTP-date retry headers, malformed headers and login use the correct cooldown", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 29) });
  let calls = 0; let header = new Date(Date.now() + 20000).toUTCString();
  globalThis.fetch = (async (input) => { calls++; return String(input).endsWith("/auth/login") ? Response.json({ token: "test" }) : new Response(null, { status: 429, headers: { "Retry-After": header } }); }) as typeof fetch;
  await assert.rejects(botcrmApi.contacts(), { status: 429 });
  assert.equal(apiRetryAt(), Date.now() + 20000);
  await botcrmApi.login({ email: "test@example.test", password: "test-only" });
  assert.equal(calls, 2, "API cooldown must not replace the separate login limiter");
  setAuthToken("test-session-two"); assert.equal(apiRetryAt(), 0);
  header = "invalid";
  await assert.rejects(botcrmApi.contacts(), { status: 429 });
  assert.equal(apiRetryAt(), Date.now() + 5000);
});

test("failed reads are released and session changes never reuse another session's pending data", async () => {
  let calls = 0; let release: (() => void) | undefined;
  globalThis.fetch = (async () => { calls++; if (calls === 1) return new Response(null, { status: 503 }); if (calls === 2) await new Promise<void>((resolve) => { release = resolve; }); return Response.json([]); }) as typeof fetch;
  await assert.rejects(botcrmApi.contacts(), { status: 503 });
  const old = botcrmApi.contacts();
  setAuthToken("test-session-two"); await botcrmApi.contacts();
  assert.equal(calls, 3); release!(); await old;
});

test("assistant budget exhaustion neither blocks CRM reads nor repeats a paid request", async () => {
  let calls=0;
  globalThis.fetch=(async(input)=>{
    calls++;
    return String(input).endsWith('/assistant/chat')?Response.json({error:{code:'assistant_budget_exceeded',message:'Бюджет помощника исчерпан'}},{status:402}):Response.json([]);
  }) as typeof fetch;
  await assert.rejects(botcrmApi.askAssistant({requestId:'synthetic-request',message:'Помоги',section:'inbox'}),(error:unknown)=>error instanceof ApiError&&error.code==='assistant_budget_exceeded');
  assert.equal(calls,1);
  assert.equal(apiRetryAt(),0);
  await botcrmApi.contacts();
  assert.equal(calls,2);
});

test("realtime honors Retry-After instead of reconnecting every second", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 9, 29) });
  let calls = 0; const states: string[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = (async () => { calls++; return calls === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "10" } }) : new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })); }) as typeof fetch;
  const flush = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
  const stop = subscribeToRealtime(() => undefined, (state) => states.push(state));
  try {
    await flush(); assert.ok(states.includes("rate-limited"));
    context.mock.timers.tick(9999); await flush(); assert.equal(calls, 1);
    context.mock.timers.tick(1); await flush(); assert.equal(calls, 2); assert.equal(states.at(-1), "live");
  } finally { stop(); stream?.close(); await flush(); }
});
