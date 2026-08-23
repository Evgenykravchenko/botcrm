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

  const source = String(template ?? "");
  const output: string[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const opening = source.indexOf("{{", cursor);
    if (opening < 0) {
      output.push(source.slice(cursor));
      break;
    }

    output.push(source.slice(cursor, opening));
    const closing = source.indexOf("}}", opening + 2);
    if (closing < 0) {
      output.push(source.slice(opening));
      break;
    }

    const expression = source.slice(opening + 2, closing);
    if (expression.includes("{") || expression.includes("}")) {
      output.push(source.slice(opening, closing + 2));
      cursor = closing + 2;
      continue;
    }

    const fallbackSeparator = expression.indexOf("|");
    const rawPath = fallbackSeparator < 0 ? expression : expression.slice(0, fallbackSeparator);
    const rawFallback = fallbackSeparator < 0 ? undefined : expression.slice(fallbackSeparator + 1);
    const path = rawPath.trim();
    if (!path) {
      output.push(source.slice(opening, closing + 2));
    } else {
      const value = printable(readPath(context, path));
      output.push(value ?? rawFallback?.trim() ?? "");
    }
    cursor = closing + 2;
  }

  return output.join("");
}
