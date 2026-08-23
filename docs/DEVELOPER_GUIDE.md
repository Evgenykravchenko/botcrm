# Интеграция самописного бота с BotCRM

Это практическое руководство дополняет Swagger. Swagger перечисляет методы и схемы, а здесь описана правильная архитектура, последовательность действий и типичные ошибки.

## 1. Выберите режим

### Gateway

BotCRM владеет webhook официального канала:

`Канал → BotCRM → очередь событий → ваш бот`

Ответ бота:

`Ваш бот → POST /messages/send → BotCRM → официальный API канала`

Выбирайте Gateway для нового бота или когда нужен гарантированный ручной перехват, централизованные лимиты и полная история.

### Mirror / SDK

Существующий бот сохраняет webhook/long polling, но зеркалирует входящие события в `POST /events`. Все исходящие ответы желательно отправлять через BotCRM.

Выбирайте Mirror, если менять транспорт существующего бота сразу нельзя. Если бот продолжает писать напрямую в Telegram/VK, BotCRM не сможет физически остановить его в режиме `HUMAN`.

Готовые эталонные примеры:

- [Telegram test bot](../examples/telegram-test-bot/README.md) — Bot API long polling;
- [VK test bot](../examples/vk-test-bot/README.md) — сообщения сообщества и Bots Long Poll API.

## 2. Создайте сервисный токен

В панели: «Настройки → Сервисные токены → Новый токен».

Сохраните значение сразу: повторно оно не показывается. Используйте отдельные токены для development, staging и production.

Обязательные заголовки REST/SDK:

```http
Content-Type: application/json
X-Workspace-Id: ws_demo
X-Service-Token: <service-token>
```

Для браузерных пользователей применяется авторизованная сессия. Не встраивайте пользовательский Bearer-токен в бота.

## 3. Зарегистрируйте бота/подключение

В «Боты и каналы» нажмите «Подключить» и задайте:

- канал;
- название и стабильный `slug` бота;
- Gateway или Mirror;
- необязательный endpoint вашего бота для событий BotCRM в Mirror-режиме;
- официальный токен канала;
- webhook secret и код подтверждения для Gateway, если их требует канал.

После сохранения скопируйте webhook URL и выполните «Проверить».

## 4. Нормализованное событие

```json
{
  "event_id": "telegram:8291042",
  "schema_version": "1.0",
  "occurred_at": "2026-08-20T09:30:00.000Z",
  "workspace_id": "ws_demo",
  "bot_id": "sales_bot",
  "channel": "telegram",
  "external_chat_id": "84120931",
  "external_user_id": "84120931",
  "type": "message.received",
  "message": {
    "external_id": "501",
    "text": "Хочу узнать стоимость"
  },
  "profile": {
    "name": "Анна",
    "phone": "+79990000000",
    "avatar_file_id": "Telegram file_id или avatar_url для других каналов"
  },
  "attributes": {
    "lead_score": 78,
    "plan": "team"
  }
}
```

`profile.avatar_url` подходит для публичного HTTPS-изображения любого канала. Для Telegram безопаснее передавать `profile.avatar_file_id`: BotCRM загрузит изображение через защищённый серверный endpoint и не покажет токен бота браузеру.

`event_id` должен быть глобально стабильным для одного внешнего события. Повтор того же ID безопасно распознаётся как дубликат.

## 5. TypeScript SDK

Соберите локальный SDK:

```powershell
npm run build --workspace @botcrm/sdk
```

Пример Mirror:

```ts
import { BotCrmClient } from "@botcrm/sdk";
import crypto from "node:crypto";

const crm = new BotCrmClient({
  baseUrl: "https://crm.example.ru",
  workspaceId: "ws_demo",
  botId: "sales_bot",
  serviceToken: process.env.BOTCRM_TOKEN!,
});

const accepted = await crm.incoming({
  eventId: `telegram:${update.update_id}`,
  channel: "telegram",
  chatId: String(update.message.chat.id),
  userId: String(update.message.from.id),
  externalMessageId: String(update.message.message_id),
  text: update.message.text ?? "",
  profile: {
    name: update.message.from.first_name,
    avatar_file_id: telegramAvatarFileId
  },
  attributes: { source: "telegram_bot" },
  raw: update,
});

if (accepted.deliverToBot && accepted.conversationId) {
  const answer = await buildAnswer(update.message.text ?? "");
  await crm.send({
    conversationId: accepted.conversationId,
    text: answer,
    idempotencyKey: crypto.randomUUID(),
  });
}
```

Ключевой флаг — `deliverToBot`. Если диалог принадлежит оператору или поставлен на паузу, не запускайте бизнес-логику ответа.

## 6. Python SDK

Файл: `sdks/python/botcrm.py`, внешние зависимости не нужны.

```python
from uuid import uuid4
from sdks.python.botcrm import BotCrmClient

crm = BotCrmClient(
    base_url="https://crm.example.ru",
    workspace_id="ws_demo",
    bot_id="support_bot",
    service_token=os.environ["BOTCRM_TOKEN"],
)

accepted = crm.incoming(
    event_id=f"telegram:{update.update_id}",
    channel="telegram",
    chat_id=str(update.message.chat.id),
    user_id=str(update.message.from_user.id),
    text=update.message.text or "",
    profile={"name": update.message.from_user.first_name},
    attributes={"topic": "support"},
)

if accepted.get("deliverToBot"):
    crm.send(accepted["conversationId"], "Принято", str(uuid4()))
```

## 7. Чистый REST

Приём события:

```bash
curl -X POST "http://localhost:4100/api/v1/events" \
  -H "Content-Type: application/json" \
  -H "X-Workspace-Id: ws_demo" \
  -H "X-Service-Token: $BOTCRM_TOKEN" \
  -d @event.json
```

Ответ:

```json
{
  "duplicate": false,
  "contactId": "...",
  "conversationId": "...",
  "deliverToBot": true
}
```

Отправка сообщения:

```bash
curl -X POST "http://localhost:4100/api/v1/messages/send" \
  -H "Content-Type: application/json" \
  -H "X-Workspace-Id: ws_demo" \
  -H "X-Service-Token: $BOTCRM_TOKEN" \
  -H "Idempotency-Key: msg-84120931-502" \
  -d '{"conversationId":"...","actor":"bot","text":"Ответ бота"}'
```

Никогда не повторяйте временную ошибку с новым idempotency key: это может создать два сообщения.

## 8. Upsert контакта и переменных

```http
POST /api/v1/contacts/upsert
```

```json
{
  "channel": "telegram",
  "externalUserId": "84120931",
  "name": "Анна",
  "phone": "+79990000000",
  "attributes": {
    "lead_score": 82,
    "payment_status": "waiting",
    "quiz_answers": { "team_size": 5 }
  }
}
```

Синхронизируйте в BotCRM все значения, по которым нужны фильтры, канбан, автоматизации и рассылки. Не рассчитывайте на запрос внешней БД во время построения сегмента.

## 9. Управление диалогом

У разговора есть `mode` и `controlVersion`. Изменение выполняется с optimistic locking:

```http
PATCH /api/v1/conversations/{id}/control
```

```json
{
  "mode": "BOT",
  "expectedVersion": 4
}
```

Если версия изменилась, API вернёт `409 control_version_conflict`. Загрузите разговор заново и не перезаписывайте более свежее решение оператора.

Сервисный бот обычно не должен сам забирать диалог в `HUMAN`; это действие пользователя или автоматизации с соответствующим правом.

## 10. События от BotCRM вашему боту

Для `eventEndpoint` BotCRM отправляет подписанные события, например:

- сообщение оператора;
- `control.returned` после возврата управления;
- служебное событие доставки.

Подпись:

```http
X-BotCRM-Signature: sha256=<hex-hmac>
```

Проверяйте HMAC-SHA256 по точным байтам raw body и `BOT_EVENT_SIGNING_SECRET`.

TypeScript:

```ts
import { verifyBotCrmWebhook } from "@botcrm/sdk";

if (!verifyBotCrmWebhook(rawBody, req.headers["x-botcrm-signature"], secret)) {
  return new Response("invalid signature", { status: 401 });
}
```

Python:

```python
from sdks.python.botcrm import verify_botcrm_webhook

if not verify_botcrm_webhook(raw_body, signature, secret):
    return Response(status=401)
```

Обработчик должен быть идемпотентным по `event_id` и быстро отвечать `2xx`. Долгую работу помещайте в собственную очередь.

## 11. Официальные webhook каналов

Gateway URL:

```text
POST /api/v1/webhooks/{channel}/{connectorId}
```

- Telegram: заголовок `X-Telegram-Bot-Api-Secret-Token`;
- VK: поле `secret`, confirmation code выдаётся автоматически;
- WhatsApp: `X-Hub-Signature-256`, GET challenge поддерживается;
- generic/Avito: HMAC в `X-BotCRM-Signature` или `X-Avito-Signature`.

Используйте только официальные API. Не подключайте пользовательские аккаунты через эмуляцию клиента.

## 12. Вложения

Последовательность:

1. `POST /media/uploads` — получить upload URL;
2. загрузить файл PUT-запросом прямо в S3/MinIO;
3. `POST /media/uploads/{id}/complete` — проверить размер/хеш;
4. передать `attachmentIds` в `/messages/send`.

Нельзя прикрепить незавершённую, чужую или просроченную загрузку.

## 13. Ошибки и повторы

| HTTP | Значение | Действие клиента |
|---|---|---|
| 400 | некорректная схема | исправить payload, не повторять автоматически |
| 401/403 | токен, подпись или права | остановить отправку и исправить секрет/роль |
| 404 | объект или connector не найден | проверить workspace и идентификатор |
| 409 | конфликт версии/идемпотентности | перечитать состояние |
| 429 | лимит канала/API | ждать `Retry-After` |
| 5xx | временная инфраструктурная ошибка | exponential backoff с тем же ключом |

Рекомендуемые задержки: 1, 2, 5, 10, 30 секунд с jitter и ограничением попыток. Постоянную ошибку помещайте в dead-letter/suppression в зависимости от типа.

## 14. Безопасность

### RBAC и типы учётных данных

- Browser API использует пользовательскую Bearer-сессию; сервер определяет `workspace_id` и роль из сессии, а не доверяет значениям из тела запроса.
- `OWNER` и `ADMIN` управляют командой и сервисными токенами, но только `OWNER` может назначить роль владельца или изменить другого владельца.
- `SUPERVISOR` управляет воронками, сегментами, рассылками и автоматизациями, но не пользователями и credentials каналов.
- `OPERATOR` работает с диалогами, контактами и сделками; административные mutation endpoint ему запрещены.
- Сервисный токен имеет роль `SERVICE` и принимается только endpoint, где она явно указана в `@Roles`; он не является обходом RBAC панели.
- Передавайте один тип авторизации: пользовательскую сессию для панели либо отдельный `x-service-token` для бота/worker.
- Попытка изменить владельца администратором возвращает `403 owner_protected`; самопонижение — `409 self_role_change_forbidden`; удаление последнего активного владельца — `409 last_owner_required`.


- храните токены только в secret manager/env;
- не логируйте raw credentials и персональные данные;
- один токен — один бот и окружение;
- проверяйте подписи до JSON parsing бизнес-логикой;
- ограничивайте allowlist исходящих automation webhook;
- используйте HTTPS;
- регулярно ротируйте секреты;
- не принимайте решение об объединении контактов только по имени.

## 15. Чек-лист готовой интеграции

- повтор одного `event_id` не создаёт дубль;
- бот соблюдает `deliverToBot=false`;
- все исходящие имеют стабильный `Idempotency-Key`;
- `HUMAN` действительно останавливает ответы;
- `control.returned` возобновляет сценарий безопасно;
- HMAC проверяется по raw body;
- 429 учитывает `Retry-After`;
- секреты не попадают в логи;
- контакт и важные атрибуты видны в панели;
- connector health-check зелёный;
- тест пройден на повторной и неупорядоченной доставке.

## 16. Полезные адреса

- web-документация: `/docs`;
- Swagger: `http://localhost:4100/docs`;
- OpenAPI JSON: `http://localhost:4100/docs-json`;
- health: `GET /api/v1/health`;
- metrics: `GET /api/v1/metrics`.

## Реестр произвольных атрибутов

Названия полей не зашиты в BotCRM. Любой допустимый ключ из `attributes` (`^[A-Za-z_][A-Za-z0-9_.-]{0,79}$`) автоматически попадает в реестр workspace при первом событии или upsert контакта. Тип выводится из первого значения: строка, число, флаг, массив строк или JSON. Администратор может исправить метаданные в интерфейсе.

Получить схему, доступную текущему workspace:

```http
GET /api/v1/attribute-definitions
Authorization: Bearer <token>
```

Заранее зарегистрировать поле от имени владельца или администратора:

```http
POST /api/v1/attribute-definitions
Content-Type: application/json
Authorization: Bearer <token>

{
  "objectScope": "CONTACT",
  "key": "risk_level",
  "label": "Риск ухода",
  "valueType": "ENUM",
  "authority": "BOT",
  "filterable": true,
  "config": { "options": ["low", "medium", "high"] }
}
```

`authority: BOT` означает, что источником истины считается интеграция; `PLATFORM` — оператор или автоматизация BotCRM. В текущей версии значения атрибутов контакта передаются в `attributes`; остальные области зарезервированы моделью данных для дальнейшего расширения. `lead_score` в примерах документации не является обязательным или зарезервированным именем.
