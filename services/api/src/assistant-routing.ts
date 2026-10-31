import type { AssistantInput, AssistantResult } from "./assistant-contract.js";
import {
  findAssistantArticles,
  normalizedAssistantText,
} from "./assistant-knowledge.js";

export const ASSISTANT_SCOPE_MESSAGE =
  "Помогаю только с BotCRM: диалогами, контактами, воронками, рассылками, автоответами, автоматизациями, подключениями, аналитикой и настройками. Опишите, что хотите сделать в платформе.";
export type AssistantAction = "keyword" | "reply" | "task" | "summary";
type Route =
  | { action: AssistantAction }
  | { local: Omit<AssistantResult, "usage"> };

export function routeAssistantRequest(input: AssistantInput): Route {
  const q = normalizedAssistantText(input.message);
  const local = (
    text: string,
    navigateTo?: AssistantResult["navigateTo"],
  ): Route => ({
    local: {
      requestId: input.requestId,
      text,
      ...(navigateTo ? { navigateTo } : {}),
    },
  });
  // Only content tasks reach a model. Documentation and unrelated requests are local.
  if (
    /(?:игнорируй|забудь|обойди).{0,45}(?:инструкц|правил|ограничен)|(?:system|developer) prompt|ты теперь|притворись|покажи.{0,30}(?:секрет|api.?ключ|пароль)/.test(
      q,
    )
  )
    return local(ASSISTANT_SCOPE_MESSAGE);
  const isQuestion =
    /^(?:а )?(?:как|где|когда|кто|сколько|почему|зачем|что|какой|какая|какое|какие|чем|расскажи|объясни|можно ли)(?:\s|$)/u.test(
      q,
    );
  const contentTask =
    /(?:подготов|созда|сдела|собер|напиш|состав|придума|добав|измени|поменя|обнов|убер|убери|удал|прикреп|замени|перепиши|сократи|оставь|сохран|настрой|исправ|отвечай|ответь|выдавай|присылай|хочу|нужен)/.test(
      q,
    );
  const keywordSubject =
    /(?:автоответ|ключев|на слово|на фразу)|(?:^| )на .{1,100} (?:отвечай|ответь|выдавай|присылай)/.test(
      q,
    );
  const draftEdit =
    !!input.draft &&
    !isQuestion &&
    (contentTask ||
      /кнопк|ссылк|на сайт|google|гугл/.test(q) ||
      /^(?:а )?(?:любую? прост|любую?|простую?|еще раз|повтори|без (?:кноп|фото|видео)|да(?: |$)|https:\/\/)/.test(
        q,
      ));
  const continuation =
    input.continueKeyword === true && !isQuestion && q.length <= 300;
  if (
    !isQuestion &&
    ((contentTask && keywordSubject) || draftEdit || continuation)
  ) {
    if (!input.botSlug)
      return local(
        "Выберите бота в списке «Бот для автоответов», затем опишите ответ.",
      );
    return { action: "keyword" };
  }
  if (!isQuestion && input.includeConversation && input.conversationId) {
    if (/(?:задач|напомин)/.test(q) && contentTask) return { action: "task" };
    if (/(?:сводк|перескаж|резюм|итог|суммир)/.test(q))
      return { action: "summary" };
    if (
      /(?:ответ|клиент|сообщени)/.test(q) &&
      (contentTask || /ответь|предложи/.test(q))
    )
      return { action: "reply" };
  }
  if (
    !isQuestion &&
    /(?:добав|сдела|прикреп|убер|удал|измени)/.test(q) &&
    /кноп|фото|видео|ссылк/.test(q) &&
    !input.draft
  )
    return local(
      "Сначала подготовим автоответ. Например: «На слово “привет” отвечай “Здравствуйте!”». Затем можно попросить добавить кнопку или файл.",
      "keywordReplies",
    );
  const previous =
    input.history
      ?.slice(-2)
      .map((t) => t.text)
      .join(" ") || "";
  const articles = findAssistantArticles(
    input.message,
    input.section,
    previous,
  );
  if (articles.length)
    return local(
      articles.map((a) => `${a.title}\n${a.body}`).join("\n\n"),
      articles[0].section,
    );
  return local(ASSISTANT_SCOPE_MESSAGE);
}
