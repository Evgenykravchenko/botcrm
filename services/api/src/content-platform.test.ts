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
    return new Response(JSON.stringify({ _embedded: { items: [{ name: "test.jpg", path: "disk:/VK Content Bot/photos/test.jpg", type: "file", mime_type: "image/jpeg", size: 2048, preview: "https://preview.example/test.jpg" }] } }), { status: 200, headers: { "content-type": "application/json" } });
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
