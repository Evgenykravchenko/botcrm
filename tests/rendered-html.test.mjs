import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the protected BotCRM bootstrap shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>BotCRM/);
  assert.match(html, /auth-shell/);
  assert.match(html, /Подключаем BotCRM/);
  assert.match(html, /bot-crm-[A-Za-z0-9_-]+\.js/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton|Runtime Error/i);
});

test("client application contains every required product area and security surface", async () => {
  const source = await Promise.all(["../app/bot-crm.tsx", "../app/inbox-view.tsx"].map((file) => readFile(new URL(file, import.meta.url), "utf8"))).then((parts) => parts.join("\n"));
  for (const text of ["Диалоги", "Контакты", "Воронки", "Рассылки", "Автоматизации", "Боты и каналы", "Аналитика", "Настройки", "Переменные бота", "Безопасный вход", "Сервисные токены", "Рабочие команды"]) assert.match(source, new RegExp(text));
});