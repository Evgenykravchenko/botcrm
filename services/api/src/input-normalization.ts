export function normalizeBotSlug(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "_") start += 1;
  while (end > start && normalized[end - 1] === "_") end -= 1;
  return normalized.slice(start, end);
}

export function isSafeWebhookChallenge(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUppercase = code >= 65 && code <= 90;
    const isLowercase = code >= 97 && code <= 122;
    if (!isDigit && !isUppercase && !isLowercase && !"._~-".includes(character)) return false;
  }
  return true;
}
