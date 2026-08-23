export type TestBotScenario = {
  reply: string;
  attributes: Record<string, unknown>;
  handoff?: boolean;
};

export function commandOf(text: string) {
  return text.trim().split(/\s+/, 1)[0]?.toLowerCase().replace(/@[^\s]+$/, "") ?? "";
}

export function scenarioFor(text: string, source: string): TestBotScenario {
  const command = commandOf(text);
  const normalized = text.toLowerCase();
  if (command === "/buy" || /купить|оплат|заказ/.test(normalized)) {
    return {
      reply: "Отлично — зафиксировал высокий интерес. В BotCRM у контакта появились lead_score=95, intent=purchase и requested_plan=pro. Теперь создайте сделку или проверьте автоматизацию.",
      attributes: { lead_score: 95, intent: "purchase", requested_plan: "pro", funnel_hint: "qualification", test_scenario: "hot_lead" },
    };
  }
  if (command === "/price" || /цен|стоим|тариф/.test(normalized)) {
    return {
      reply: "Тестовый тариф Pro стоит 4 900 ₽ в месяц. Я записал интерес к цене и lead_score=70 — эти поля можно увидеть в карточке контакта и использовать в фильтрах.",
      attributes: { lead_score: 70, topic: "pricing", requested_plan: "pro", test_scenario: "pricing" },
    };
  }
  if (command === "/support" || /ошиб|проблем|поддерж/.test(normalized)) {
    return {
      reply: "Обращение отмечено как поддержка и передано оператору. Бот больше не будет отвечать, пока оператор не вернёт ему управление. В панели можно ответить клиенту, а заметку и задачу добавить отдельно для проверки CRM.",
      attributes: { lead_score: 35, topic: "support", priority: "normal", needs_human: true, test_scenario: "support" },
      handoff: true,
    };
  }
  if (command === "/status") {
    return {
      reply: "Сейчас диалог находится под управлением бота. Если нажать «Забрать у бота», следующие сообщения сохранятся в CRM, но автоматического ответа уже не будет.",
      attributes: { last_status_check_at: new Date().toISOString(), test_scenario: "control" },
    };
  }
  if (command === "/help") {
    return {
      reply: "Команды для проверки:\n/start — новый контакт\n/price — переменные и средний lead score\n/buy — горячий лид\n/support — обращение в поддержку\n/status — проверка перехвата\n/help — эта подсказка",
      attributes: { test_scenario: "help" },
    };
  }
  if (command === "/start") {
    return {
      reply: "Привет! Я тестовый бот BotCRM. Напишите /price, /buy или /support. Все сообщения и переменные должны появиться в панели.",
      attributes: { lead_score: 20, source, lifecycle: "new", test_scenario: "onboarding" },
    };
  }
  return {
    reply: `Получил: «${text.slice(0, 240)}». Сообщение сохранено в BotCRM. Для проверки сценариев используйте /price, /buy, /support или /status.`,
    attributes: { source, last_intent: "free_text", test_scenario: "echo" },
  };
}
