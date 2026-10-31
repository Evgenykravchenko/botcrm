import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
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
} from "./assistant-contract.js";
import { ASSISTANT_GUIDE } from "./assistant-guide.js";

@Injectable()
export class AssistantService implements OnModuleInit, OnModuleDestroy {
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
        history: input.history ?? [],
        context,
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
          system: ASSISTANT_GUIDE,
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
    try {
      const key = decryptSecret(settings.encryptedCredentials).apiKey;
      if (typeof key !== "string")
        throw new DomainError(
          503,
          "Ключ помощника недоступен. Сохраните его заново в настройках.",
          "assistant_key_required",
        );
      const completion = await this.provider.complete(
        config,
        key,
        ASSISTANT_GUIDE,
        user,
      );
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
      const result = {
        ...parseAssistantResult(completion.value, context, input.requestId),
        usage: {
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          costUsd: cost / 1e6,
        },
      };
      await store.finish(principal.workspaceId, input.requestId, result, cost);
      return result;
    } catch (error) {
      await store.fail(principal.workspaceId, input.requestId);
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        502,
        "Помощник не смог завершить запрос. Данные CRM не изменены.",
        "assistant_failed",
      );
    }
  }
}
