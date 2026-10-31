import type { AssistantKeywordDraft } from "./assistant-contract.js";
import { normalizedAssistantText } from "./assistant-knowledge.js";

// Common edits are deterministic: no paid request and no regenerated fields.
export function editAssistantDraft(
  message: string,
  current: AssistantKeywordDraft,
): AssistantKeywordDraft | undefined {
  const q = normalizedAssistantText(message);
  // A compound request must reach composition; editing only its button would
  // silently discard a requested change to the answer itself.
  if (
    /автоответ|на слово|на фразу|(?:текст|фото|видео|файл|картин|медиа|сообщени|фраз)[а-я]*/.test(
      q.replace(/(?:текстом|текст)\s+[«"“][^»"”]+[»"”]/g, ""),
    )
  )
    return undefined;
  if (/(?:убери|удали|без).{0,15}кноп/.test(q))
    return { ...current, buttons: [] };
  if (!/кноп|ссылк|google|гугл|^https:\/\/|любую|простую/.test(q))
    return undefined;
  const supplied = message.match(/https:\/\/[^\s<>"«»]+/i)?.[0];
  const google = /google|гугл/.test(q);
  const repeat =
    /^(?:а )?(?:добавь|добавить)(?: мне)?(?: любую)?(?: простую)? кнопку(?: какую(?: нибудь)?)?$/.test(
      q,
    ) || /^(?:любую|любую простую|простую|любую простую кнопку)$/.test(q);
  if (!supplied && !google && !repeat) return undefined;
  const target =
    supplied || (google ? "https://www.google.com/" : current.phrase);
  if (supplied) {
    try {
      const url = new URL(supplied);
      if (url.protocol !== "https:" || url.username || url.password)
        return undefined;
    } catch {
      return undefined;
    }
  }
  const explicitLabel = message.match(
    /(?:подпис[ьи]|названи[ея]|текстом|кнопку)\s*[«"“]([^»"”]{1,40})[»"”]/i,
  )?.[1];
  const button = {
    label:
      explicitLabel ||
      (google ? "Google" : supplied ? "Открыть сайт" : "Ещё раз"),
    action: (supplied || google ? "open_link" : "text") as "open_link" | "text",
    target,
  };
  const buttons = current.buttons.map((b) => ({ ...b }));
  if (
    /замени|поменяй|измени/.test(q) ||
    (buttons.length === 1 && /^(?:https:\/\/|просто |любую |простую )/.test(q))
  ) {
    if (buttons.length !== 1) return undefined;
    buttons[0] = button;
  } else if (
    !buttons.some(
      (b) => b.action === button.action && b.target === button.target,
    )
  )
    buttons.push(button);
  if (buttons.length > 5) return undefined;
  return { ...current, mediaIds: [...current.mediaIds], buttons };
}
