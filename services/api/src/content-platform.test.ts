import assert from "node:assert/strict";
import test from "node:test";
import { ContentPlatformService, validateContentMediaInput, validateKeywordReplyInput } from "./content-platform.js";

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
