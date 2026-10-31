import { DomainError } from "./core.js";
import type { KeywordReplyInput } from "./content-platform.js";

export const ASSISTANT_SECTIONS = [
  "inbox",
  "contacts",
  "pipeline",
  "campaigns",
  "keywordReplies",
  "automations",
  "integrations",
  "analytics",
  "settings",
] as const;
export type AssistantSection = (typeof ASSISTANT_SECTIONS)[number];
export interface AssistantInput {
  requestId: string;
  message: string;
  section: AssistantSection;
  botSlug?: string;
  conversationId?: string;
  includeConversation?: boolean;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
}
export interface AssistantContext {
  canManageContent: boolean;
  botSlug?: string;
  botName?: string;
  media: Array<{
    id: number;
    name: string;
    kind: "photo" | "video" | "audio" | "document";
    ready: boolean;
  }>;
  conversation?: {
    id: string;
    contactId: string;
    name: string;
    messages: Array<{ direction: string; text: string }>;
  };
}
export interface AssistantResult {
  requestId: string;
  text: string;
  navigateTo?: AssistantSection;
  keywordDraft?: { botSlug: string; input: KeywordReplyInput };
  replyDraft?: { conversationId: string; text: string };
  taskDraft?: { contactId: string; title: string; dueAt?: string };
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = { type: "string" };
export const ASSISTANT_SCHEMA = object({
  text: str,
  navigateTo: { type: ["string", "null"], enum: [...ASSISTANT_SECTIONS, null] },
  keyword: {
    anyOf: [
      { type: "null" },
      object({
        name: str,
        phrase: str,
        matchMode: {
          type: "string",
          enum: ["exact", "contains", "any_word", "all_words"],
        },
        text: str,
        mediaIds: { type: "array", items: { type: "integer" } },
        buttons: {
          type: "array",
          items: object({
            label: str,
            action: { type: "string", enum: ["text", "open_link"] },
            target: str,
          }),
        },
      }),
    ],
  },
  reply: { type: ["string", "null"] },
  task: {
    anyOf: [
      { type: "null" },
      object({ title: str, dueAt: { type: ["string", "null"] } }),
    ],
  },
});

function invalid(): never {
  throw new DomainError(
    502,
    "Помощник вернул некорректный результат. Данные CRM не изменены.",
    "assistant_invalid_result",
  );
}
function bounded(value: unknown, max: number, required = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    return invalid();
  return value.trim();
}
export function validateAssistantInput(input: AssistantInput) {
  if (
    !input ||
    typeof input !== "object" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.requestId || "",
    ) ||
    typeof input.message !== "string" ||
    !input.message.trim() ||
    input.message.length > 4000 ||
    !ASSISTANT_SECTIONS.includes(input.section)
  )
    throw new DomainError(
      400,
      "Напишите запрос длиной до 4000 символов.",
      "assistant_invalid_input",
    );
  if (input.botSlug !== undefined && !/^[a-z0-9_]{1,128}$/.test(input.botSlug))
    throw new DomainError(
      400,
      "Выберите бота из списка.",
      "assistant_invalid_input",
    );
  if (
    input.conversationId !== undefined &&
    !/^[a-zA-Z0-9_-]{1,128}$/.test(input.conversationId)
  )
    throw new DomainError(
      400,
      "Некорректный диалог.",
      "assistant_invalid_input",
    );
  if (
    input.includeConversation !== undefined &&
    typeof input.includeConversation !== "boolean"
  )
    throw new DomainError(
      400,
      "Некорректная настройка контекста.",
      "assistant_invalid_input",
    );
  if (
    input.history !== undefined &&
    (!Array.isArray(input.history) ||
      input.history.length > 6 ||
      input.history.some(
        (x) =>
          !x ||
          !["user", "assistant"].includes(x.role) ||
          typeof x.text !== "string" ||
          x.text.length > 2000,
      ))
  )
    throw new DomainError(
      400,
      "История чата слишком длинная. Начните новый разговор.",
      "assistant_invalid_input",
    );
  return input;
}

export function redactAssistantSecrets(text: string) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[секрет скрыт]")
    .replace(
      /\b(?:vk1\.[A-Za-z0-9_.-]{20,}|y0__[A-Za-z0-9_-]{20,}|\d{8,12}:[A-Za-z0-9_-]{30,})/g,
      "[секрет скрыт]",
    );
}

export function parseAssistantResult(
  raw: unknown,
  context: AssistantContext,
  requestId: string,
): Omit<AssistantResult, "usage"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>;
  const result: Omit<AssistantResult, "usage"> = {
    requestId,
    text: redactAssistantSecrets(bounded(value.text, 6000, true)),
  };
  if (value.navigateTo != null) {
    if (!ASSISTANT_SECTIONS.includes(value.navigateTo as AssistantSection))
      return invalid();
    result.navigateTo = value.navigateTo as AssistantSection;
  }
  if (value.keyword != null) {
    if (
      !context.canManageContent ||
      !context.botSlug ||
      typeof value.keyword !== "object" ||
      Array.isArray(value.keyword)
    )
      return invalid();
    const draft = value.keyword as Record<string, unknown>;
    const name = bounded(draft.name, 200, true),
      phrase = bounded(draft.phrase, 255, true),
      text = bounded(draft.text, 4000);
    if (
      !["exact", "contains", "any_word", "all_words"].includes(
        String(draft.matchMode),
      ) ||
      !Array.isArray(draft.mediaIds) ||
      draft.mediaIds.length > 10 ||
      !Array.isArray(draft.buttons) ||
      draft.buttons.length > 5
    )
      return invalid();
    const media = draft.mediaIds.map((id) => {
      const item = context.media.find(
        (m) => Number.isSafeInteger(id) && m.id === id && m.ready,
      );
      if (!item) return invalid();
      return item;
    });
    if (
      new Set(media.map((m) => m.id)).size !== media.length ||
      (!text && !media.length)
    )
      return invalid();
    const buttons = draft.buttons.map((item, index) => {
      if (!item || typeof item !== "object") return invalid();
      const label = bounded(item.label, 40, true),
        target = bounded(item.target, 1000, true);
      if (!["text", "open_link"].includes(item.action)) return invalid();
      if (item.action === "open_link") {
        let url: URL;
        try {
          url = new URL(target);
        } catch {
          return invalid();
        }
        if (url.protocol !== "https:" || url.username || url.password)
          return invalid();
      }
      return {
        label,
        target,
        action: item.action as "text" | "open_link",
        color: "secondary" as const,
        row: index + 1,
        sort: index,
        enabled: true,
      };
    });
    result.keywordDraft = {
      botSlug: context.botSlug,
      input: {
        phrase,
        matchMode: draft.matchMode as KeywordReplyInput["matchMode"],
        priority: 0,
        enabled: true,
        response: {
          name,
          status: "draft",
          fallbackText: "",
          blocks: [
            ...(text
              ? [
                  {
                    kind: "text" as const,
                    body: text,
                    sort: 0,
                    sendSeparately: false,
                    enabled: true,
                  },
                ]
              : []),
            ...media.map((m, i) => ({
              kind: m.kind,
              mediaId: m.id,
              body: "",
              sort: i + 1,
              sendSeparately: false,
              enabled: true,
            })),
          ],
          buttons,
        },
      },
    };
  }
  if (value.reply != null) {
    if (!context.conversation) return invalid();
    result.replyDraft = {
      conversationId: context.conversation.id,
      text: bounded(value.reply, 4000, true),
    };
  }
  if (value.task != null) {
    if (!context.conversation || typeof value.task !== "object")
      return invalid();
    const task = value.task as Record<string, unknown>;
    const dueAt =
      task.dueAt === null ? undefined : bounded(task.dueAt, 40, true);
    if (
      dueAt &&
      (!Number.isFinite(Date.parse(dueAt)) ||
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(dueAt))
    )
      return invalid();
    result.taskDraft = {
      contactId: context.conversation.contactId,
      title: bounded(task.title, 200, true),
      ...(dueAt ? { dueAt } : {}),
    };
  }
  return result;
}
