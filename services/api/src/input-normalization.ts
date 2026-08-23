export function normalizeBotSlug(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "_") start += 1;
  while (end > start && normalized[end - 1] === "_") end -= 1;
  return normalized.slice(start, end);
}

export function parseWebhookChallenge(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 15) return undefined;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    if (!isDigit) return undefined;
  }
  const challenge = Number(value);
  if (!Number.isSafeInteger(challenge) || String(challenge) !== value) return undefined;
  return challenge;
}
