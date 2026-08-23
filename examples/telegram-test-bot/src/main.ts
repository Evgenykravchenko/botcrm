import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { BotCrmClient, BotCrmError, verifyBotCrmWebhook } from "../../../packages/sdk-ts/src/index.js";

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  contact?: { phone_number: string; first_name: string; last_name?: string; user_id?: number };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

type TelegramResponse<T> = { ok: boolean; result: T; description?: string; error_code?: number };

const checkOnly = process.argv.includes("--bot-check");
const outboundProxyEnabled = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
if (outboundProxyEnabled) setGlobalDispatcher(new EnvHttpProxyAgent());
const config = {
  telegramToken: process.env.TELEGRAM_TEST_BOT_TOKEN?.trim() ?? "",
  botCrmToken: (process.env.TELEGRAM_TEST_BOTCRM_TOKEN || process.env.SERVICE_TOKEN)?.trim() ?? "",
  botCrmBaseUrl: (process.env.TELEGRAM_TEST_BOTCRM_URL || "http://localhost:4100").replace(/\/$/, ""),
  workspaceId: process.env.TELEGRAM_TEST_WORKSPACE_ID?.trim() || "ws_demo",
  botId: process.env.TELEGRAM_TEST_BOT_SLUG?.trim() || "telegram_test_bot",
  callbackSecret: process.env.TELEGRAM_TEST_BOT_CALLBACK_SECRET?.trim() ?? "",
  callbackPort: Number(process.env.TELEGRAM_TEST_BOT_PORT || 4310),
};

function log(message: string, details?: unknown) {
  const suffix = details === undefined ? "" : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
  process.stdout.write(`[${new Date().toLocaleTimeString("ru-RU")}] ${message}${suffix}\n`);
}

function configurationProblems(requireTelegram = true) {
  const problems: string[] = [];
  if (requireTelegram && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.telegramToken)) problems.push("TELEGRAM_TEST_BOT_TOKEN не задан или имеет неверный формат");
  if (config.botCrmToken.length < 16) problems.push("TELEGRAM_TEST_BOTCRM_TOKEN или SERVICE_TOKEN не задан");
  if (config.callbackSecret.length < 16) problems.push("TELEGRAM_TEST_BOT_CALLBACK_SECRET должен содержать минимум 16 символов");
  if (!Number.isInteger(config.callbackPort) || config.callbackPort < 1024 || config.callbackPort > 65535) problems.push("TELEGRAM_TEST_BOT_PORT должен быть свободным портом от 1024 до 65535");
  try { new URL(config.botCrmBaseUrl); } catch { problems.push("TELEGRAM_TEST_BOTCRM_URL должен быть корректным URL"); }
  return problems;
}

async function telegram<T>(method: string, payload: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = outboundProxyEnabled ? "Проверьте, что локальный HTTP(S)-прокси запущен." : "Если Telegram доступен через VPN/прокси, задайте HTTPS_PROXY в .env.";
    throw new Error(`Telegram ${method}: сеть недоступна (${detail}). ${hint}`, { cause: error });
  }
  const body = await response.json() as TelegramResponse<T>;
  if (!response.ok || !body.ok) throw new Error(`Telegram ${method}: ${body.description || response.statusText}`);
  return body.result;
}

const avatarFileCache = new Map<number, Promise<string | undefined>>();
function telegramAvatarFileId(userId: number) {
  let pending = avatarFileCache.get(userId);
  if (!pending) {
    pending = telegram<{ photos?: Array<Array<{ file_id?: string }>> }>("getUserProfilePhotos", { user_id: userId, limit: 1 }, 8_000)
      .then((result) => result.photos?.[0]?.at(-1)?.file_id ?? result.photos?.[0]?.[0]?.file_id)
      .catch(() => undefined);
    avatarFileCache.set(userId, pending);
  }
  return pending;
}

const crm = new BotCrmClient({
  baseUrl: config.botCrmBaseUrl,
  workspaceId: config.workspaceId,
  botId: config.botId,
  serviceToken: config.botCrmToken,
});

function commandOf(text: string) {
  return text.trim().split(/\s+/, 1)[0]?.toLowerCase().replace(/@[^\s]+$/, "") ?? "";
}

type BotScenario = {
  reply: string;
  attributes: Record<string, unknown>;
  handoff?: boolean;
};

function scenarioFor(text: string): BotScenario {
  const command = commandOf(text);
  const normalized = text.toLowerCase();
  if (command === "/buy" || /купить|оплат|заказ/.test(normalized)) {
    return {
      reply: "Отлично — зафиксировал высокий интерес. В BotCRM у контакта появились lead_score=95, intent=purchase и requested_plan=pro. Теперь создайте сделку или проверьте автоматизацию.",
      attributes: { lead_score: 95, intent: "purchase", requested_plan: "pro", funnel_hint: "qualification", test_scenario: "hot_lead" },
    };
  }
  if (command === "/price" || /цен|стоим|тариф/.test(normalized)) {
    return {
      reply: "Тестовый тариф Pro стоит 4 900 ₽ в месяц. Я записал интерес к цене и lead_score=70 — эти поля можно увидеть в карточке контакта и использовать в фильтрах.",
      attributes: { lead_score: 70, topic: "pricing", requested_plan: "pro", test_scenario: "pricing" },
    };
  }
  if (command === "/support" || /ошиб|проблем|поддерж/.test(normalized)) {
    return {
      reply: "Обращение отмечено как поддержка и передано оператору. Бот больше не будет отвечать, пока оператор не вернёт ему управление. В панели можно ответить клиенту, а заметку и задачу добавить отдельно для проверки CRM.",
      attributes: { lead_score: 35, topic: "support", priority: "normal", needs_human: true, test_scenario: "support" },
      handoff: true,
    };
  }
  if (command === "/status") {
    return {
      reply: "Сейчас диалог находится под управлением бота. Если нажать «Забрать у бота», следующие сообщения сохранятся в CRM, но автоматического ответа уже не будет.",
      attributes: { last_status_check_at: new Date().toISOString(), test_scenario: "control" },
    };
  }
  if (command === "/help") {
    return {
      reply: "Команды для проверки:\n/start — новый контакт\n/price — переменные и средний lead score\n/buy — горячий лид\n/support — обращение в поддержку\n/status — проверка перехвата\n/help — эта подсказка",
      attributes: { test_scenario: "help" },
    };
  }
  if (command === "/start") {
    return {
      reply: "Привет! Я локальный тестовый бот BotCRM. Напишите /price, /buy или /support. Все сообщения и переменные должны появиться в панели.",
      attributes: { lead_score: 20, source: "telegram_test_bot", lifecycle: "new", test_scenario: "onboarding" },
    };
  }
  return {
    reply: `Получил: «${text.slice(0, 240)}». Сообщение сохранено в BotCRM. Для проверки сценариев используйте /price, /buy, /support или /status.`,
    attributes: { source: "telegram_test_bot", last_intent: "free_text", test_scenario: "echo" },
  };
}

async function handleUpdate(update: TelegramUpdate) {
  const message = update.message ?? update.edited_message;
  const sender = message?.from;
  if (!message || !sender || sender.is_bot) return;

  const text = message.text ?? message.caption ?? (message.contact ? "[Контакт Telegram]" : "[Неподдерживаемое сообщение]");
  const scenario = scenarioFor(text);
  const fullName = [sender.first_name, sender.last_name].filter(Boolean).join(" ") || sender.username || `Telegram ${sender.id}`;
  const avatarFileId = await telegramAvatarFileId(sender.id);
  const accepted = await crm.incoming({
    eventId: `telegram:${update.update_id}`,
    channel: "telegram",
    chatId: String(message.chat.id),
    userId: String(sender.id),
    text,
    externalMessageId: String(message.message_id),
    profile: {
      name: fullName,
      phone: message.contact?.user_id === sender.id ? message.contact.phone_number : undefined,
      avatar_file_id: avatarFileId,
    },
    attributes: {
      ...scenario.attributes,
      telegram_username: sender.username,
      telegram_language: sender.language_code,
      telegram_chat_type: message.chat.type,
      last_bot_command: commandOf(text).startsWith("/") ? commandOf(text) : undefined,
    },
    raw: update,
  });

  if (accepted.duplicate) {
    log("Повтор Telegram update пропущен", update.update_id);
    return;
  }
  if (!accepted.deliverToBot || !accepted.conversationId) {
    log("Сообщение сохранено, ответ заблокирован режимом HUMAN/PAUSED", { updateId: update.update_id, conversationId: accepted.conversationId });
    return;
  }

  try {
    await crm.send({
      conversationId: accepted.conversationId,
      text: scenario.reply,
      actor: "bot",
      idempotencyKey: `telegram-test-bot:reply:${update.update_id}`,
    });
    log("Ответ поставлен в очередь BotCRM", { conversationId: accepted.conversationId, updateId: update.update_id });
    if (scenario.handoff) {
      try {
        const state = await crm.conversation(accepted.conversationId);
        if (state.mode === "BOT") {
          await crm.claim(accepted.conversationId, state.controlVersion, "telegram_test_bot");
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

function startCallbackServer() {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        respond(response, 200, JSON.stringify({ status: "ok", botId: config.botId }));
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

async function checkEnvironment() {
  const problems = configurationProblems(false);
  log("Проверка тестового Telegram-бота");
  log(`BotCRM: ${config.botCrmBaseUrl}`);
  try {
    const response = await fetch(`${config.botCrmBaseUrl}/api/v1/health`, { signal: AbortSignal.timeout(3_000) });
    log(response.ok ? "BotCRM API доступен" : `BotCRM API ответил ${response.status}`);
  } catch {
    problems.push("BotCRM API недоступен — сначала запустите API");
  }
  if (!config.telegramToken) log("Telegram token пока не задан — это нормально до создания бота через @BotFather");
  else if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.telegramToken)) problems.push("TELEGRAM_TEST_BOT_TOKEN имеет неверный формат");
  else {
    log("Telegram token найден, полное значение не выводится");
    try {
      const me = await telegram<{ username?: string; first_name: string }>("getMe", {}, 10_000);
      log(`Telegram API доступен: @${me.username || me.first_name}`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (problems.length) {
    problems.forEach((problem) => log(`Нужно исправить: ${problem}`));
    process.exitCode = 1;
  } else log("Конфигурация готова к запуску");
}

async function main() {
  if (checkOnly) {
    await checkEnvironment();
    return;
  }
  const problems = configurationProblems(true);
  if (problems.length) throw new Error(`Конфигурация не готова:\n- ${problems.join("\n- ")}`);

  const me = await telegram<{ id: number; username?: string; first_name: string }>("getMe");
  await telegram("deleteWebhook", { drop_pending_updates: false });
  await telegram("setMyCommands", { commands: [
    { command: "start", description: "Начать тест BotCRM" },
    { command: "price", description: "Проверить переменные контакта" },
    { command: "buy", description: "Создать горячий лид" },
    { command: "support", description: "Проверить обращение в поддержку" },
    { command: "status", description: "Проверить перехват оператором" },
    { command: "help", description: "Показать команды" },
  ] });

  log(`Telegram-бот @${me.username || me.first_name} подключён`);
  log(`BotCRM bot slug: ${config.botId}`);
  const callbackServer = startCallbackServer();
  const shutdownController = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    shutdownController.abort();
    callbackServer.close(() => log("Тестовый бот остановлен"));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let offset = 0;
  while (!stopping) {
    try {
      const updates = await telegram<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "edited_message"],
      }, 32_000);
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        try { await handleUpdate(update); }
        catch (error) { log("Не удалось обработать update", error instanceof Error ? error.message : String(error)); }
      }
    } catch (error) {
      if (stopping || shutdownController.signal.aborted) break;
      log("Ошибка long polling; повтор через 2 секунды", error instanceof Error ? error.message : String(error));
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
