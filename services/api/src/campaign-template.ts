export type CampaignTemplateContact = {
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  attributes?: Record<string, unknown> | null;
};

function printable(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(source, path)) return source[path];
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

export function renderCampaignTemplate(template: string, contact: CampaignTemplateContact) {
  const attributes = contact.attributes && typeof contact.attributes === "object" && !Array.isArray(contact.attributes) ? contact.attributes : {};
  const displayName = printable(contact.displayName) ?? "";
  const nameParts = displayName.split(/\s+/).filter(Boolean);
  const firstName = printable(attributes.first_name) ?? printable(attributes.firstName) ?? nameParts[0] ?? "";
  const lastName = printable(attributes.last_name) ?? printable(attributes.lastName) ?? nameParts.slice(1).join(" ");
  const context: Record<string, unknown> = {
    ...attributes,
    attributes,
    first_name: firstName,
    firstName,
    last_name: lastName,
    lastName,
    full_name: displayName,
    display_name: displayName,
    name: displayName,
    email: contact.email,
    phone: contact.phone,
    city: contact.city,
  };

  return String(template ?? "").replace(/\{\{\s*([^{}|]+?)(?:\s*\|\s*([^{}]*?))?\s*\}\}/g, (_match, rawPath: string, rawFallback?: string) => {
    const value = printable(readPath(context, rawPath.trim()));
    return value ?? rawFallback?.trim() ?? "";
  });
}
