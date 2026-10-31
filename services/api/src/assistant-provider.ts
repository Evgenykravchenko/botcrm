import { DomainError } from "./core.js";
import { ASSISTANT_SCHEMA } from "./assistant-contract.js";
import { ProxyAgent } from "undici";

export interface AssistantProviderConfig {
  id: "openai" | "compatible";
  model: string;
  baseUrl: string;
  inputPrice: number;
  outputPrice: number;
  maxOutputTokens: number;
  proxyUrl?: string;
  requireProxy?: boolean;
}
export interface AssistantCompletion {
  value: unknown;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
}
export interface AssistantProvider {
  complete(
    config: AssistantProviderConfig,
    key: string,
    system: string,
    user: string,
  ): Promise<AssistantCompletion>;
}

export function assistantProviders(
  env: NodeJS.ProcessEnv = process.env,
): AssistantProviderConfig[] {
  const providers: AssistantProviderConfig[] = [
    {
      id: "openai",
      model: "gpt-6-luna",
      baseUrl: "https://api.openai.com/v1",
      inputPrice: 0.1,
      outputPrice: 0.5,
      maxOutputTokens: 1400,
      proxyUrl:
        env.ASSISTANT_OPENAI_PROXY_URL || env.HTTPS_PROXY || env.https_proxy,
      requireProxy: env.ASSISTANT_REQUIRE_PROXY === "true",
    },
  ];
  if (env.ASSISTANT_COMPATIBLE_BASE_URL) {
    let url: URL;
    try {
      url = new URL(env.ASSISTANT_COMPATIBLE_BASE_URL);
    } catch {
      throw new DomainError(
        503,
        "Проверьте адрес AI-провайдера в конфигурации сервера.",
        "assistant_configuration_error",
      );
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol === "http:" && env.ASSISTANT_ALLOW_HTTP !== "true")
    )
      throw new DomainError(
        503,
        "AI-провайдеру требуется HTTPS. Для доверенного локального сервера HTTP разрешается отдельно.",
        "assistant_configuration_error",
      );
    const inputPrice = Number(env.ASSISTANT_COMPATIBLE_INPUT_PRICE ?? 1),
      outputPrice = Number(env.ASSISTANT_COMPATIBLE_OUTPUT_PRICE ?? 5);
    if (
      ![inputPrice, outputPrice].every(
        (x) => Number.isFinite(x) && x > 0 && x <= 1000,
      ) ||
      !/^[a-zA-Z0-9_.:/-]{1,120}$/.test(env.ASSISTANT_COMPATIBLE_MODEL || "")
    )
      throw new DomainError(
        503,
        "Укажите модель и положительные цены AI-провайдера.",
        "assistant_configuration_error",
      );
    providers.push({
      id: "compatible",
      model: env.ASSISTANT_COMPATIBLE_MODEL!,
      baseUrl: url.href.replace(/\/$/, ""),
      inputPrice,
      outputPrice,
      maxOutputTokens: 1400,
    });
  }
  return providers;
}

export function assistantCostMicros(
  config: AssistantProviderConfig,
  input: number,
  output: number,
  cacheWriteTokens = 0,
) {
  return Math.ceil(
    input * config.inputPrice +
      output * config.outputPrice +
      (config.id === "openai"
        ? cacheWriteTokens * config.inputPrice * 0.25
        : 0),
  );
}

export class HttpAssistantProvider implements AssistantProvider {
  private readonly proxies = new Map<string, ProxyAgent>();
  constructor(private readonly transport: typeof fetch = fetch) {}
  async close() {
    await Promise.all([...this.proxies.values()].map((agent) => agent.close()));
  }
  async complete(
    config: AssistantProviderConfig,
    key: string,
    system: string,
    user: string,
  ): Promise<AssistantCompletion> {
    if (config.requireProxy && !config.proxyUrl)
      throw new DomainError(
        503,
        "Для AI-запросов требуется прокси. Проверьте настройки сервера.",
        "assistant_proxy_required",
      );
    let dispatcher: ProxyAgent | undefined;
    if (config.proxyUrl) {
      try {
        dispatcher = this.proxies.get(config.proxyUrl);
        if (!dispatcher) {
          dispatcher = new ProxyAgent(config.proxyUrl);
          this.proxies.set(config.proxyUrl, dispatcher);
        }
      } catch {
        throw new DomainError(
          503,
          "Проверьте настройки прокси AI-провайдера.",
          "assistant_proxy_configuration_error",
        );
      }
    }
    const openai = config.id === "openai";
    const body = openai
      ? {
          model: config.model,
          store: false,
          reasoning: { effort: "none" },
          max_output_tokens: config.maxOutputTokens,
          instructions: system,
          input: user,
          text: {
            format: {
              type: "json_schema",
              name: "botcrm_assistant",
              strict: true,
              schema: ASSISTANT_SCHEMA,
            },
          },
        }
      : {
          model: config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: config.maxOutputTokens,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "botcrm_assistant",
              strict: true,
              schema: ASSISTANT_SCHEMA,
            },
          },
        };
    let response: Response;
    try {
      response = await this.transport(
        config.baseUrl + (openai ? "/responses" : "/chat/completions"),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
          ...(dispatcher ? { dispatcher } : {}),
        },
      );
    } catch {
      throw new DomainError(
        502,
        "AI-провайдер не ответил вовремя. Автоматический повтор отключён; проверьте расход перед повторной попыткой.",
        "assistant_provider_unavailable",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const message =
        response.status === 401 || response.status === 403
          ? "Проверьте ключ и доступ к модели в настройках помощника."
          : response.status === 429
            ? "Провайдер ограничил запросы или исчерпан его баланс. Автоматических повторов нет."
            : "AI-провайдер отклонил запрос. Проверьте модель и поддержку структурированных ответов.";
      throw new DomainError(502, message, "assistant_provider_rejected");
    }
    // Bound the body independently of Content-Length; never log provider bodies or keys.
    const reader = response.body?.getReader();
    if (!reader)
      throw new DomainError(
        502,
        "Провайдер вернул пустой ответ.",
        "assistant_invalid_result",
      );
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 128_000) throw new Error("size");
        chunks.push(part.value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      throw new DomainError(
        502,
        "Ответ AI-провайдера слишком большой или оборван.",
        "assistant_invalid_result",
      );
    }
    let data: any;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new DomainError(
        502,
        "Провайдер вернул некорректный ответ.",
        "assistant_invalid_result",
      );
    }
    const inputTokens = openai
      ? data.usage?.input_tokens
      : data.usage?.prompt_tokens;
    const outputTokens = openai
      ? data.usage?.output_tokens
      : data.usage?.completion_tokens;
    const cacheWriteTokens = openai
      ? (data.usage?.input_tokens_details?.cache_write_tokens ?? 0)
      : 0;
    if (
      ![inputTokens, outputTokens].every(
        (x) => Number.isSafeInteger(x) && x >= 0,
      ) ||
      (openai && data.status !== "completed")
    )
      throw new DomainError(
        502,
        "Ответ не завершён или провайдер не передал расход токенов.",
        "assistant_invalid_result",
      );
    if (
      !Number.isSafeInteger(cacheWriteTokens) ||
      cacheWriteTokens < 0 ||
      cacheWriteTokens > inputTokens
    )
      throw new DomainError(
        502,
        "Провайдер сообщил некорректный расход кеширования.",
        "assistant_invalid_result",
      );
    const text = openai
      ? data.output
          ?.flatMap((x: any) => (x.type === "message" ? (x.content ?? []) : []))
          .filter((x: any) => x.type === "output_text")
          .map((x: any) => x.text)
          .join("")
      : data.choices?.[0]?.message?.content;
    if (!openai && data.choices?.[0]?.finish_reason !== "stop")
      throw new DomainError(
        502,
        "Провайдер не завершил ответ.",
        "assistant_invalid_result",
      );
    try {
      return {
        value: JSON.parse(text),
        inputTokens,
        outputTokens,
        cacheWriteTokens,
      };
    } catch {
      throw new DomainError(
        502,
        "Помощник не смог подготовить результат. Данные CRM не изменены.",
        "assistant_invalid_result",
      );
    }
  }
}
