import { DomainError } from "./core.js";

export const ATTRIBUTE_SCOPES = ["CONTACT", "CONVERSATION", "DEAL", "CONTACT_BOT"] as const;
export const ATTRIBUTE_VALUE_TYPES = ["STRING", "NUMBER", "BOOLEAN", "DATE", "ENUM", "MULTISELECT", "URL", "JSON"] as const;
export const ATTRIBUTE_AUTHORITIES = ["PLATFORM", "BOT"] as const;

export type AttributeScope = typeof ATTRIBUTE_SCOPES[number];
export type AttributeValueType = typeof ATTRIBUTE_VALUE_TYPES[number];
export type AttributeAuthority = typeof ATTRIBUTE_AUTHORITIES[number];

export interface AttributeDefinitionInput {
  objectScope?: AttributeScope;
  key?: string;
  label?: string;
  valueType?: AttributeValueType;
  authority?: AttributeAuthority;
  config?: Record<string, unknown>;
  filterable?: boolean;
}

const ATTRIBUTE_LABELS_RU: Record<string, string> = {
  funnel_hint: "Рекомендуемый этап воронки",
  intent: "Намерение клиента",
  last_bot_command: "Последняя команда боту",
  lead_score: "Оценка интереса",
  lifecycle: "Статус клиента",
  needs_human: "Нужен оператор",
  payment_status: "Статус оплаты",
  plan: "Тариф",
  priority: "Приоритет",
  qualified: "Квалифицирован",
  requested_plan: "Запрошенный тариф",
  risk_level: "Уровень риска",
  score: "Оценка",
  segment_test_key: "Тестовый признак сегмента",
  source: "Источник",
  source_key: "Ключ источника",
  support_requested: "Запрошена поддержка",
  telegram_chat_type: "Тип чата Telegram",
  telegram_language: "Язык Telegram",
  telegram_username: "Имя пользователя Telegram",
  test_scenario: "Тестовый сценарий",
  topic: "Тема обращения",
};

export function inferAttributeValueType(value: unknown): AttributeValueType {
  if (typeof value === "number" && Number.isFinite(value)) return "NUMBER";
  if (typeof value === "boolean") return "BOOLEAN";
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return "MULTISELECT";
  if (typeof value === "object" && value !== null) return "JSON";
  return "STRING";
}

export function humanizeAttributeKey(key: string) {
  const translated = ATTRIBUTE_LABELS_RU[key.toLowerCase()];
  if (translated) return translated;
  const value = key.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : key;
}

export function validateAttributeDefinition(input: AttributeDefinitionInput, partial = false): AttributeDefinitionInput {
  const result: AttributeDefinitionInput = {};
  if (!partial || input.objectScope !== undefined) {
    if (!ATTRIBUTE_SCOPES.includes(input.objectScope as AttributeScope)) throw new DomainError(400, "Attribute scope is invalid", "invalid_attribute_scope");
    result.objectScope = input.objectScope;
  }
  if (!partial || input.key !== undefined) {
    const key = String(input.key ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(key)) throw new DomainError(400, "Attribute key must contain only letters, digits, dot, dash or underscore", "invalid_attribute_key");
    result.key = key;
  }
  if (!partial || input.label !== undefined) {
    const label = String(input.label ?? "").trim();
    if (!label || label.length > 100) throw new DomainError(400, "Attribute label is required and must be at most 100 characters", "invalid_attribute_label");
    result.label = label;
  }
  if (!partial || input.valueType !== undefined) {
    if (!ATTRIBUTE_VALUE_TYPES.includes(input.valueType as AttributeValueType)) throw new DomainError(400, "Attribute value type is invalid", "invalid_attribute_type");
    result.valueType = input.valueType;
  }
  if (!partial || input.authority !== undefined) {
    if (!ATTRIBUTE_AUTHORITIES.includes(input.authority as AttributeAuthority)) throw new DomainError(400, "Attribute authority is invalid", "invalid_attribute_authority");
    result.authority = input.authority;
  }
  if (input.config !== undefined) {
    if (!input.config || Array.isArray(input.config) || typeof input.config !== "object") throw new DomainError(400, "Attribute config must be an object", "invalid_attribute_config");
    result.config = input.config;
  }
  if (input.filterable !== undefined) result.filterable = Boolean(input.filterable);
  return result;
}
