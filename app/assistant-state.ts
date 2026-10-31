import type { ApiAssistantInput, ApiAssistantResult } from "./api-client";

export function assistantHistory(
  turns: Array<{
    role: "user" | "assistant";
    text: string;
    failed?: boolean;
    result?: ApiAssistantResult;
  }>,
): NonNullable<ApiAssistantInput["history"]> {
  return turns
    .filter((t) => !t.failed && t.result?.origin !== "knowledge")
    .slice(-6)
    .map((t) => ({ role: t.role, text: t.text.slice(0, 700) }));
}

export function assistantDraft(
  result: ApiAssistantResult,
): ApiAssistantInput["draft"] {
  const input = result.keywordDraft?.input;
  if (!input) return undefined;
  return {
    name: input.response.name,
    phrase: input.phrase,
    matchMode: input.matchMode ?? "exact",
    text: (input.response.blocks ?? [])
      .filter((b) => b.kind === "text")
      .map((b) => b.body ?? "")
      .join("\n\n"),
    mediaIds: (input.response.blocks ?? [])
      .filter((b) => b.kind !== "text" && b.mediaId != null)
      .map((b) => Number(b.mediaId)),
    buttons: (input.response.buttons ?? []).map((b) => ({
      label: b.label,
      action: b.action,
      target: b.target,
    })),
  };
}
