export const normalizedEventExample = `{
  "event_id": "telegram:482991204",
  "schema_version": "1.0",
  "occurred_at": "2026-08-23T10:15:00.000Z",
  "workspace_id": "ws_demo",
  "bot_id": "sales_assistant",
  "channel": "telegram",
  "external_chat_id": "84120931",
  "external_user_id": "84120931",
  "type": "message.received",
  "message": {
    "external_id": "502",
    "text": "Хочу узнать стоимость"
  },
  "profile": {
    "name": "Анна",
    "city": "Москва",
    "avatar_file_id": "telegram-file-id"
  },
  "attributes": {
    "intent": "pricing",
    "lead_score": 70
  }
}`;

export const acceptedEventExample = `{
  "duplicate": false,
  "contactId": "a60d55b4-...",
  "conversationId": "55c3df22-...",
  "deliverToBot": true
}`;

export const sendMessageExample = `POST /api/v1/messages/send
X-Workspace-Id: ws_demo
X-Service-Token: <service-token>
Idempotency-Key: reply:telegram:502
Content-Type: application/json

{
  "conversationId": "55c3df22-...",
  "actor": "bot",
  "text": "Тариф Pro стоит 4 900 ₽ в месяц"
}`;

export const mediaUploadExample = `# 1. Зарезервировать загрузку
POST /api/v1/media/uploads
{
  "filename": "proposal.pdf",
  "mimeType": "application/pdf",
  "size": 184230
}

# 2. Загрузить байты по выданному uploadUrl
PUT <uploadUrl>
Content-Type: application/pdf

<binary body>

# 3. Подтвердить загрузку
POST /api/v1/media/uploads/<uploadId>/complete

# 4. Передать uploadId при отправке
POST /api/v1/messages/send
{
  "conversationId": "...",
  "actor": "bot",
  "text": "Отправляю предложение",
  "attachmentIds": ["<uploadId>"]
}`;

export const automationExample = `{
  "name": "Горячий лид → квалификация",
  "enabled": true,
  "triggerType": "contact.updated",
  "conditionTree": {
    "match": "all",
    "conditions": [
      { "field": "attributes.lead_score", "operator": "gte", "value": 80 }
    ]
  },
  "actions": [
    { "type": "add_tag", "tag": "Горячий" },
    { "type": "move_deal", "stage": "qualification" },
    { "type": "create_task", "title": "Связаться в течение 15 минут", "dueMinutes": 15 }
  ],
  "maxDepth": 5
}`;

export const webhookVerificationTs = `import { verifyBotCrmWebhook } from "@botcrm/sdk";

app.post("/botcrm-events", express.raw({ type: "application/json" }), (req, res) => {
  const signature = req.header("x-botcrm-signature");
  if (!verifyBotCrmWebhook(req.body, signature, process.env.BOTCRM_WEBHOOK_SECRET!)) {
    return res.status(401).send("invalid signature");
  }

  const event = JSON.parse(req.body.toString("utf8"));
  // Сначала быстро подтвердите приём, тяжёлую работу отправьте в очередь.
  res.status(202).json({ accepted: true, eventId: event.event_id });
});`;

export const typescriptBot = `import { BotCrmClient } from "@botcrm/sdk";

const telegramToken = required("TELEGRAM_BOT_TOKEN");
const crm = new BotCrmClient({
  baseUrl: required("BOTCRM_URL"),
  workspaceId: required("BOTCRM_WORKSPACE_ID"),
  botId: required("BOTCRM_BOT_ID"),
  serviceToken: required("BOTCRM_SERVICE_TOKEN")
});

async function telegram(method: string, body: unknown) {
  const response = await fetch(
    \`https://api.telegram.org/bot\${telegramToken}/\${method}\`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  );
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(JSON.stringify(result));
  return result.result;
}

let offset = 0;
while (true) {
  const updates = await telegram("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
  for (const update of updates) {
    offset = update.update_id + 1;
    const message = update.message;
    if (!message?.text || !message.from) continue;

    const accepted = await crm.incoming({
      eventId: \`telegram:\${update.update_id}\`,
      channel: "telegram",
      chatId: String(message.chat.id),
      userId: String(message.from.id),
      externalMessageId: String(message.message_id),
      text: message.text,
      profile: {
        name: [message.from.first_name, message.from.last_name].filter(Boolean).join(" "),
      },
      attributes: { source: "telegram", last_command: message.text }
    });

    // false означает, что диалог забрал оператор или он поставлен на паузу.
    if (!accepted.deliverToBot || !accepted.conversationId) continue;

    const answer = message.text === "/price"
      ? "Тариф Pro стоит 4 900 ₽ в месяц. Напишите /manager, если нужна консультация."
      : "Привет! Команды: /price и /manager";

    await crm.send({
      conversationId: accepted.conversationId,
      text: answer,
      actor: "bot",
      idempotencyKey: \`reply:\${update.update_id}\`
    });
  }
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(\`Missing \${name}\`);
  return value;
}`;

export const pythonBot = `import asyncio
import os
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, ContextTypes, filters
from botcrm import BotCrmClient

crm = BotCrmClient(
    base_url=os.environ["BOTCRM_URL"],
    workspace_id=os.environ["BOTCRM_WORKSPACE_ID"],
    bot_id=os.environ["BOTCRM_BOT_ID"],
    service_token=os.environ["BOTCRM_SERVICE_TOKEN"],
)

async def handle(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.effective_message
    user = update.effective_user
    if not message or not user or not message.text:
        return

    accepted = await asyncio.to_thread(
        crm.incoming,
        event_id=f"telegram:{update.update_id}",
        channel="telegram",
        chat_id=str(message.chat_id),
        user_id=str(user.id),
        text=message.text,
        profile={"name": user.full_name},
        attributes={"source": "telegram", "last_command": message.text},
        raw_payload=update.to_dict(),
    )

    if not accepted.get("deliverToBot") or not accepted.get("conversationId"):
        return

    text = (
        "Тариф Pro стоит 4 900 ₽. Напишите /manager для связи с человеком."
        if message.text == "/price"
        else "Привет! Команды: /price и /manager"
    )
    await asyncio.to_thread(
        crm.send,
        accepted["conversationId"],
        text,
        f"reply:{update.update_id}",
    )

app = Application.builder().token(os.environ["TELEGRAM_BOT_TOKEN"]).build()
app.add_handler(MessageHandler(filters.TEXT, handle))
app.run_polling(allowed_updates=Update.ALL_TYPES)`;

export const goBot = `package main

import (
  "bytes"
  "encoding/json"
  "fmt"
  "net/http"
  "os"
  "time"
)

type Accepted struct {
  Duplicate      bool   \`json:"duplicate"\`
  ConversationID string \`json:"conversationId"\`
  DeliverToBot   bool   \`json:"deliverToBot"\`
}

func crm(path string, body any, idempotencyKey string, target any) error {
  raw, _ := json.Marshal(body)
  req, _ := http.NewRequest("POST", os.Getenv("BOTCRM_URL")+"/api/v1"+path, bytes.NewReader(raw))
  req.Header.Set("Content-Type", "application/json")
  req.Header.Set("X-Workspace-Id", os.Getenv("BOTCRM_WORKSPACE_ID"))
  req.Header.Set("X-Service-Token", os.Getenv("BOTCRM_SERVICE_TOKEN"))
  if idempotencyKey != "" { req.Header.Set("Idempotency-Key", idempotencyKey) }
  response, err := http.DefaultClient.Do(req)
  if err != nil { return err }
  defer response.Body.Close()
  if response.StatusCode >= 300 { return fmt.Errorf("BotCRM returned %s", response.Status) }
  return json.NewDecoder(response.Body).Decode(target)
}

func incoming(updateID int64, chatID, userID, text string) (Accepted, error) {
  event := map[string]any{
    "event_id": fmt.Sprintf("telegram:%d", updateID),
    "schema_version": "1.0",
    "occurred_at": time.Now().UTC().Format(time.RFC3339Nano),
    "workspace_id": os.Getenv("BOTCRM_WORKSPACE_ID"),
    "bot_id": os.Getenv("BOTCRM_BOT_ID"),
    "channel": "telegram",
    "external_chat_id": chatID,
    "external_user_id": userID,
    "type": "message.received",
    "message": map[string]any{"text": text},
    "attributes": map[string]any{"source": "telegram"},
  }
  var accepted Accepted
  err := crm("/events", event, "", &accepted)
  return accepted, err
}

func reply(accepted Accepted, updateID int64, text string) error {
  if !accepted.DeliverToBot || accepted.ConversationID == "" { return nil }
  body := map[string]any{"conversationId": accepted.ConversationID, "actor": "bot", "text": text}
  var result map[string]any
  return crm("/messages/send", body, fmt.Sprintf("reply:%d", updateID), &result)
}

func main() {
  // Вызовите incoming(...) из обработчика Telegram/VK/WhatsApp вашего фреймворка.
  accepted, err := incoming(482991204, "84120931", "84120931", "/price")
  if err != nil { panic(err) }
  if err := reply(accepted, 482991204, "Тариф Pro стоит 4 900 ₽"); err != nil { panic(err) }
}`;

export const csharpBot = `using System.Net.Http.Json;
using System.Text.Json.Serialization;

var http = new HttpClient { BaseAddress = new Uri(Required("BOTCRM_URL") + "/api/v1/") };
http.DefaultRequestHeaders.Add("X-Workspace-Id", Required("BOTCRM_WORKSPACE_ID"));
http.DefaultRequestHeaders.Add("X-Service-Token", Required("BOTCRM_SERVICE_TOKEN"));

var updateId = 482991204;
var incoming = new {
    event_id = $"telegram:{updateId}",
    schema_version = "1.0",
    occurred_at = DateTimeOffset.UtcNow,
    workspace_id = Required("BOTCRM_WORKSPACE_ID"),
    bot_id = Required("BOTCRM_BOT_ID"),
    channel = "telegram",
    external_chat_id = "84120931",
    external_user_id = "84120931",
    type = "message.received",
    message = new { text = "/price" },
    profile = new { name = "Анна" },
    attributes = new { source = "telegram" }
};

var acceptedResponse = await http.PostAsJsonAsync("events", incoming);
acceptedResponse.EnsureSuccessStatusCode();
var accepted = await acceptedResponse.Content.ReadFromJsonAsync<Accepted>();

if (accepted is { DeliverToBot: true, ConversationId: not null }) {
    using var request = new HttpRequestMessage(HttpMethod.Post, "messages/send") {
        Content = JsonContent.Create(new {
            conversationId = accepted.ConversationId,
            actor = "bot",
            text = "Тариф Pro стоит 4 900 ₽"
        })
    };
    request.Headers.Add("Idempotency-Key", $"reply:{updateId}");
    var sent = await http.SendAsync(request);
    sent.EnsureSuccessStatusCode();
}

static string Required(string name) =>
    Environment.GetEnvironmentVariable(name) ?? throw new Exception($"Missing {name}");

record Accepted(
    [property: JsonPropertyName("duplicate")] bool Duplicate,
    [property: JsonPropertyName("conversationId")] string? ConversationId,
    [property: JsonPropertyName("deliverToBot")] bool DeliverToBot
);`;

export const javaBot = `import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.Map;

public class BotCrmExample {
  static final ObjectMapper JSON = new ObjectMapper();
  static final HttpClient HTTP = HttpClient.newHttpClient();
  static final String API = required("BOTCRM_URL") + "/api/v1";

  public static void main(String[] args) throws Exception {
    var event = Map.ofEntries(
        Map.entry("event_id", "telegram:482991204"),
        Map.entry("schema_version", "1.0"),
        Map.entry("occurred_at", Instant.now().toString()),
        Map.entry("workspace_id", required("BOTCRM_WORKSPACE_ID")),
        Map.entry("bot_id", required("BOTCRM_BOT_ID")),
        Map.entry("channel", "telegram"),
        Map.entry("external_chat_id", "84120931"),
        Map.entry("external_user_id", "84120931"),
        Map.entry("type", "message.received"),
        Map.entry("message", Map.of("text", "/price")),
        Map.entry("profile", Map.of("name", "Анна")),
        Map.entry("attributes", Map.of("source", "telegram"))
    );

    var incoming = send("/events", event, "telegram:482991204");
    if (!incoming.path("deliverToBot").asBoolean() || incoming.path("conversationId").isMissingNode()) return;

    send("/messages/send", Map.of(
        "conversationId", incoming.get("conversationId").asText(),
        "actor", "bot",
        "text", "Тариф Pro стоит 4 900 ₽"
    ), "reply:482991204");
  }

  static JsonNode send(String path, Object body, String key) throws Exception {
    var request = HttpRequest.newBuilder(URI.create(API + path))
        .header("Content-Type", "application/json")
        .header("X-Workspace-Id", required("BOTCRM_WORKSPACE_ID"))
        .header("X-Service-Token", required("BOTCRM_SERVICE_TOKEN"))
        .header("Idempotency-Key", key)
        .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)))
        .build();
    var response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
    if (response.statusCode() >= 300) throw new IllegalStateException(response.statusCode() + ": " + response.body());
    return JSON.readTree(response.body());
  }

  static String required(String name) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) throw new IllegalStateException("Missing " + name);
    return value;
  }
}`;
export const languageSetup = {
  typescript: `npm install @botcrm/sdk\n# Для Telegram long polling нужен Node.js 22+ (fetch уже встроен)`,
  python: `pip install python-telegram-bot\n# Добавьте sdks/python в PYTHONPATH или скопируйте botcrm.py в проект`,
  go: `go mod init example.com/my-bot\ngo run .`,
  csharp: `dotnet new console -n MyBot\ncd MyBot\ndotnet run`,
  java: `# Maven: com.fasterxml.jackson.core:jackson-databind:2.18.2\n# JDK 21+`,
} as const;