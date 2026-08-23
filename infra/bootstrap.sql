BEGIN;

-- Minimal data required to sign in to a fresh self-hosted installation.
-- CRM contacts, conversations, deals and campaigns are intentionally absent.
INSERT INTO workspaces(id, name, timezone)
VALUES ('00000000-0000-4000-8000-000000000001', 'Bot Studio', 'Asia/Omsk')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO users(id, workspace_id, email, display_name, role)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'owner@botcrm.local',
  'Евгений',
  'OWNER'
)
ON CONFLICT (workspace_id, email) DO UPDATE SET display_name = EXCLUDED.display_name;

COMMIT;
