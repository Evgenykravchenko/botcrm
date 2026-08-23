DROP INDEX IF EXISTS messages_conversation_idx;
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at, occurred_at, id);
