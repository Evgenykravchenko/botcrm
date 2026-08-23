ALTER TABLE stages ADD COLUMN IF NOT EXISTS slug text;
UPDATE stages SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '_', 'g')) WHERE slug IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stages_pipeline_slug_uq ON stages(pipeline_id, slug);

CREATE TABLE IF NOT EXISTS ingested_events (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, event_id)
);

CREATE INDEX IF NOT EXISTS channel_identities_contact_idx ON channel_identities(contact_id);
CREATE INDEX IF NOT EXISTS conversations_contact_idx ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS contacts_workspace_updated_idx ON contacts(workspace_id, updated_at DESC) WHERE deleted_at IS NULL;