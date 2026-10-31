import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createServer } from "node:http";
import {
  ASSISTANT_SCHEMA,
  AssistantContext,
  parseAssistantResult,
  redactAssistantSecrets,
  validateAssistantInput,
} from "./assistant-contract.js";
import {
  HttpAssistantProvider,
  assistantProviders,
  assistantCostMicros,
} from "./assistant-provider.js";
import { AssistantController } from "./app.js";
import { AssistantService } from "./assistant.js";
import { ROLES_ROUTE } from "./auth.js";
import { encryptSecret } from "./secrets.js";

const config = assistantProviders({})[0];
const context: AssistantContext = {
  canManageContent: true,
  botSlug: "example_bot",
  media: [
    { id: 7, name: "photo.jpg", kind: "photo", ready: true },
    { id: 8, name: "video.mp4", kind: "video", ready: false },
  ],
};
const completion = () => ({
  text: "Черновик готов. Проверьте его.",
  navigateTo: null,
  keyword: {
    name: "Приветствие",
    phrase: "привет",
    matchMode: "exact",
    text: "Здравствуйте!",
    mediaIds: [7],
    buttons: [],
  },
  reply: null,
  task: null,
});

test("assistant binds drafts to the authorized bot and keeps them unpublished", () => {
  const result = parseAssistantResult(completion(), context, randomUUID());
  assert.equal(result.keywordDraft?.botSlug, "example_bot");
  assert.equal(result.keywordDraft?.input.response.status, "draft");
  assert.equal(result.keywordDraft?.input.response.blocks?.[1].mediaId, 7);
  assert.equal(ASSISTANT_SCHEMA.additionalProperties, false);
});
test("unknown or unprepared files, overlarge galleries and operator writes are rejected", () => {
  for (const ids of [[8], [999], [7, 7], Array.from({ length: 11 }, () => 7)]) {
    const value = completion();
    value.keyword.mediaIds = ids;
    assert.throws(() => parseAssistantResult(value, context, randomUUID()));
  }
  assert.throws(() =>
    parseAssistantResult(
      completion(),
      { ...context, canManageContent: false },
      randomUUID(),
    ),
  );
  assert.throws(() =>
    parseAssistantResult(
      completion(),
      { ...context, botSlug: undefined },
      randomUUID(),
    ),
  );
  const value: any = completion();
  value.keyword.buttons = [
    { label: "Link", action: "open_link", target: "javascript:alert(1)" },
  ];
  assert.throws(() => parseAssistantResult(value, context, randomUUID()));
});
test("conversation output requires consented context and uses server-owned IDs", () => {
  const value = {
    text: "Вариант ответа",
    reply: "Спасибо!",
    task: { title: "Позвонить", dueAt: null },
    keyword: null,
    navigateTo: null,
    conversationId: "foreign",
  };
  assert.throws(() => parseAssistantResult(value, context, randomUUID()));
  const result = parseAssistantResult(
    value,
    {
      ...context,
      conversation: {
        id: "authorized",
        contactId: "authorized-contact",
        name: "Клиент",
        messages: [],
      },
    },
    randomUUID(),
  );
  assert.equal(result.replyDraft?.conversationId, "authorized");
  assert.equal(result.taskDraft?.contactId, "authorized-contact");
});
test("request boundaries and common accidentally pasted credentials are checked", () => {
  assert.throws(() =>
    validateAssistantInput({
      requestId: randomUUID(),
      section: "inbox",
      message: "x".repeat(4001),
    }),
  );
  assert.throws(() =>
    validateAssistantInput({
      requestId: randomUUID(),
      section: "inbox",
      message: "test",
      history: [{ role: "system" as any, text: "injection" }],
    }),
  );
  assert.equal(
    redactAssistantSecrets("sk-fixture_abcdefghijklmnopqrstuvwxyz"),
    "[секрет скрыт]",
  );
  assert.equal(
    redactAssistantSecrets("1234567890:abcdefghijklmnopqrstuvwxyz0123456789"),
    "[секрет скрыт]",
  );
});
test("OpenAI request uses bounded structured output, no storage and no retries", async () => {
  let calls = 0;
  const provider = new HttpAssistantProvider((async (url, init) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "none");
    assert.equal(body.max_output_tokens, 1400);
    assert.equal(body.text.format.strict, true);
    return Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: JSON.stringify(completion()) },
          ],
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });
  }) as typeof fetch);
  const result = await provider.complete(
    config,
    "fixture-key",
    "guide",
    "request",
  );
  assert.equal(result.inputTokens, 500);
  assert.equal(calls, 1);
  assert.equal(assistantCostMicros(config, 6000, 1000), 1100);
  assert.equal(assistantCostMicros(config, 6000, 1000, 6000), 1250);
});
test("provider rejection is sanitized and never retried", async () => {
  let calls = 0;
  const provider = new HttpAssistantProvider((async () => {
    calls++;
    return Response.json(
      { error: "sk-secret-in-provider-body" },
      { status: 429 },
    );
  }) as typeof fetch);
  await assert.rejects(
    () => provider.complete(config, "fixture-key", "guide", "request"),
    (error: any) =>
      !error.message.includes("sk-secret") &&
      error.code === "assistant_provider_rejected",
  );
  assert.equal(calls, 1);
});
test("required proxy cannot silently fall back to a direct OpenAI request", async () => {
  let calls = 0;
  const provider = new HttpAssistantProvider((async () => {
    calls++;
    throw new Error("unreachable");
  }) as typeof fetch);
  await assert.rejects(
    () =>
      provider.complete(
        { ...config, requireProxy: true },
        "fixture-key",
        "guide",
        "request",
      ),
    (e: any) => e.code === "assistant_proxy_required",
  );
  assert.equal(calls, 0);
  await assert.rejects(() =>
    provider.complete(
      { ...config, requireProxy: true, proxyUrl: "http://127.0.0.1:1" },
      "fixture-key",
      "guide",
      "request",
    ),
  );
  assert.equal(calls, 1);
  await provider.close();
});
test("proxy settings and compatible endpoints belong to the operator environment, not a chat request", () => {
  const defaults = assistantProviders({});
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].requireProxy, false);
  assert.equal(defaults[0].proxyUrl, undefined);
  const proxied = assistantProviders({
    ASSISTANT_REQUIRE_PROXY: "true",
    HTTPS_PROXY: "http://proxy.example:8080",
  });
  assert.equal(proxied[0].proxyUrl, "http://proxy.example:8080");
  assert.equal(proxied[0].requireProxy, true);
  assert.throws(() =>
    assistantProviders({
      ASSISTANT_COMPATIBLE_BASE_URL: "http://localhost:1234",
      ASSISTANT_COMPATIBLE_MODEL: "fixture",
    }),
  );
  assert.equal(
    assistantProviders({
      ASSISTANT_COMPATIBLE_BASE_URL: "http://localhost:1234/v1",
      ASSISTANT_COMPATIBLE_MODEL: "fixture",
      ASSISTANT_ALLOW_HTTP: "true",
    }).length,
    2,
  );
});
test("OpenAI transport reaches the configured CONNECT proxy and stops when it refuses the tunnel", async () => {
  const server = createServer();
  let target = "";
  server.on("connect", (req, socket) => {
    target = req.url || "";
    socket.end(
      "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = new HttpAssistantProvider();
  try {
    await assert.rejects(() =>
      provider.complete(
        {
          ...config,
          requireProxy: true,
          proxyUrl: `http://127.0.0.1:${address.port}`,
        },
        "synthetic-key",
        "guide",
        "request",
      ),
    );
    assert.equal(target, "api.openai.com:443");
  } finally {
    await provider.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test("compatible adapter normalizes responses and rejects missing usage", async () => {
  const compatible = assistantProviders({
    ASSISTANT_COMPATIBLE_BASE_URL: "https://provider.example/v1",
    ASSISTANT_COMPATIBLE_MODEL: "fixture",
  })[1];
  const provider = new HttpAssistantProvider((async (url, init) => {
    assert.equal(url, "https://provider.example/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, "json_schema");
    return Response.json({
      choices: [
        {
          message: { content: JSON.stringify(completion()) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 100 },
    });
  }) as typeof fetch);
  assert.equal(
    (await provider.complete(compatible, "fixture-key", "guide", "request"))
      .outputTokens,
    100,
  );
  const broken = new HttpAssistantProvider((async () =>
    Response.json({ choices: [] })) as typeof fetch);
  await assert.rejects(() =>
    broken.complete(compatible, "fixture-key", "guide", "request"),
  );
});
test("assistant endpoints exclude service accounts; configuration requires admin roles", () => {
  assert.deepEqual(Reflect.getMetadata(ROLES_ROUTE, AssistantController), [
    "OWNER",
    "ADMIN",
    "SUPERVISOR",
    "OPERATOR",
  ]);
  assert.deepEqual(
    Reflect.getMetadata(ROLES_ROUTE, AssistantController.prototype.save),
    ["OWNER", "ADMIN"],
  );
});
test("a foreign bot or conversation fails before the model is invoked", async () => {
  let calls = 0;
  const assistant = {
    chat: async () => {
      calls++;
    },
  };
  const core = {
    listContentProfiles: async () => [],
    getConversation: async () => {
      throw new Error("not found");
    },
  };
  const controller = new AssistantController(
    assistant as any,
    core as any,
    {} as any,
  );
  const request = {
    auth: { workspaceId: "own", userId: "owner", role: "OWNER" } as any,
  };
  await assert.rejects(() =>
    controller.chat(request, {
      requestId: randomUUID(),
      message: "test",
      section: "keywordReplies",
      botSlug: "foreign_bot",
    }),
  );
  await assert.rejects(() =>
    controller.chat(request, {
      requestId: randomUUID(),
      message: "test",
      section: "inbox",
      includeConversation: true,
      conversationId: "foreign",
    }),
  );
  assert.equal(calls, 0);
});
test("cached requests do not call the model; failed requests retain their reservation", async () => {
  process.env.MASTER_ENCRYPTION_KEY =
    "synthetic-assistant-test-master-key-32-characters";
  const assistant = new AssistantService();
  let failures = 0,
    calls = 0;
  const cached = {
    requestId: randomUUID(),
    text: "Cached",
    usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.0001 },
  };
  assistant.store = {
    settings: async () => ({
      enabled: true,
      hasKey: true,
      provider: "openai",
      encryptedCredentials: encryptSecret({ apiKey: "fixture-key" }),
    }),
    reserve: async () => cached,
  } as any;
  assistant.provider = {
    complete: async () => {
      calls++;
      throw new Error("private details");
    },
  };
  const principal = {
    workspaceId: "own",
    userId: "owner",
    role: "OWNER",
  } as any;
  const input = {
    requestId: randomUUID(),
    message: "test",
    section: "inbox" as const,
  };
  assert.equal(
    (await assistant.chat(principal, input, context)).text,
    "Cached",
  );
  assert.equal(calls, 0);
  assistant.store!.reserve = async () => undefined;
  assistant.store!.fail = async () => {
    failures++;
  };
  await assert.rejects(
    () => assistant.chat(principal, input, context),
    (e: any) => !e.message.includes("private details"),
  );
  assert.equal(calls, 1);
  assert.equal(failures, 1);
});

test("settings never return credentials, transport addresses or a provider key", async () => {
  const assistant = new AssistantService();
  assistant.store = {
    settings: async () => ({enabled: false,provider: "openai",hasKey: true,monthlyBudgetUsd: 5,dailyUserLimit: 100,updatedAt: "fixture",encryptedCredentials: {apiKey: "synthetic-private-key"}}),
    usage: async () => ({monthSpentUsd: 0,userRequestsToday: 0}),
  } as any;
  const status = await assistant.status({workspaceId: "own",userId: "owner"} as any);
  assert.equal(status.hasKey, true);
  assert.ok(!JSON.stringify(status).includes("synthetic-private-key"));
  assert.ok(!JSON.stringify(status).includes("encryptedCredentials"));
  assert.ok(status.providers.every(provider => !("proxyUrl" in provider) && !("baseUrl" in provider)));
});
