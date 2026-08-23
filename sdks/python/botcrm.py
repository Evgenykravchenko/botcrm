"""Small dependency-free BotCRM client for mirror-mode Python bots."""
from __future__ import annotations
import hashlib
import hmac
import json
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Any

class BotCrmError(RuntimeError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code

class BotCrmClient:
    def __init__(self, base_url: str, workspace_id: str, bot_id: str, service_token: str):
        self.base_url = base_url.rstrip("/")
        self.workspace_id = workspace_id
        self.bot_id = bot_id
        self.service_token = service_token

    def _request(self, path: str, payload: dict[str, Any] | None = None, method: str = "GET", extra_headers: dict[str, str] | None = None) -> Any:
        headers = {"content-type": "application/json", "x-workspace-id": self.workspace_id, "x-service-token": self.service_token, **(extra_headers or {})}
        request = urllib.request.Request(f"{self.base_url}/api/v1{path}", data=json.dumps(payload).encode() if payload is not None else None, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            body = json.loads(error.read() or b"{}")
            detail = body.get("error", {})
            raise BotCrmError(error.code, detail.get("code", "request_failed"), detail.get("message", str(error))) from error

    def incoming(self, *, event_id: str, channel: str, chat_id: str, user_id: str, text: str, profile: dict[str, Any] | None = None, attributes: dict[str, Any] | None = None, raw_payload: Any = None) -> Any:
        return self._request("/events", {"event_id": event_id, "schema_version": "1.0", "occurred_at": datetime.now(timezone.utc).isoformat(), "workspace_id": self.workspace_id, "bot_id": self.bot_id, "channel": channel, "external_chat_id": chat_id, "external_user_id": user_id, "type": "message.received", "message": {"text": text}, "profile": profile or {}, "attributes": attributes or {}, "raw_payload": raw_payload}, "POST")

    def send(self, conversation_id: str, text: str, idempotency_key: str, actor: str = "bot") -> Any:
        return self._request("/messages/send", {"conversationId": conversation_id, "text": text, "actor": actor}, "POST", {"idempotency-key": idempotency_key})

    def conversation(self, conversation_id: str) -> Any:
        return self._request(f"/conversations/{conversation_id}")


def verify_botcrm_webhook(raw_body: bytes, signature: str | None, secret: str) -> bool:
    """Verify x-botcrm-signature against the exact raw HTTP request body."""
    if not signature or not signature.startswith("sha256=") or not secret:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature[7:])
