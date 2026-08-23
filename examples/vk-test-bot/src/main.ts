import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { BotCrmClient, BotCrmError, verifyBotCrmWebhook } from "../../../packages/sdk-ts/src/index.js";
import { commandOf, scenarioFor } from "../../test-bot-scenarios.js";

type VkUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  screen_name?: string;
  photo_200?: string;
  city?: { id?: number; title?: string };
};

type VkMessage = {
  id?: number;
  conversation_message_id?: number;
  date?: number;
  peer_id: number;
  from_id: number;
  out?: number;
  text?: string;
  payload?: string;
  attachments?: Array<{ type?: string }>;
};

type VkUpdate = {
  type: string;
  event_id?: string;
  group_id?: number;
  object?: { message?: VkMessage } | VkMessage;
};

type VkApiEnvelope<T> = {
  response?: T;
  error?: { error_code?: number; error_msg?: string; request_params?: Array<{ key?: string; value?: string }> };
};

type VkLongPollServer = { key: string; server: string; ts: string };
type VkLongPollResponse = { ts?: string; updates?: VkUpdate[]; failed?: number };

const checkOnly = process.argv.includes("--bot-check");
const outboundProxyEnabled = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
if (outboundProxyEnabled) setGlobalDispatcher(new EnvHttpProxyAgent());

const config = {
  accessToken: process.env.VK_TEST_BOT_TOKEN?.trim() ?? "",
  groupId: Number(process.env.VK_TEST_GROUP_ID || 0),
  apiVersion: process.env.VK_TEST_API_VERSION?.trim() || "5.199",
  botCrmToken: (process.env.VK_TEST_BOTCRM_TOKEN || process.env.SERVICE_TOKEN)?.trim() ?? "",
  botCrmBaseUrl: (process.env.VK_TEST_BOTCRM_URL || "http://localhost:4100").replace(/\/$/, ""),
  workspaceId: process.env.VK_TEST_WORKSPACE_ID?.trim() || "ws_demo",
  botId: process.env.VK_TEST_BOT_SLUG?.trim() || "vk_test_bot",
  callbackSecret: process.env.VK_TEST_BOT_CALLBACK_SECRET?.trim() ?? "",
  callbackPort: Number(process.env.VK_TEST_BOT_PORT || 4320),
};

function log(message: string, details?: unknown) {
  const suffix = details === undefined ? "" : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
  process.stdout.write(`[${new Date().toLocaleTimeString("ru-RU")}] ${message}${suffix}\n`);
}

function configurationProblems(requireVk = true) {
  const problems: string[] = [];
  if (requireVk && config.accessToken.length < 20) problems.push("VK_TEST_BOT_TOKEN не задан или выглядит некорректно");
  if (requireVk && (!Number.isSafeInteger(config.groupId) || config.groupId <= 0)) problems.push("VK_TEST_GROUP_ID должен быть положительным числовым ID сообщества");
  if (config.botCrmToken.length < 16) problems.push("VK_TEST_BOTCRM_TOKEN или SERVICE_TOKEN не задан");
  if (config.callbackSecret && config.callbackSecret.length < 16) problems.push("VK_TEST_BOT_CALLBACK_SECRET должен содержать минимум 16 символов либо оставаться пустым");
  if (config.callbackSecret && (!Number.isInteger(config.callbackPort) || config.callbackPort < 1024 || config.callbackPort > 65535)) problems.push("VK_TEST_BOT_PORT должен быть свободным портом от 1024 до 65535");
  try { new URL(config.botCrmBaseUrl); } catch { problems.push("VK_TEST_BOTCRM_URL должен быть корректным URL"); }
  return problems;
}

async function vkApi<T>(method: string, params: Record<string, string | number | boolean> = {}, timeoutMs = 15_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.vk.com/method/${method}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        access_token: config.accessToken,
        v: config.apiVersion,
        ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = outboundProxyEnabled ? "Проверьте, что локальный HTTP(S)-прокси запущен." : "Если VK доступен через VPN/прокси, задайте HTTPS_PROXY в .env.";
    throw new Error(`VK ${method}: сеть недоступна (${detail}). ${hint}`, { cause: error });
  }

  const body = await response.json() as VkApiEnvelope<T>;
  if (!response.ok) throw new Error(`VK ${method}: HTTP ${response.status}`);
  if (body.error) throw new Error(`VK ${method}: [${body.error.error_code ?? "?"}] ${body.error.error_msg || "ошибка API"}`);
  if (body.response === undefined) throw new Error(`VK ${method}: ответ не содержит поле response`);
  return body.response;
}

async function longPollServer() {
  const result = await vkApi<VkLongPollServer>("groups.getLongPollServer", { group_id: config.groupId });
  if (!result.key || !result.server || result.ts === undefined) throw new Error("VK groups.getLongPollServer вернул неполные данные");
  return { ...result, ts: String(result.ts), server: result.server.replace(/\/$/, "") };
}

async function poll(state: VkLongPollServer, timeoutMs = 32_000): Promise<VkLongPollResponse> {
  const url = new URL(state.server);
  url.searchParams.set("act", "a_check");
  url.searchParams.set("key", state.key);
  url.searchParams.set("ts", state.ts);
  url.searchParams.set("wait", "25");
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`VK Long Poll: HTTP ${response.status}`);
  return await response.json() as VkLongPollResponse;
}

const profileCache = new Map<number, Promise<VkUser | undefined>>();
function vkProfile(userId: number) {
  let pending = profileCache.get(userId);
  if (!pending) {
    pending = vkApi<VkUser[] | { items?: VkUser[] }>("users.get", { user_ids: userId, fields: "photo_200,city,screen_name" }, 8_000)
      .then((result) => Array.isArray(result) ? result[0] : result.items?.[0])
      .catch(() => undefined);
    profileCache.set(userId, pending);
  }
  return pending;
}

const crm = new BotCrmClient({
  baseUrl: config.botCrmBaseUrl,
  workspaceId: config.workspaceId,
  botId: config.botId,
  serviceToken: config.botCrmToken,
});

function messageFromUpdate(update: VkUpdate) {
  if (update.type !== "message_new") return undefined;
  const object = update.object as { message?: VkMessage } | undefined;
  return object?.message ?? update.object as VkMessage | undefined;
}

async function handleUpdate(update: VkUpdate) {
  const message = messageFromUpdate(update);
  if (!message || message.out === 1 || !Number.isSafeInteger(message.from_id) || message.from_id <= 0) return;

  const payloadText = (() => {
    if (!message.payload) return "";
    try {
      const payload = JSON.parse(message.payload) as Record<string, unknown>;
      return typeof payload.command === "string" ? payload.command : typeof payload.value === "string" ? payload.value : "";
    } catch { return ""; }
  })();
  const attachmentTypes = (message.attachments ?? []).map((item) => item.type).filter(Boolean).join(", ");
  const text = message.text?.trim() || payloadText || (attachmentTypes ? `[Вложение VK: ${attachmentTypes}]` : "[Неподдерживаемое сообщение VK]");
  const scenario = scenarioFor(text, config.botId);
  const profile = await vkProfile(message.from_id);
  const fullName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || profile?.screen_name || `VK ${message.from_id}`;
  const externalMessageId = String(message.id || message.conversation_message_id || `${message.peer_id}:${message.date ?? 0}`);
  const eventId = `vk:${update.event_id || `${update.group_id ?? config.groupId}:${externalMessageId}:${message.peer_id}`}`;

  const accepted = await crm.incoming({
    eventId,
    channel: "vk",
    chatId: String(message.peer_id),
    userId: String(message.from_id),
    text,
    externalMessageId,
    profile: {
      name: fullName,
      city: profile?.city?.title,
      avatar_url: profile?.photo_200,
    },
    attributes: {
      ...scenario.attributes,
      vk_screen_name: profile?.screen_name,
      vk_group_id: update.group_id ?? config.groupId,
      vk_peer_id: message.peer_id,
      vk_attachment_types: attachmentTypes || undefined,
      last_bot_command: commandOf(text).startsWith("/") ? commandOf(text) : undefined,
    },
    raw: update,
  });

  if (accepted.duplicate) {
    log("Повтор VK update пропущен", eventId);
    return;
  }
  if (!accepted.deliverToBot || !accepted.conversationId) {
    log("Сообщение сохранено, ответ заблокирован режимом HUMAN/PAUSED", { eventId, conversationId: accepted.conversationId });
    return;
  }

  try {
    await crm.send({
      conversationId: accepted.conversationId,
      text: scenario.reply,
      actor: "bot",
      idempotencyKey: `vk-test-bot:reply:${eventId}`,
    });
    log("Ответ поставлен в очередь BotCRM", { conversationId: accepted.conversationId, eventId });
    if (scenario.handoff) {
      try {
        const state = await crm.conversation(accepted.conversationId);
        if (state.mode === "BOT") {
          await crm.claim(accepted.conversationId, state.controlVersion, config.botId);
          log("Диалог автоматически передан оператору", accepted.conversationId);
        }
      } catch (error) {
        if (error instanceof BotCrmError && error.code === "control_version_conflict") {
          log("Передача оператору уже выполнена параллельно", accepted.conversationId);
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof BotCrmError && error.code === "bot_not_in_control") {
      log("Ответ отменён: оператор успел забрать диалог", accepted.conversationId);
      return;
    }
    throw error;
  }
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Callback body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function respond(response: ServerResponse, status: number, body = "") {
  response.writeHead(status, { "content-type": body ? "application/json; charset=utf-8" : "text/plain; charset=utf-8" });
  response.end(body);
}

function startCallbackServer(): Server | undefined {
  if (!config.callbackSecret) {
    log("Callback BotCRM отключён: endpoint в режиме Mirror можно оставить пустым");
    return undefined;
  }
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        respond(response, 200, JSON.stringify({ status: "ok", botId: config.botId, channel: "vk" }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/botcrm/events") {
        respond(response, 404, JSON.stringify({ error: "not_found" }));
        return;
      }
      const raw = await readBody(request);
      const signature = Array.isArray(request.headers["x-botcrm-signature"]) ? request.headers["x-botcrm-signature"][0] : request.headers["x-botcrm-signature"];
      if (!verifyBotCrmWebhook(raw, signature, config.callbackSecret)) {
        respond(response, 401, JSON.stringify({ error: "invalid_signature" }));
        return;
      }
      const event = JSON.parse(raw.toString("utf8")) as { type?: string; event_id?: string; conversation_id?: string; message?: { text?: string } };
      log("Callback от BotCRM", { type: event.type, eventId: event.event_id, conversationId: event.conversation_id, text: event.message?.text });
      respond(response, 204);
    } catch (error) {
      log("Ошибка callback", error instanceof Error ? error.message : String(error));
      respond(response, 500, JSON.stringify({ error: "callback_failed" }));
    }
  }).listen(config.callbackPort, "127.0.0.1", () => {
    log(`Callback endpoint: http://127.0.0.1:${config.callbackPort}/botcrm/events`);
  });
}

function groupFrom(result: unknown): { id?: number; name?: string } | undefined {
  if (Array.isArray(result)) return result[0] as { id?: number; name?: string } | undefined;
  if (result && typeof result === "object" && "groups" in result) return (result as { groups?: Array<{ id?: number; name?: string }> }).groups?.[0];
  return undefined;
}

async function checkEnvironment() {
  const problems = configurationProblems(false);
  log("Проверка тестового VK-бота");
  log(`BotCRM: ${config.botCrmBaseUrl}`);
  try {
    const response = await fetch(`${config.botCrmBaseUrl}/api/v1/health`, { signal: AbortSignal.timeout(3_000) });
    log(response.ok ? "BotCRM API доступен" : `BotCRM API ответил ${response.status}`);
  } catch {
    problems.push("BotCRM API недоступен — проверьте VK_TEST_BOTCRM_URL и доступ к серверу");
  }

  if (!config.accessToken) {
    log("VK token пока не задан — это нормально до создания ключа доступа сообщества");
  } else if (config.accessToken.length < 20) {
    problems.push("VK_TEST_BOT_TOKEN выглядит некорректно");
  } else if (!Number.isSafeInteger(config.groupId) || config.groupId <= 0) {
    problems.push("VK_TEST_GROUP_ID не задан или имеет неверный формат");
  } else {
    log("VK token найден, полное значение не выводится");
    try {
      const result = await vkApi<unknown>("groups.getById", { group_ids: config.groupId });
      const group = groupFrom(result);
      log(`VK API доступен: ${group?.name || `сообщество ${config.groupId}`}`);
      const server = await longPollServer();
      log(`Bots Long Poll доступен: ${new URL(server.server).host}`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (problems.length) {
    problems.forEach((problem) => log(`Нужно исправить: ${problem}`));
    process.exitCode = 1;
  } else {
    log("Конфигурация готова к запуску");
  }
}

async function main() {
  if (checkOnly) {
    await checkEnvironment();
    return;
  }
  const problems = configurationProblems(true);
  if (problems.length) throw new Error(`Конфигурация не готова:\n- ${problems.join("\n- ")}`);

  const groupResult = await vkApi<unknown>("groups.getById", { group_ids: config.groupId });
  const group = groupFrom(groupResult);
  log(`VK-бот сообщества «${group?.name || config.groupId}» подключён`);
  log(`BotCRM bot slug: ${config.botId}`);

  const callbackServer = startCallbackServer();
  let state = await longPollServer();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (callbackServer) callbackServer.close(() => log("Callback-сервер остановлен"));
    else log("Тестовый VK-бот остановлен");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    try {
      const result = await poll(state);
      if (result.failed) {
        if (result.failed === 1 && result.ts) {
          state.ts = String(result.ts);
          continue;
        }
        log(`VK Long Poll запросил обновление сервера (failed=${result.failed})`);
        state = await longPollServer();
        continue;
      }
      if (result.ts) state.ts = String(result.ts);
      for (const update of result.updates ?? []) {
        try { await handleUpdate(update); }
        catch (error) { log("Не удалось обработать VK update", error instanceof Error ? error.message : String(error)); }
      }
    } catch (error) {
      if (stopping) break;
      log("Ошибка VK Long Poll; повтор через 2 секунды", error instanceof Error ? error.message : String(error));
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try { state = await longPollServer(); } catch { /* retry in the next iteration */ }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
