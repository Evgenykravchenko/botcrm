import { DomainError } from "./core.js";

export type SegmentOperator = "equals" | "not_equals" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "exists" | "not_exists" | "in";
export interface SegmentCondition { field: string; operator: SegmentOperator; value?: unknown }
export interface SegmentGroup { operator: "AND" | "OR"; conditions: Array<SegmentCondition | SegmentGroup> }
export interface CompiledSegment { sql: string; params: unknown[] }

const OPERATORS = new Set<SegmentOperator>(["equals", "not_equals", "contains", "not_contains", "gt", "gte", "lt", "lte", "exists", "not_exists", "in"]);
const DIRECT_FIELDS: Record<string, string> = { name: "ct.display_name", phone: "ct.phone", email: "ct.email", city: "ct.city", marketing_status: "ct.marketing_status", updated_at: "ct.updated_at" };

function isGroup(value: SegmentCondition | SegmentGroup): value is SegmentGroup { return "conditions" in value; }
function placeholder(params: unknown[], value: unknown) { params.push(value); return `$${params.length}`; }

export function validateSegmentFilter(input: unknown, depth = 0): SegmentGroup {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError(400, "Segment filter must be a group", "invalid_segment_filter");
  if (depth > 5) throw new DomainError(400, "Segment filter nesting is too deep", "invalid_segment_filter");
  const group = input as Record<string, unknown>; const operator = String(group.operator ?? "AND").toUpperCase();
  if (operator !== "AND" && operator !== "OR") throw new DomainError(400, "Segment group operator must be AND or OR", "invalid_segment_filter");
  if (!Array.isArray(group.conditions) || group.conditions.length > 50) throw new DomainError(400, "Segment group must contain at most 50 conditions", "invalid_segment_filter");
  return { operator, conditions: group.conditions.map((raw) => {
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "conditions" in raw) return validateSegmentFilter(raw, depth + 1);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DomainError(400, "Invalid segment condition", "invalid_segment_filter");
    const item = raw as Record<string, unknown>; const field = String(item.field ?? ""); const conditionOperator = String(item.operator ?? "") as SegmentOperator;
    if (!(field in DIRECT_FIELDS) && !["channel", "tag", "stage", "last_activity"].includes(field) && !/^attributes\.[a-zA-Z0-9_.-]{1,80}$/.test(field)) throw new DomainError(400, `Unsupported segment field ${field}`, "invalid_segment_field");
    if (!OPERATORS.has(conditionOperator)) throw new DomainError(400, `Unsupported segment operator ${conditionOperator}`, "invalid_segment_operator");
    if (conditionOperator === "in" && (!Array.isArray(item.value) || item.value.length > 100)) throw new DomainError(400, "IN requires an array with at most 100 values", "invalid_segment_value");
    return { field, operator: conditionOperator, value: item.value };
  }) };
}

function expressionFor(field: string, params: unknown[]) {
  if (DIRECT_FIELDS[field]) return { expression: DIRECT_FIELDS[field], kind: field === "updated_at" ? "date" : "text" };
  if (field.startsWith("attributes.")) { const key = field.slice(11); const keyPlaceholder = placeholder(params, key); return { expression: `(ct.custom_fields->>${keyPlaceholder})`, kind: "attribute" }; }
  if (field === "last_activity") return { expression: `(select max(c.last_message_at) from conversations c where c.contact_id=ct.id and c.archived_at is null)`, kind: "date" };
  if (field === "channel") return { expression: `(select string_agg(ci.channel,',') from channel_identities ci where ci.contact_id=ct.id)`, kind: "text" };
  if (field === "tag") return { expression: `(select string_agg(t.name,',') from contact_tags ctag join tags t on t.id=ctag.tag_id where ctag.contact_id=ct.id)`, kind: "text" };
  return { expression: `(select string_agg(s.slug,',') from deals d join stages s on s.id=d.stage_id where d.contact_id=ct.id)`, kind: "text" };
}

function compileCondition(condition: SegmentCondition, params: unknown[]) {
  const { expression, kind } = expressionFor(condition.field, params); const operator = condition.operator;
  if (operator === "exists") return `${expression} is not null`;
  if (operator === "not_exists") return `${expression} is null`;
  if (operator === "in") { const value = placeholder(params, (condition.value as unknown[]).map(String)); return `coalesce(${expression}::text,'') = any(${value}::text[])`; }
  if (["gt", "gte", "lt", "lte"].includes(operator)) {
    const comparator = ({ gt: ">", gte: ">=", lt: "<", lte: "<=" } as Record<string, string>)[operator];
    if (kind === "date") { const value = placeholder(params, String(condition.value ?? "")); return `${expression} ${comparator} ${value}::timestamptz`; }
    const value = Number(condition.value); if (!Number.isFinite(value)) throw new DomainError(400, "Numeric comparison requires a number", "invalid_segment_value"); const parameter = placeholder(params, value);
    return `(case when ${expression} ~ '^-?[0-9]+([.][0-9]+)?$' then ${expression}::numeric end) ${comparator} ${parameter}::numeric`;
  }
  const value = placeholder(params, String(condition.value ?? "").toLowerCase());
  if (operator === "equals") return `lower(coalesce(${expression}::text,'')) = ${value}`;
  if (operator === "not_equals") return `lower(coalesce(${expression}::text,'')) <> ${value}`;
  if (operator === "contains") return `lower(coalesce(${expression}::text,'')) like '%' || ${value} || '%'`;
  return `lower(coalesce(${expression}::text,'')) not like '%' || ${value} || '%'`;
}

export function compileSegmentFilter(input: unknown, initialParams: unknown[] = []): CompiledSegment {
  const params = [...initialParams]; const filter = validateSegmentFilter(input);
  const compileGroup = (group: SegmentGroup): string => {
    if (!group.conditions.length) return "true";
    return `(${group.conditions.map((item) => isGroup(item) ? compileGroup(item) : compileCondition(item, params)).join(` ${group.operator} `)})`;
  };
  return { sql: compileGroup(filter), params };
}
