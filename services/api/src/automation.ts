import { DomainError } from "./core.js";

export const automationTriggers = [
  "message.received", "message.sent", "contact.updated", "conversation.created",
  "deal.created", "deal.stage_changed", "button.clicked", "conversation.inactive",
  "campaign.delivered", "campaign.failed",
] as const;

export type AutomationTrigger = typeof automationTriggers[number];
export type ConditionOperator = "equals" | "not_equals" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "exists" | "not_exists" | "in";

export interface AutomationCondition {
  field: string;
  operator: ConditionOperator;
  value?: unknown;
}

export interface AutomationConditionTree {
  match: "all" | "any";
  conditions: AutomationCondition[];
}

export type AutomationAction =
  | { type: "set_attribute"; key: string; value: unknown }
  | { type: "add_tag"; tag: string; color?: string }
  | { type: "move_deal"; stage: string }
  | { type: "assign_user"; userId: string }
  | { type: "create_task"; title: string; dueMinutes?: number; userId?: string }
  | { type: "set_control"; mode: "BOT" | "HUMAN" | "PAUSED" }
  | { type: "send_message"; text: string; actor?: "bot" | "operator" }
  | { type: "webhook"; url: string }
  | { type: "suppress_contact"; reason?: string; channel?: string };

export interface AutomationRuleInput {
  name: string;
  enabled?: boolean;
  triggerType: AutomationTrigger;
  conditionTree?: AutomationConditionTree;
  actions: AutomationAction[];
  maxDepth?: number;
}

const operators = new Set<ConditionOperator>(["equals", "not_equals", "contains", "not_contains", "gt", "gte", "lt", "lte", "exists", "not_exists", "in"]);
const actionTypes = new Set<AutomationAction["type"]>(["set_attribute", "add_tag", "move_deal", "assign_user", "create_task", "set_control", "send_message", "webhook", "suppress_contact"]);

export function validateAutomationRule(input: AutomationRuleInput): Required<Pick<AutomationRuleInput, "name" | "enabled" | "triggerType" | "conditionTree" | "actions" | "maxDepth">> {
  const name = String(input?.name ?? "").trim();
  if (name.length < 2 || name.length > 120) throw new DomainError(400, "Automation name must contain 2–120 characters", "invalid_automation_name");
  if (!automationTriggers.includes(input.triggerType)) throw new DomainError(400, "Unsupported automation trigger", "invalid_automation_trigger");
  const conditionTree: AutomationConditionTree = input.conditionTree ?? { match: "all", conditions: [] };
  if (!['all', 'any'].includes(conditionTree.match) || !Array.isArray(conditionTree.conditions) || conditionTree.conditions.length > 20) throw new DomainError(400, "Invalid automation condition tree", "invalid_automation_conditions");
  for (const condition of conditionTree.conditions) {
    if (!condition || !/^[a-zA-Z0-9_.-]{1,100}$/.test(condition.field) || !operators.has(condition.operator)) throw new DomainError(400, "Invalid automation condition", "invalid_automation_condition");
  }
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 10) throw new DomainError(400, "An automation requires 1–10 actions", "invalid_automation_actions");
  for (const action of input.actions) validateAction(action);
  const maxDepth = Math.min(10, Math.max(1, Number(input.maxDepth ?? 5)));
  return { name, enabled: input.enabled !== false, triggerType: input.triggerType, conditionTree, actions: input.actions, maxDepth };
}

function validateAction(action: AutomationAction) {
  if (!action || !actionTypes.has(action.type)) throw new DomainError(400, "Unsupported automation action", "invalid_automation_action");
  if (action.type === "set_attribute" && !/^[a-zA-Z0-9_.-]{1,80}$/.test(action.key)) throw new DomainError(400, "Invalid attribute key", "invalid_automation_action");
  if (action.type === "add_tag" && (!action.tag?.trim() || action.tag.length > 60)) throw new DomainError(400, "Invalid tag", "invalid_automation_action");
  if (action.type === "move_deal" && !action.stage?.trim()) throw new DomainError(400, "Target stage is required", "invalid_automation_action");
  if (action.type === "assign_user" && !isUuid(action.userId)) throw new DomainError(400, "A valid user ID is required", "invalid_automation_action");
  if (action.type === "create_task" && (!action.title?.trim() || action.title.length > 180)) throw new DomainError(400, "Task title is required", "invalid_automation_action");
  if (action.type === "set_control" && !["BOT", "HUMAN", "PAUSED"].includes(action.mode)) throw new DomainError(400, "Invalid control mode", "invalid_automation_action");
  if (action.type === "send_message" && (!action.text?.trim() || action.text.length > 4096)) throw new DomainError(400, "Message text is required", "invalid_automation_action");
  if (action.type === "webhook") {
    let url: URL;
    try { url = new URL(action.url); } catch { throw new DomainError(400, "Webhook URL is invalid", "invalid_automation_action"); }
    if (!["http:", "https:"].includes(url.protocol)) throw new DomainError(400, "Webhook must use HTTP or HTTPS", "invalid_automation_action");
  }
}

export function automationMatches(tree: AutomationConditionTree, context: Record<string, unknown>) {
  if (!tree.conditions.length) return true;
  const results = tree.conditions.map((condition) => conditionMatches(condition, context));
  return tree.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

function conditionMatches(condition: AutomationCondition, context: Record<string, unknown>): boolean {
  const actual = getPath(context, condition.field);
  const expected = condition.value;
  switch (condition.operator) {
    case "exists": return actual !== undefined && actual !== null;
    case "not_exists": return actual === undefined || actual === null;
    case "equals": return comparable(actual) === comparable(expected);
    case "not_equals": return comparable(actual) !== comparable(expected);
    case "contains": return Array.isArray(actual) ? actual.some((value) => comparable(value) === comparable(expected)) : String(actual ?? "").toLocaleLowerCase().includes(String(expected ?? "").toLocaleLowerCase());
    case "not_contains": return !conditionMatches({ ...condition, operator: "contains" }, context);
    case "gt": return Number(actual) > Number(expected);
    case "gte": return Number(actual) >= Number(expected);
    case "lt": return Number(actual) < Number(expected);
    case "lte": return Number(actual) <= Number(expected);
    case "in": return Array.isArray(expected) && expected.some((value) => comparable(value) === comparable(actual));
  }
}

function getPath(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
}

function comparable(value: unknown) {
  if (typeof value === "string") return value.trim().toLocaleLowerCase();
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  return JSON.stringify(value);
}

export function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
