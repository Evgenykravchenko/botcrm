import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import type { AuthPrincipal } from "./auth.js";
import { DomainError } from "./core.js";
import { decryptSecret } from "./secrets.js";
import { AssistantStore, AssistantSettingsInput } from "./assistant-store.js";
import {
  AssistantProvider,
  HttpAssistantProvider,
  assistantProviders,
  assistantCostMicros,
} from "./assistant-provider.js";
import {
  AssistantContext,
  AssistantInput,
  ASSISTANT_SCHEMA,
  parseAssistantResult,
  redactAssistantSecrets,
  validateAssistantInput,
  validatedAssistantDraft,
  AssistantResultError,
} from "./assistant-contract.js";
import { assistantCompositionGuide } from "./assistant-guide.js";
import { routeAssistantRequest } from "./assistant-routing.js";
import { editAssistantDraft } from "./assistant-draft-edit.js";

@Injectable()
export class AssistantService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssistantService.name);
  private pool?: Pool;
  store?: AssistantStore;
  provider: AssistantProvider = new HttpAssistantProvider();
  onModuleInit() {
    if (process.env.DATABASE_URL) {
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 2,
        connectionTimeoutMillis: 4000,
      });
      this.store = new AssistantStore(this.pool);
    }
  }
  async onModuleDestroy() {
    await this.pool?.end();
    if (this.provider instanceof HttpAssistantProvider)
      await this.provider.close();
  }
  private database() {
    if (!this.store)
      throw new DomainError(
        503,
        "Помощнику требуется PostgreSQL. Остальные функции CRM доступны.",
        "assistant_storage_required",
      );
    return this.store;
  }
  async status(principal: AuthPrincipal) {
    const providers = assistantProviders().map(
      ({ id, model, inputPrice, outputPrice }) => ({
        id,
        model,
        inputPrice,
        outputPrice,
      }),
    );
    if (!this.store)
      return {
        available: false,
        enabled: false,
        provider: "openai",
        hasKey: false,
        monthlyBudgetUsd: 5,
        dailyUserLimit: 100,
        providers,
        monthSpentUsd: 0,
        userRequestsToday: 0,
      };
    const {
      encryptedCredentials: _credentials,
      updatedAt: _updated,
      ...settings
    } = await this.store.settings(principal.workspaceId);
    return {
      available: true,
      ...settings,
      providers,
      ...(await this.store.usage(principal.workspaceId, principal.userId)),
    };
  }
  async save(principal: AuthPrincipal, input: AssistantSettingsInput) {
    const provider = assistantProviders().find((p) => p.id === input?.provider);
    if (
      !input ||
      !provider ||
      typeof input.enabled !== "boolean" ||
      typeof input.monthlyBudgetUsd !== "number" ||
      !Number.isFinite(input.monthlyBudgetUsd) ||
      input.monthlyBudgetUsd < 0.1 ||
      input.monthlyBudgetUsd > 100 ||
      !Number.isSafeInteger(input.dailyUserLimit) ||
      input.dailyUserLimit < 1 ||
      input.dailyUserLimit > 1000 ||
      (input.apiKey !== undefined &&
        (typeof input.apiKey !== "string" ||
          input.apiKey.length < 10 ||
          input.apiKey.length > 512 ||
          /\s/.test(input.apiKey))) ||
      (input.clearKey !== undefined && typeof input.clearKey !== "boolean")
    )
      throw new DomainError(
        400,
        "Проверьте провайдера, API-ключ и лимиты. Бюджет — от $0,10 до $100, дневной лимит — от 1 до 1000.",
        "assistant_invalid_settings",
      );
    await this.database().save(principal.workspaceId, principal.userId, input);
    return this.status(principal);
  }
  async chat(
    principal: AuthPrincipal,
    input: AssistantInput,
    context: AssistantContext,
  ) {
    validateAssistantInput(input);
    const store = this.database();
    const settings = await store.settings(principal.workspaceId);
    if (!settings.enabled || !settings.hasKey)
      throw new DomainError(
        409,
        "Администратор ещё не включил AI-помощника.",
        "assistant_disabled",
      );
    const route = routeAssistantRequest(input);
    if ("local" in route)
      return {
        ...route.local,
        origin: "knowledge" as const,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    if (route.action === "keyword" && !context.canManageContent)
      throw new DomainError(
        403,
        "Создание автоответов недоступно вашей роли.",
        "assistant_forbidden",
      );
    if (route.action !== "keyword" && !context.conversation)
      throw new DomainError(
        400,
        "Выберите диалог и разрешите передачу сообщений помощнику.",
        "assistant_conversation_required",
      );
    const currentDraft =
      route.action === "keyword"
        ? validatedAssistantDraft(input.draft, context)
        : undefined;
    const edited = currentDraft
      ? editAssistantDraft(input.message, currentDraft)
      : undefined;
    if (edited)
      return {
        ...parseAssistantResult(
          {
            text: "Обновил черновик. Остальное содержимое сохранено; проверьте кнопки в редакторе.",
            keyword: edited,
          },
          context,
          input.requestId,
        ),
        origin: "local" as const,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    if (
      currentDraft &&
      currentDraft.buttons.length >= 5 &&
      /добав.{0,20}кноп/i.test(input.message)
    )
      return {
        requestId: input.requestId,
        text: "В черновике уже 5 кнопок. Уберите одну или укажите, какую заменить.",
        origin: "local" as const,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    const guide = assistantCompositionGuide(route.action);
    const wantsMedia =
      /фото|видео|медиа|файл|аудио|документ|картин|прикреп/i.test(
        input.message,
      );
    const modelMedia = context.media.filter(
      (m) => wantsMedia || currentDraft?.mediaIds.includes(m.id),
    );
    modelMedia.sort(
      (a, b) =>
        Number(currentDraft?.mediaIds.includes(b.id)) -
          Number(currentDraft?.mediaIds.includes(a.id)) ||
        Number(input.message.toLowerCase().includes(b.name.toLowerCase())) -
          Number(input.message.toLowerCase().includes(a.name.toLowerCase())),
    );
    const modelContext =
      route.action === "keyword"
        ? {
            canManageContent: context.canManageContent,
            botSlug: context.botSlug,
            botName: context.botName,
            media: modelMedia.slice(0, 20),
          }
        : { conversation: context.conversation };
    const config = assistantProviders().find((p) => p.id === settings.provider);
    if (!config)
      throw new DomainError(
        503,
        "Выбранный AI-провайдер не настроен на сервере.",
        "assistant_configuration_error",
      );
    if (config.requireProxy && !config.proxyUrl)
      throw new DomainError(
        503,
        "Для AI-запросов требуется прокси. Проверьте настройки сервера.",
        "assistant_proxy_required",
      );
    const user = redactAssistantSecrets(
      JSON.stringify({
        request: input.message,
        section: input.section,
        history: (input.history ?? [])
          .slice(-6)
          .map((t) => ({ role: t.role, text: t.text.slice(0, 700) })),
        currentDraft: currentDraft ?? null,
        context: modelContext,
        now: new Date().toISOString(),
      }),
    );
    if (Buffer.byteLength(user, "utf8") > 32_000)
      throw new DomainError(
        400,
        "Для этого запроса слишком много контекста. Начните новый чат или отключите переписку.",
        "assistant_context_too_large",
      );
    const inputUpperBound =
      Buffer.byteLength(
        JSON.stringify({
          system: guide,
          user,
          schema: ASSISTANT_SCHEMA,
        }),
        "utf8",
      ) + 1024;
    const reserve = assistantCostMicros(
      config,
      inputUpperBound,
      config.maxOutputTokens,
      config.id === "openai" ? inputUpperBound : 0,
    );
    if (reserve > 50_000)
      throw new DomainError(
        400,
        "Запрос превышает предел $0,05. Уменьшите контекст или выберите экономную модель.",
        "assistant_request_too_expensive",
      );
    const hash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const cached = await store.reserve(
      principal.workspaceId,
      principal.userId,
      input.requestId,
      hash,
      config.model,
      settings,
      reserve,
    );
    if (cached) {
      if (cached.keywordDraft && !context.canManageContent)
        throw new DomainError(
          403,
          "Создание автоответов недоступно вашей роли.",
          "assistant_forbidden",
        );
      return cached;
    }
    let knownUsage:
      | { cost: number; inputTokens: number; outputTokens: number }
      | undefined;
    try {
      const key = decryptSecret(settings.encryptedCredentials).apiKey;
      if (typeof key !== "string")
        throw new DomainError(
          503,
          "Ключ помощника недоступен. Сохраните его заново в настройках.",
          "assistant_key_required",
        );
      const completion = await this.provider.complete(config, key, guide, user);
      if (
        completion.inputTokens > inputUpperBound ||
        completion.outputTokens > config.maxOutputTokens
      )
        throw new DomainError(
          502,
          "Провайдер сообщил неожиданный расход токенов. Проверьте настройки перед повторным запросом.",
          "assistant_unexpected_usage",
        );
      const cost = assistantCostMicros(
        config,
        completion.inputTokens,
        completion.outputTokens,
        completion.cacheWriteTokens,
      );
      knownUsage = {
        cost,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      };
      const raw = completion.value as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new AssistantResultError("result");
      const questions = {
        phrase: "На какое слово или фразу должен отвечать бот?",
        link: "Пришлите HTTPS-ссылку, которую должна открывать кнопка. Подпись я предложу сам.",
        media:
          "Подходящего готового файла нет. Выберите материал в медиатеке или дождитесь статуса «Готов».",
      };
      const clarification = raw.clarification;
      if (
        clarification != null &&
        (route.action !== "keyword" ||
          !Object.hasOwn(questions, String(clarification)))
      )
        throw new AssistantResultError("clarification");
      if (clarification === "phrase" && currentDraft?.phrase)
        throw new AssistantResultError("unnecessary_phrase_question");
      const actionValue =
        route.action === "summary" ? raw.text : raw[route.action];
      if (!clarification && actionValue == null)
        throw new AssistantResultError("missing_action");
      const resultBody = clarification
        ? {
            requestId: input.requestId,
            text: questions[clarification as keyof typeof questions],
            clarification: clarification as "phrase" | "link" | "media",
          }
        : parseAssistantResult(
            {
              text:
                route.action === "keyword"
                  ? "Черновик автоответа готов. Проверьте текст, файлы и кнопки в редакторе."
                  : route.action === "reply"
                    ? "Подготовлен вариант ответа. Проверьте его перед отправкой."
                    : route.action === "task"
                      ? "Подготовлена задача. Проверьте её перед созданием."
                      : raw.text,
              keyword: route.action === "keyword" ? raw.keyword : null,
              reply: route.action === "reply" ? raw.reply : null,
              task: route.action === "task" ? raw.task : null,
            },
            context,
            input.requestId,
          );
      const result = {
        ...resultBody,
        origin: "model" as const,
        usage: {
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          costUsd: cost / 1e6,
        },
      };
      await store.finish(principal.workspaceId, input.requestId, result, cost);
      return result;
    } catch (error) {
      await store.fail(principal.workspaceId, input.requestId, knownUsage);
      if (error instanceof AssistantResultError)
        this.logger.warn({
          event: "assistant_result_rejected",
          requestId: input.requestId,
          field: error.field,
        });
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        502,
        "Помощник не смог завершить запрос. Данные CRM не изменены.",
        "assistant_failed",
      );
    }
  }
}
