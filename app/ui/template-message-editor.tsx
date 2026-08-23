"use client";

import { KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Braces, Search } from "lucide-react";

export type TemplateVariable = {
  key: string;
  token: string;
  label: string;
  description: string;
  example?: string;
  tone?: "violet" | "blue" | "green" | "orange" | "pink";
};

function caretOffset(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return root.textContent?.length ?? 0;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return root.textContent?.length ?? 0;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function placeCaret(root: HTMLElement, offset: number) {
  const range = document.createRange();
  const selection = window.getSelection();
  let remaining = Math.max(0, offset);
  let placed = false;
  const visit = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (placed) return;
      const length = child.textContent?.length ?? 0;
      if (child.nodeType === Node.TEXT_NODE) {
        if (remaining <= length) {
          range.setStart(child, remaining);
          placed = true;
          return;
        }
        remaining -= length;
        continue;
      }
      if (child instanceof HTMLElement && child.dataset.templateToken) {
        if (remaining <= length) {
          remaining === 0 ? range.setStartBefore(child) : range.setStartAfter(child);
          placed = true;
          return;
        }
        remaining -= length;
        continue;
      }
      visit(child);
    }
  };
  visit(root);
  if (!placed) {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function variableKey(token: string) {
  return token.slice(2, -2).split("|")[0]?.trim() ?? "";
}

export function TemplateMessageEditor({ value, onChange, variables, placeholder = "Введите сообщение…" }: { value: string; onChange: (value: string) => void; variables: TemplateVariable[]; placeholder?: string }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [queryStart, setQueryStart] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const suggestions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ru");
    const items = normalized ? variables.filter((variable) => `${variable.key} ${variable.label} ${variable.description}`.toLocaleLowerCase("ru").includes(normalized)) : variables;
    return normalized ? items.slice(0, 10) : items;
  }, [query, variables]);

  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    const shouldRestore = document.activeElement === root || pendingCaret.current !== null;
    const restoreAt = pendingCaret.current ?? caretOffset(root);
    const fragment = document.createDocumentFragment();
    const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
    let index = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value))) {
      if (match.index > index) fragment.append(document.createTextNode(value.slice(index, match.index)));
      const key = variableKey(match[0]);
      const variable = variables.find((item) => item.key === key);
      const badge = document.createElement("span");
      badge.className = `template-token ${variable?.tone ?? "violet"}`;
      badge.dataset.templateToken = key;
      badge.dataset.tooltip = variable ? `${variable.label} — ${variable.description}${variable.example ? ` · Пример: ${variable.example}` : ""}` : `Переменная ${key}`;
      badge.contentEditable = "false";
      badge.textContent = match[0];
      fragment.append(badge);
      index = match.index + match[0].length;
    }
    if (index < value.length) fragment.append(document.createTextNode(value.slice(index)));
    root.replaceChildren(fragment);
    if (shouldRestore) placeCaret(root, restoreAt);
    pendingCaret.current = null;
  }, [value, variables]);

  function updateAutocomplete(text: string, caret: number) {
    const before = text.slice(0, caret);
    const start = before.lastIndexOf("{{");
    const closed = before.lastIndexOf("}}");
    const candidate = start > closed ? before.slice(start + 2) : "";
    if (start > closed && /^[\p{L}\p{N}_.-]*$/u.test(candidate)) {
      setQueryStart(start);
      setQuery(candidate);
      setActiveIndex(0);
      setOpen(true);
    } else if (queryStart !== null) {
      setQueryStart(null);
      setQuery("");
      setOpen(false);
    }
  }

  function syncFromEditor() {
    const root = editorRef.current;
    if (!root) return;
    const text = root.textContent ?? "";
    const caret = caretOffset(root);
    pendingCaret.current = caret;
    onChange(text);
    updateAutocomplete(text, caret);
  }

  function insertText(text: string) {
    const root = editorRef.current;
    const selection = window.getSelection();
    if (!root || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer)) return;
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    syncFromEditor();
  }

  function chooseVariable(variable: TemplateVariable) {
    const root = editorRef.current;
    if (!root) return;
    const current = root.textContent ?? value;
    const caret = caretOffset(root);
    const start = queryStart ?? caret;
    const next = `${current.slice(0, start)}${variable.token}${current.slice(caret)}`;
    pendingCaret.current = start + variable.token.length;
    onChange(next);
    setOpen(false);
    setQuery("");
    setQueryStart(null);
    requestAnimationFrame(() => editorRef.current?.focus());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (open && suggestions.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setActiveIndex((index) => event.key === "ArrowDown" ? (index + 1) % suggestions.length : (index - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (open && suggestions.length && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      chooseVariable(suggestions[activeIndex] ?? suggestions[0]);
      return;
    }
    if (open && event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setQueryStart(null);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      insertText("\n");
    }
  }

  return <div className="template-editor-shell">
    <div className="template-editor-toolbar">
      <span>Сообщение</span>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { setQueryStart(null); setQuery(""); setActiveIndex(0); setOpen((visible) => !visible); }}><Braces size={14} />Переменные</button>
    </div>
    <div ref={editorRef} className="template-editor" contentEditable role="textbox" aria-label="Сообщение" aria-multiline="true" data-placeholder={placeholder} suppressContentEditableWarning onInput={syncFromEditor} onKeyDown={handleKeyDown} onPaste={(event) => { event.preventDefault(); insertText(event.clipboardData.getData("text/plain")); }} onBlur={() => window.setTimeout(() => setOpen(false), 120)} />
    {open && <div className="template-suggestions" role="listbox" aria-label="Доступные переменные">
      <header><Search size={14} /><span>{query ? `Подходящие переменные: ${query}` : "Выберите переменную"}</span><em>{suggestions.length}</em></header>
      <div>{suggestions.map((variable, index) => <button type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? "active" : ""} key={variable.key} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={() => chooseVariable(variable)}><code className={`template-token ${variable.tone ?? "violet"}`}>{variable.token}</code><span><b>{variable.label}</b><small>{variable.description}{variable.example ? ` · Например: ${variable.example}` : ""}</small></span></button>)}{!suggestions.length && <p>Ничего не найдено. Проверьте название переменной.</p>}</div>
    </div>}
    <small className="template-editor-help">Введите <code>{"{{"}</code>, чтобы открыть автоподсказку. Стрелки — выбор, Enter — вставка.</small>
  </div>;
}
