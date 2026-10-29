import assert from "node:assert/strict";
import test from "node:test";
import { ContentPlatformService, validateContentMediaInput, validateKeywordReplyInput } from "./content-platform.js";
import { RealtimeService } from "./realtime.js";
import { ContentMediaProgressService, validateMediaProgress } from "./content-media-progress.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresStore } from "./postgres-store.js";
import { filter, firstValueFrom, timeout } from "rxjs";

test("repeated and concurrent legacy syncs do not rewrite profiles or emit bot changes", { skip: !process.env.DATABASE_URL }, async () => {
  const databaseUrl = process.env.DATABASE_URL!;
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresStore(databaseUrl);
  const workspace = randomUUID();
  const listener = await pool.connect();
  const events: Array<{ workspaceId?: string; entity?: string; marker?: string }> = [];
  listener.on("notification", (message) => { if (message.payload) events.push(JSON.parse(message.payload)); });
  const barrier = async () => {
    const marker = randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    const arrived = new Promise<void>((resolve, reject) => {
      const receive = (message: { payload?: string }) => {
        if (message.payload === JSON.stringify({ marker })) { clearTimeout(timer); listener.off("notification", receive); resolve(); }
      };
      listener.on("notification", receive);
      timer = setTimeout(() => { listener.off("notification", receive); reject(new Error("Notification barrier timed out")); }, 3000);
    });
    await pool.query("select pg_notify('botcrm_realtime',$1)", [JSON.stringify({ marker })]);
    await arrived;
  };
  const state = async () => (await pool.query("select b.id,b.name,b.xmin::text bot_revision,p.xmin::text profile_revision,p.yandex_root from bots b join bot_content_profiles p on p.bot_id=b.id where b.workspace_id=$1", [workspace])).rows[0];
  const binding = { botSlug: "library_bot", contentBotKey: `library-${workspace}`, channel: "vk", yandexRoot: "/bot_crm/library_bot" };
  try {
    await pool.query("insert into workspaces(id,name) values($1,'Legacy sync regression')", [workspace]);
    await listener.query("listen botcrm_realtime");
    await store.syncContentProfiles(workspace, [binding]);
    await barrier();
    const before = await state();
    events.length = 0;
    const profiles = await Promise.all(Array.from({ length: 6 }, () => store.syncContentProfiles(workspace, [binding])));
    await barrier();
    assert.ok(profiles.every((items) => items.length === 1 && items[0].botId === before.id));
    assert.deepEqual(await state(), before, "unchanged profiles must retain their PostgreSQL row versions");
    assert.equal(events.filter((event) => event.workspaceId === workspace).length, 0, "reads must not trigger workspace reloads");
    await store.syncContentProfiles(workspace, [{ ...binding, label: "Updated library" }]);
    await barrier();
    assert.equal((await state()).name, "Updated library");
    assert.equal(events.filter((event) => event.workspaceId === workspace && event.entity === "bots").length, 1, "a real name change still reaches realtime");
    events.length = 0;
    await store.syncContentProfiles(workspace, [{ ...binding, label: "Another legacy name", yandexRoot: "/bot_crm/new_root" }]);
    await barrier();
    const changed = await state();
    assert.equal(changed.name, "Updated library", "legacy sync must preserve the editor's existing name");
    assert.equal(changed.yandex_root, "/bot_crm/new_root");
    assert.equal(events.filter((event) => event.workspaceId === workspace && event.entity === "bots").length, 0);
  } finally {
    await listener.query("unlisten botcrm_realtime"); listener.release();
    await store.close();
    await pool.query("delete from workspaces where id=$1", [workspace]);
    await pool.end();
  }
});

test("media progress validates estimates and ignores unknown properties", () => {
  const value = { attemptId: randomUUID(), stage: "transferring", transferredBytes: 40, totalBytes: 100, bytesPerSecond: 10, etaSeconds: 6 };
  assert.deepEqual(validateMediaProgress({ ...value, signedUrl: "not-persisted" }), value);
  for (const patch of [{ transferredBytes: 101 }, { bytesPerSecond: Infinity }, { etaSeconds: -1 }, { stage: "finalizing" }, { attemptId: "not-an-attempt" }, { totalBytes: 0 }, { bytesPerSecond: null }]) assert.throws(() => validateMediaProgress({ ...value, ...patch }));
});

test("progress survives API instances but not another workspace, attempt, source or completed job", { skip: !process.env.DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const workspaces = [randomUUID(), randomUUID()];
  const first = new ContentMediaProgressService();
  const second = new ContentMediaProgressService();
  try {
    for (const workspace of workspaces) {
      await pool.query("insert into workspaces(id,name) values($1,'Progress test')", [workspace]);
      await pool.query("insert into bots(workspace_id,slug,name,integration_mode) values($1,'progress_bot','Progress test','MIRROR')", [workspace]);
    }
    await first.onModuleInit(); await second.onModuleInit();
    const progress = validateMediaProgress({ attemptId: randomUUID(), stage: "connecting", transferredBytes: 0, totalBytes: 1000, bytesPerSecond: null, etaSeconds: null });
    await first.begin(workspaces[0], "progress_bot", 7, "/library/video.mov", progress);
    assert.equal((await second.list(workspaces[0], "progress_bot")).get(7)?.attemptId, progress.attemptId);
    assert.equal((await second.list(workspaces[1], "progress_bot")).size, 0);
    const update = { ...progress, stage: "transferring" as const, transferredBytes: 600, bytesPerSecond: 100, etaSeconds: 4 };
    assert.equal(await second.update(workspaces[1], "progress_bot", 7, "/library/video.mov", update), false);
    assert.equal(await second.update(workspaces[0], "progress_bot", 7, "/wrong.mov", update), false);
    assert.equal(await second.update(workspaces[0], "progress_bot", 7, "/library/video.mov", { ...update, attemptId: randomUUID() }), false);
    assert.equal(await second.update(workspaces[0], "progress_bot", 7, "/library/video.mov", update), true);
    assert.equal(await second.update(workspaces[0], "progress_bot", 7, "/library/video.mov", { ...update, transferredBytes: 300 }), false);
    await first.clear(workspaces[0], "progress_bot", 7);
    assert.equal(await second.update(workspaces[0], "progress_bot", 7, "/library/video.mov", update), false, "late telemetry cannot recreate a completed job");
    assert.equal((await second.list(workspaces[0], "progress_bot")).size, 0);
  } finally {
    await Promise.all([first.onModuleDestroy(), second.onModuleDestroy()]);
    await pool.query("delete from workspaces where id=any($1::uuid[])", [workspaces]);
    await pool.end();
  }
});

test("playback URLs are restricted to the authenticated bot folder and video sources", async () => {
  const keys = ["CONTENT_PLATFORM_URL", "CONTENT_PLATFORM_TOKEN", "CONTENT_PLATFORM_YANDEX_TOKEN", "CONTENT_PLATFORM_BINDINGS"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "test-content-token";
  process.env.CONTENT_PLATFORM_YANDEX_TOKEN = "test-disk-token";
  process.env.CONTENT_PLATFORM_BINDINGS = JSON.stringify([{ workspaceId: "ws_test", botSlug: "video_bot", contentBotKey: "video-bot", yandexRoot: "/library" }]);
  let mime = "video/quicktime";
  let host = "https://downloader.disk.yandex.ru/video?signature=test-only";
  globalThis.fetch = (async (input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "OAuth test-disk-token");
    return Response.json(String(input).includes("resources/download?") ? { href: host } : { type: "file", mime_type: mime });
  }) as typeof fetch;
  try {
    const service = new ContentPlatformService();
    assert.deepEqual(await service.yandexVideoPlayback("ws_test", "video_bot", "/library/video.mov"), { url: host });
    await assert.rejects(() => service.yandexVideoPlayback("ws_other", "video_bot", "/library/video.mov"));
    await assert.rejects(() => service.yandexVideoPlayback("ws_test", "video_bot", "/private/video.mov"), /outside/);
    mime = "text/html";
    await assert.rejects(() => service.yandexVideoPlayback("ws_test", "video_bot", "/library/video.mov"), /not a video/);
    mime = "video/mp4"; host = "http://127.0.0.1/private";
    await assert.rejects(() => service.yandexVideoPlayback("ws_test", "video_bot", "/library/video.mov"), /host/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

test("media readiness respects Telegram file IDs and Instagram delivery expiry", async () => {
  const keys = ["CONTENT_PLATFORM_URL", "CONTENT_PLATFORM_TOKEN", "CONTENT_PLATFORM_BINDINGS"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "test-content-token";
  const media = { id: 7, status: "ready", telegram_file_id: "" };
  let expiresAt = "2000-01-01T00:00:00Z";
  globalThis.fetch = (async (input) => {
    const collection = new URL(String(input)).pathname.split("/")[2];
    return Response.json({ data: collection === "content_bots" ? [{ id: 1 }]
      : collection === "media_assets" ? [media]
        : collection === "media_deliveries" ? [{ id: 2, media: 7, status: "ready", external_reference: "test-instagram-reference", expires_at: expiresAt }] : [] });
  }) as typeof fetch;
  try {
    for (const channel of ["telegram", "instagram"]) {
      process.env.CONTENT_PLATFORM_BINDINGS = JSON.stringify([{ workspaceId: "ws_test", botSlug: "video_bot", contentBotKey: "video-bot", channel }]);
      const service = new ContentPlatformService();
      assert.equal((await service.listMedia("ws_test", "video_bot"))[0].canAttach, false);
      if (channel === "telegram") media.telegram_file_id = "test-telegram-file";
      else expiresAt = "2099-01-01T00:00:00Z";
      assert.equal((await service.listMedia("ws_test", "video_bot"))[0].canAttach, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

test("media changes reach another API instance through PostgreSQL", { skip: !process.env.DATABASE_URL }, async () => {
  const publisher = new RealtimeService();
  const subscriber = new RealtimeService();
  try {
    await publisher.onModuleInit();
    await subscriber.onModuleInit();
    const change = firstValueFrom(subscriber.stream("ws_media_test").pipe(filter((event) => event.type === "change"), timeout(3_000)));
    await publisher.notifyContentMedia("ws_media_test", "video_bot");
    assert.equal(((await change).data as { entityId: string }).entityId, "video_bot");
  } finally { await Promise.all([publisher.onModuleDestroy(), subscriber.onModuleDestroy()]); }
});

test("unprepared media cannot be attached through create or update, including a forged ready status", async () => {
  const envKeys = ["CONTENT_PLATFORM_URL", "CONTENT_PLATFORM_TOKEN", "CONTENT_PLATFORM_BINDINGS"] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "test-content-token";
  process.env.CONTENT_PLATFORM_BINDINGS = JSON.stringify([{ workspaceId: "ws_test", botSlug: "video_bot", contentBotKey: "video-bot", channel: "vk" }]);
  const media: Record<string, unknown> = { id: 7, bot: 1, name: "video.mov", kind: "video", yandex_path: "/Bot/video.mov", status: "queued" };
  let writes = 0;
  const events: Array<[string, string]> = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const collection = url.pathname.split("/")[2];
    if (init?.method && init.method !== "GET") {
      writes++;
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (collection === "media_assets") Object.assign(media, body);
      return Response.json({ data: { id: collection === "responses" ? 3 : 9, ...body } });
    }
    return Response.json({ data: collection === "content_bots" ? [{ id: 1 }]
      : collection === "media_assets" ? [media]
        : collection === "keywords" ? [{ id: 2, bot: 1, phrase: "video", response: 3 }]
          : collection === "responses" ? [{ id: 3, bot: 1, name: "Video", status: "published" }]
            : [] });
  }) as typeof fetch;
  try {
    const service = new ContentPlatformService({ notifyContentMedia: async (workspace, slug) => { events.push([workspace, slug]); } });
    const reply = { phrase: "video", response: { name: "Video", status: "published" as const, blocks: [{ kind: "video" as const, mediaId: 7 }] } };
    for (const status of ["draft", "queued", "processing", "error", "ready"]) {
      media.status = status;
      assert.equal((await service.listMedia("ws_test", "video_bot"))[0].canAttach, false);
      for (const save of [() => service.createRule("ws_test", "video_bot", reply), () => service.updateRule("ws_test", "video_bot", 2, reply)]) {
        await assert.rejects(save, (error: unknown) => error instanceof Error && "code" in error && error.code === "content_media_not_ready");
      }
    }
    assert.equal(writes, 0, "reject before mutating any response or keyword");
    await assert.rejects(() => service.createRule("ws_test", "video_bot", { ...reply, response: { ...reply.response, blocks: [{ kind: "video", mediaId: 999 }] } }), (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_response_media");
    await service.runtimeUpdateMedia("ws_test", "video_bot", 7, { status: "ready", vk_attachment: "video1_2", error_message: null });
    assert.deepEqual(events, [["ws_test", "video_bot"]]);
    assert.equal((await service.listMedia("ws_test", "video_bot"))[0].canAttach, true);
    await service.createRule("ws_test", "video_bot", reply);
    await service.updateRule("ws_test", "video_bot", 2, reply);
    await service.updateMedia("ws_test", "video_bot", 7, { name: "new.mov", kind: "video", yandexPath: "/Bot/new.mov", status: "ready" });
    assert.equal(media.status, "queued");
    assert.equal(media.vk_attachment, null);
    assert.equal((await service.listMedia("ws_test", "video_bot"))[0].canAttach, false, "a replacement file must be prepared again");
    const unavailableRealtime = new ContentPlatformService({ notifyContentMedia: async () => { throw new Error("offline"); } });
    await unavailableRealtime.runtimeUpdateMedia("ws_test", "video_bot", 7, { status: "processing" });
    assert.equal(media.status, "processing", "notification failure must not fail a worker's completed write");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

test("media live events contain no file data and stay inside their workspace", async () => {
  const service = new RealtimeService();
  const first: unknown[] = [];
  const other: unknown[] = [];
  const subscriptions = [service.stream("ws_first").subscribe((event) => { if (event.type === "change") first.push(event.data); }), service.stream("ws_other").subscribe((event) => { if (event.type === "change") other.push(event.data); })];
  try {
    await service.notifyContentMedia("ws_first", "video_bot");
    assert.equal(first.length, 1);
    assert.equal(other.length, 0);
    assert.deepEqual(Object.keys(first[0] as object).sort(), ["type", "workspaceId", "entity", "entityId", "operation", "occurredAt"].sort());
    assert.equal((first[0] as { entity: string }).entity, "content_media");
  } finally { subscriptions.forEach((subscription) => subscription.unsubscribe()); }
});

test("keyword replies normalize editor input and reject unsafe buttons", () => {
  const result = validateKeywordReplyInput({
    phrase: "  прайс  ",
    matchMode: "exact",
    priority: 250,
    response: {
      name: "  Прайс  ",
      status: "published",
      blocks: [{ kind: "text", body: "  Готово  " }],
      buttons: [{ label: "Открыть", action: "open_link", target: "https://example.com", row: 2 }],
    },
  });
  assert.equal(result.phrase, "прайс");
  assert.equal(result.response.name, "Прайс");
  assert.equal(result.response.blocks[0].body, "Готово");
  assert.equal(result.response.buttons[0].row, 2);
  assert.throws(() => validateKeywordReplyInput({ phrase: "сайт", response: { name: "Сайт", fallbackText: "Ссылка", buttons: [{ label: "Открыть", action: "open_link", target: "javascript:alert(1)" }] } }), /HTTP or HTTPS/);
});

test("media entries require an absolute safe Yandex Disk path", () => {
  assert.deepEqual(validateContentMediaInput({ name: "Фото", kind: "photo", yandexPath: "/Bot/photos/test.jpg", status: "queued" }), { name: "Фото", kind: "photo", yandexPath: "/Bot/photos/test.jpg", status: "queued" });
  assert.throws(() => validateContentMediaInput({ name: "Фото", kind: "photo", yandexPath: "../test.jpg" }), /absolute/);
});

test("a keyword response accepts no more than ten media files", () => {
  const mediaBlocks = Array.from({ length: 11 }, (_, index) => ({ kind: "photo" as const, mediaId: index + 1, enabled: true }));
  assert.throws(() => validateKeywordReplyInput({ phrase: "галерея", response: { name: "Галерея", blocks: mediaBlocks } }), /at most 10 media files/);
});

test("Yandex Disk browser stays inside the bot folder and returns safe file metadata", async () => {
  const previous = { url: process.env.CONTENT_PLATFORM_URL, token: process.env.CONTENT_PLATFORM_TOKEN, yandex: process.env.CONTENT_PLATFORM_YANDEX_TOKEN, bindings: process.env.CONTENT_PLATFORM_BINDINGS, fetch: globalThis.fetch };
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "server-secret";
  process.env.CONTENT_PLATFORM_YANDEX_TOKEN = "disk-secret";
  process.env.CONTENT_PLATFORM_BINDINGS = JSON.stringify([{ workspaceId: "ws_demo", botSlug: "vk_test_bot", contentBotKey: "vk-content-bot", yandexRoot: "/VK Content Bot" }]);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("path"), "/VK Content Bot/photos");
    assert.equal(new Headers(init?.headers).get("authorization"), "OAuth disk-secret");
    return new Response(JSON.stringify({ _embedded: { items: [{ name: "test.jpg", path: `disk:${"/".repeat(5_000)}VK Content Bot/photos/test.jpg///`, type: "file", mime_type: "image/jpeg", size: 2048, preview: "https://preview.example/test.jpg" }] } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const service = new ContentPlatformService();
    const listing = await service.listYandexFiles("ws_demo", "vk_test_bot", "/VK Content Bot/photos");
    assert.equal(listing.items[0].kind, "photo");
    assert.equal(listing.items[0].path, "/VK Content Bot/photos/test.jpg");
    await assert.rejects(() => service.listYandexFiles("ws_demo", "vk_test_bot", "/Other Bot"), /outside the bot library/);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.CONTENT_PLATFORM_URL; else process.env.CONTENT_PLATFORM_URL = previous.url;
    if (previous.token === undefined) delete process.env.CONTENT_PLATFORM_TOKEN; else process.env.CONTENT_PLATFORM_TOKEN = previous.token;
    if (previous.yandex === undefined) delete process.env.CONTENT_PLATFORM_YANDEX_TOKEN; else process.env.CONTENT_PLATFORM_YANDEX_TOKEN = previous.yandex;
    if (previous.bindings === undefined) delete process.env.CONTENT_PLATFORM_BINDINGS; else process.env.CONTENT_PLATFORM_BINDINGS = previous.bindings;
  }
});

test("Yandex Disk previews are proxied without exposing the OAuth token", async () => {
  const previous = { url: process.env.CONTENT_PLATFORM_URL, token: process.env.CONTENT_PLATFORM_TOKEN, yandex: process.env.CONTENT_PLATFORM_YANDEX_TOKEN, bindings: process.env.CONTENT_PLATFORM_BINDINGS, fetch: globalThis.fetch };
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "server-secret";
  process.env.CONTENT_PLATFORM_YANDEX_TOKEN = "disk-secret";
  process.env.CONTENT_PLATFORM_BINDINGS = JSON.stringify([{ workspaceId: "ws_demo", botSlug: "vk_test_bot", contentBotKey: "vk-content-bot", yandexRoot: "/VK Content Bot" }]);
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(new Headers(init?.headers).get("authorization"), "OAuth disk-secret");
    if (calls === 1) return new Response(JSON.stringify({ type: "file", preview: "https://preview.example/file.jpg" }), { status: 200, headers: { "content-type": "application/json" } });
    assert.equal(String(input), "https://preview.example/file.jpg");
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  try {
    const service = new ContentPlatformService();
    const preview = await service.yandexFilePreview("ws_demo", "vk_test_bot", "/VK Content Bot/test.jpg");
    assert.equal(preview.contentType, "image/jpeg");
    assert.equal(preview.body.byteLength, 3);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.CONTENT_PLATFORM_URL; else process.env.CONTENT_PLATFORM_URL = previous.url;
    if (previous.token === undefined) delete process.env.CONTENT_PLATFORM_TOKEN; else process.env.CONTENT_PLATFORM_TOKEN = previous.token;
    if (previous.yandex === undefined) delete process.env.CONTENT_PLATFORM_YANDEX_TOKEN; else process.env.CONTENT_PLATFORM_YANDEX_TOKEN = previous.yandex;
    if (previous.bindings === undefined) delete process.env.CONTENT_PLATFORM_BINDINGS; else process.env.CONTENT_PLATFORM_BINDINGS = previous.bindings;
  }
});

test("workspace bindings never expose another workspace content bot", async () => {
  const previous = { url: process.env.CONTENT_PLATFORM_URL, token: process.env.CONTENT_PLATFORM_TOKEN, bindings: process.env.CONTENT_PLATFORM_BINDINGS, fetch: globalThis.fetch };
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "server-secret";
  process.env.CONTENT_PLATFORM_BINDINGS = JSON.stringify([
    { workspaceId: "ws_demo", botSlug: "vk_test_bot", contentBotKey: "vk-content-bot", channel: "vk" },
    { workspaceId: "ws_other", botSlug: "private_bot", contentBotKey: "private-content", channel: "telegram" },
  ]);
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const key = new URL(url).searchParams.get("filter[key][_eq]");
    return new Response(JSON.stringify({ data: key === "vk-content-bot" ? [{ id: 1, key, name: "VK Content", platform: "vk", status: "active" }] : [{ id: 2, key, name: "Private", platform: "telegram", status: "active" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const service = new ContentPlatformService();
    const bots = await service.listBots("ws_demo");
    assert.deepEqual(bots.map((bot) => bot.botSlug), ["vk_test_bot"]);
    assert.equal(requested.length, 1);
    assert.match(requested[0], /vk-content-bot/);
    await assert.rejects(() => service.listRules("ws_demo", "private_bot"), /not available/);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.CONTENT_PLATFORM_URL; else process.env.CONTENT_PLATFORM_URL = previous.url;
    if (previous.token === undefined) delete process.env.CONTENT_PLATFORM_TOKEN; else process.env.CONTENT_PLATFORM_TOKEN = previous.token;
    if (previous.bindings === undefined) delete process.env.CONTENT_PLATFORM_BINDINGS; else process.env.CONTENT_PLATFORM_BINDINGS = previous.bindings;
  }
});

test("content bot provisioning creates its Yandex Disk folder once", async () => {
  const previous = { url: process.env.CONTENT_PLATFORM_URL, token: process.env.CONTENT_PLATFORM_TOKEN, yandex: process.env.CONTENT_PLATFORM_YANDEX_TOKEN, bindings: process.env.CONTENT_PLATFORM_BINDINGS, fetch: globalThis.fetch };
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "server-secret";
  process.env.CONTENT_PLATFORM_YANDEX_TOKEN = "disk-secret";
  delete process.env.CONTENT_PLATFORM_BINDINGS;
  const createdPaths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "content.internal") return new Response(JSON.stringify({ data: [{ id: 1, key: "new-content", name: "New Bot" }] }), { status: 200, headers: { "content-type": "application/json" } });
    assert.equal(new Headers(init?.headers).get("authorization"), "OAuth disk-secret");
    if (init?.method !== "PUT") return new Response(JSON.stringify({ error: "DiskNotFoundError" }), { status: 404, headers: { "content-type": "application/json" } });
    createdPaths.push(String(url.searchParams.get("path")));
    return new Response(JSON.stringify({ href: "https://cloud-api.yandex.net/operation/1" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const service = new ContentPlatformService();
    const binding = { workspaceId: "ws_demo", botSlug: "new_bot", contentBotKey: "new-content", channel: "vk" as const, yandexRoot: "/bot_crm/new_bot" };
    await service.ensureContentBot(binding);
    await service.ensureContentBot(binding);
    assert.deepEqual(createdPaths, ["/bot_crm", "/bot_crm/new_bot"]);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.CONTENT_PLATFORM_URL; else process.env.CONTENT_PLATFORM_URL = previous.url;
    if (previous.token === undefined) delete process.env.CONTENT_PLATFORM_TOKEN; else process.env.CONTENT_PLATFORM_TOKEN = previous.token;
    if (previous.yandex === undefined) delete process.env.CONTENT_PLATFORM_YANDEX_TOKEN; else process.env.CONTENT_PLATFORM_YANDEX_TOKEN = previous.yandex;
    if (previous.bindings === undefined) delete process.env.CONTENT_PLATFORM_BINDINGS; else process.env.CONTENT_PLATFORM_BINDINGS = previous.bindings;
  }
});

test("app-folder tokens provision descendants without reading protected parent folders", async () => {
  const env = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "server-secret";
  process.env.CONTENT_PLATFORM_YANDEX_TOKEN = "app-folder-token";
  process.env.CONTENT_PLATFORM_YANDEX_APP_FOLDER_ONLY = "true";
  delete process.env.CONTENT_PLATFORM_BINDINGS;
  const appRoot = "/Apps/My CRM";
  const paths: string[] = [];
  let rootLookups = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "content.internal") return Response.json({ data: [{ id: 1, key: "new-content" }] });
    const path = url.searchParams.get("path")!;
    if (path === "app:/") { rootLookups++; return Response.json({ path: `disk:${appRoot}`, type: "dir" }); }
    assert.ok(path.startsWith(`${appRoot}/`), `unexpected access outside app folder: ${path}`);
    if (init?.method === "PUT") { paths.push(path); return new Response(null, { status: 201 }); }
    if (url.searchParams.has("preview_size")) return Response.json({ _embedded: { items: [{ path: `disk:${appRoot}/new_bot/picture.jpg`, name: "picture.jpg", type: "file", mime_type: "image/jpeg" }] } });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const service = new ContentPlatformService();
    const binding = { workspaceId: "ws_demo", botSlug: "new_bot", contentBotKey: "new-content", yandexRoot: `${appRoot}/new_bot/photos` };
    await service.ensureContentBot(binding);
    await service.ensureContentBot(binding);
    assert.deepEqual(paths, [`${appRoot}/new_bot`, `${appRoot}/new_bot/photos`]);
    service.registerBinding({ ...binding, yandexRoot: `${appRoot}/new_bot` });
    const listing = await service.listYandexFiles("ws_demo", "new_bot");
    assert.equal(listing.items[0].path, `${appRoot}/new_bot/picture.jpg`);
    assert.equal(rootLookups, 1);
    service.registerBinding({ ...binding, yandexRoot: `${appRoot}-other/new_bot` });
    await assert.rejects(service.listYandexFiles("ws_demo", "new_bot"), { code: "yandex_disk_app_folder_required" });
    await assert.rejects(service.yandexFilePreview("ws_demo", "new_bot", `${appRoot}-other/new_bot/a.jpg`), { code: "yandex_disk_app_folder_required" });
    await assert.rejects(service.ensureContentBot({ ...binding, yandexRoot: "/Personal" }), { code: "yandex_disk_app_folder_required" });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["CONTENT_PLATFORM_URL", "CONTENT_PLATFORM_TOKEN", "CONTENT_PLATFORM_YANDEX_TOKEN", "CONTENT_PLATFORM_YANDEX_APP_FOLDER_ONLY", "CONTENT_PLATFORM_BINDINGS"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  }
});

test("application-folder lookup recovers after an upstream error", async () => {
  const env = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "server-secret";
  process.env.CONTENT_PLATFORM_YANDEX_TOKEN = "app-folder-token";
  process.env.CONTENT_PLATFORM_YANDEX_APP_FOLDER_ONLY = "true";
  delete process.env.CONTENT_PLATFORM_BINDINGS;
  let attempts = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "content.internal") return Response.json({ data: [{ id: 1 }] });
    assert.equal(url.searchParams.get("path"), "app:/");
    if (++attempts === 1) return new Response(null, { status: 503 });
    return Response.json({ path: "disk:/Приложения/bot_crm", type: "dir" });
  }) as typeof fetch;
  try {
    const service = new ContentPlatformService();
    const binding = { workspaceId: "ws_demo", botSlug: "new_bot", contentBotKey: "new-content", yandexRoot: "/Приложения/bot_crm" };
    await assert.rejects(service.ensureContentBot(binding), { code: "yandex_disk_app_folder_unavailable" });
    await service.ensureContentBot(binding);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["CONTENT_PLATFORM_URL", "CONTENT_PLATFORM_TOKEN", "CONTENT_PLATFORM_YANDEX_TOKEN", "CONTENT_PLATFORM_YANDEX_APP_FOLDER_ONLY", "CONTENT_PLATFORM_BINDINGS"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  }
});

test("content bot provisioning accepts an existing folder without write access", async () => {
  const previous = { url: process.env.CONTENT_PLATFORM_URL, token: process.env.CONTENT_PLATFORM_TOKEN, yandex: process.env.CONTENT_PLATFORM_YANDEX_TOKEN, bindings: process.env.CONTENT_PLATFORM_BINDINGS, fetch: globalThis.fetch };
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "server-secret";
  process.env.CONTENT_PLATFORM_YANDEX_TOKEN = "read-only-disk-secret";
  delete process.env.CONTENT_PLATFORM_BINDINGS;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "content.internal") return new Response(JSON.stringify({ data: [{ id: 1, key: "legacy-content", name: "Legacy Bot" }] }), { status: 200, headers: { "content-type": "application/json" } });
    assert.notEqual(init?.method, "PUT");
    return new Response(JSON.stringify({ type: "dir" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const service = new ContentPlatformService();
    await service.ensureContentBot({ workspaceId: "ws_demo", botSlug: "legacy_bot", contentBotKey: "legacy-content", channel: "vk", yandexRoot: "/Legacy Bot" });
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.CONTENT_PLATFORM_URL; else process.env.CONTENT_PLATFORM_URL = previous.url;
    if (previous.token === undefined) delete process.env.CONTENT_PLATFORM_TOKEN; else process.env.CONTENT_PLATFORM_TOKEN = previous.token;
    if (previous.yandex === undefined) delete process.env.CONTENT_PLATFORM_YANDEX_TOKEN; else process.env.CONTENT_PLATFORM_YANDEX_TOKEN = previous.yandex;
    if (previous.bindings === undefined) delete process.env.CONTENT_PLATFORM_BINDINGS; else process.env.CONTENT_PLATFORM_BINDINGS = previous.bindings;
  }
});

test("media library reuses a Yandex file and protects media used by a reply", async () => {
  const previous = { url: process.env.CONTENT_PLATFORM_URL, token: process.env.CONTENT_PLATFORM_TOKEN, bindings: process.env.CONTENT_PLATFORM_BINDINGS, fetch: globalThis.fetch };
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "server-secret";
  process.env.CONTENT_PLATFORM_BINDINGS = JSON.stringify([{ workspaceId: "ws_demo", botSlug: "vk_test_bot", contentBotKey: "vk-content-bot" }]);
  const media = [{ id: 7, bot: 1, name: "test.jpg", kind: "photo", yandex_path: "/VK Content Bot/test.jpg", status: "ready" }];
  let blocks: Array<Record<string, unknown>> = [{ id: 9, response: 3, media: 7 }];
  const deleted: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const collection = url.pathname.split("/")[2];
    if (init?.method === "POST") throw new Error("A duplicate media record must not be created");
    if (init?.method === "DELETE") {
      deleted.push(Number(url.pathname.split("/").pop()));
      return new Response(null, { status: 204 });
    }
    const data = collection === "content_bots" ? [{ id: 1, key: "vk-content-bot", name: "VK Content" }]
      : collection === "media_assets" ? media
        : collection === "response_blocks" ? blocks
          : collection === "responses" ? [{ id: 3, bot: 1, name: "Reply" }]
            : [];
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const service = new ContentPlatformService();
    const reused = await service.createMedia("ws_demo", "vk_test_bot", { name: "Another name", kind: "photo", yandexPath: "/VK Content Bot/test.jpg", status: "queued" });
    assert.equal(reused?.id, 7);
    await assert.rejects(() => service.deleteMedia("ws_demo", "vk_test_bot", 7), (error: unknown) => error instanceof Error && "code" in error && error.code === "content_media_in_use");
    blocks = [];
    assert.deepEqual(await service.deleteMedia("ws_demo", "vk_test_bot", 7), { ok: true });
    assert.deepEqual(deleted, [7]);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.CONTENT_PLATFORM_URL; else process.env.CONTENT_PLATFORM_URL = previous.url;
    if (previous.token === undefined) delete process.env.CONTENT_PLATFORM_TOKEN; else process.env.CONTENT_PLATFORM_TOKEN = previous.token;
    if (previous.bindings === undefined) delete process.env.CONTENT_PLATFORM_BINDINGS; else process.env.CONTENT_PLATFORM_BINDINGS = previous.bindings;
  }
});

test("Instagram media delivery is stored and marks the source media ready", async () => {
  const previous = { url: process.env.CONTENT_PLATFORM_URL, token: process.env.CONTENT_PLATFORM_TOKEN, bindings: process.env.CONTENT_PLATFORM_BINDINGS, fetch: globalThis.fetch };
  process.env.CONTENT_PLATFORM_URL = "https://content.internal";
  process.env.CONTENT_PLATFORM_TOKEN = "server-secret";
  process.env.CONTENT_PLATFORM_BINDINGS = JSON.stringify([{ workspaceId: "ws_demo", botSlug: "instagram_test_bot", contentBotKey: "instagram-content", channel: "instagram" }]);
  const writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const collection = url.pathname.split("/")[2];
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (method !== "GET") writes.push({ path: url.pathname, method, body });
    if (method === "POST" && collection === "media_deliveries") {
      return new Response(JSON.stringify({ data: { id: 17, ...body } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "PATCH" && collection === "media_assets") {
      return new Response(JSON.stringify({ data: { id: 7, ...body } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const data = collection === "content_bots" ? [{ id: 1, key: "instagram-content", name: "Instagram Content" }]
      : collection === "media_assets" ? [{ id: 7, bot: 1, name: "clip.mp4", kind: "video", yandex_path: "/Instagram/clip.mp4", status: "processing" }]
        : [];
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const service = new ContentPlatformService();
    const delivery = await service.runtimeSetMediaDelivery("ws_demo", "instagram_test_bot", 7, { externalReference: "instagram-media-id", expiresAt: "2099-01-01T00:00:00.000Z" });
    assert.equal(delivery.external_reference, "instagram-media-id");
    assert.deepEqual(writes.map((write) => [write.method, write.path]), [
      ["POST", "/items/media_deliveries"],
      ["PATCH", "/items/media_assets/7"],
    ]);
    assert.equal(writes[1].body.status, "ready");
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.CONTENT_PLATFORM_URL; else process.env.CONTENT_PLATFORM_URL = previous.url;
    if (previous.token === undefined) delete process.env.CONTENT_PLATFORM_TOKEN; else process.env.CONTENT_PLATFORM_TOKEN = previous.token;
    if (previous.bindings === undefined) delete process.env.CONTENT_PLATFORM_BINDINGS; else process.env.CONTENT_PLATFORM_BINDINGS = previous.bindings;
  }
});
