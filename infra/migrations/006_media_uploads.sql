CREATE TABLE IF NOT EXISTS media_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','UPLOADED','ATTACHED','EXPIRED')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  attached_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS media_uploads_workspace_status_idx
  ON media_uploads(workspace_id,status,expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS attachments_object_key_uidx
  ON attachments(object_key);
