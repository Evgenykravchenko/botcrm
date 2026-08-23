import { DomainError } from "./core.js";

export type ContactTransferRow = {
  displayName: string;
  phone?: string;
  email?: string;
  city?: string;
  tags: string[];
  attributes: Record<string, unknown>;
};

function csvRows(source: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted && char === '"' && source[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") { row.push(value); value = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(value); value = "";
      if (row.some((cell) => cell.length)) rows.push(row);
      row = [];
    } else value += char;
  }
  row.push(value);
  if (row.some((cell) => cell.length)) rows.push(row);
  if (quoted) throw new DomainError(400, "CSV contains an unclosed quote", "invalid_contact_import");
  return rows;
}

function normalize(input: Record<string, unknown>, index: number): ContactTransferRow {
  const displayName = String(input.displayName ?? input.name ?? input["Имя"] ?? "").trim();
  if (displayName.length < 2) throw new DomainError(400, `Row ${index}: contact name is required`, "invalid_contact_import_row");
  let attributes: Record<string, unknown> = {};
  const rawAttributes = input.attributes ?? input.variables;
  if (typeof rawAttributes === "string" && rawAttributes.trim()) {
    try { attributes = JSON.parse(rawAttributes); } catch { throw new DomainError(400, `Row ${index}: attributes must be valid JSON`, "invalid_contact_import_row"); }
  } else if (rawAttributes && typeof rawAttributes === "object" && !Array.isArray(rawAttributes)) attributes = rawAttributes as Record<string, unknown>;
  const rawTags = input.tags;
  const tags = Array.isArray(rawTags) ? rawTags.map(String) : String(rawTags ?? "").split(/[;,]/);
  return {
    displayName,
    phone: String(input.phone ?? input["Телефон"] ?? "").trim() || undefined,
    email: String(input.email ?? "").trim() || undefined,
    city: String(input.city ?? input["Город"] ?? "").trim() || undefined,
    tags: tags.map((tag) => tag.trim()).filter(Boolean),
    attributes,
  };
}

export function parseContactImport(format: "csv" | "json", content: string) {
  if (Buffer.byteLength(content, "utf8") > 10 * 1024 * 1024) throw new DomainError(413, "Import file is larger than 10 MB", "contact_import_too_large");
  let source: Array<Record<string, unknown>>;
  if (format === "json") {
    let parsed: unknown;
    try { parsed = JSON.parse(content.replace(/^\uFEFF/, "")); } catch { throw new DomainError(400, "Import is not valid JSON", "invalid_contact_import"); }
    if (!Array.isArray(parsed)) throw new DomainError(400, "JSON import must contain an array", "invalid_contact_import");
    source = parsed as Array<Record<string, unknown>>;
  } else {
    const rows = csvRows(content.replace(/^\uFEFF/, ""));
    const headers = rows.shift()?.map((header) => header.trim()) ?? [];
    if (!headers.length) throw new DomainError(400, "CSV header is missing", "invalid_contact_import");
    source = rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
  }
  if (source.length > 10_000) throw new DomainError(413, "Import is limited to 10000 contacts", "contact_import_too_large");
  return source.map((row, index) => normalize(row, index + 2));
}

function quote(value: unknown) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportContacts(format: "csv" | "json", contacts: Array<Record<string, any>>) {
  const rows = contacts.map((contact) => ({
    displayName: contact.displayName,
    phone: contact.phone ?? "",
    email: contact.email ?? "",
    city: contact.city ?? "",
    tags: (contact.tags ?? []).join(";"),
    marketingStatus: contact.marketingStatus ?? "",
    attributes: contact.attributes ?? {},
  }));
  if (format === "json") return JSON.stringify(rows, null, 2);
  const headers = ["displayName", "phone", "email", "city", "tags", "marketingStatus", "attributes"];
  return `\uFEFF${headers.join(",")}\r\n${rows.map((row) => headers.map((header) => quote(header === "attributes" ? JSON.stringify(row.attributes) : row[header as keyof typeof row])).join(",")).join("\r\n")}`;
}
