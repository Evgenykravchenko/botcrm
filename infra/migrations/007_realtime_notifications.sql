-- Workspace-scoped change notifications for the authenticated SSE stream.
CREATE OR REPLACE FUNCTION botcrm_notify_workspace_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_data jsonb;
  workspace_value text;
  entity_value text;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  workspace_value := row_data ->> 'workspace_id';
  entity_value := COALESCE(row_data ->> 'id', row_data ->> 'contact_id', row_data ->> 'workspace_id');

  IF workspace_value IS NOT NULL THEN
    PERFORM pg_notify(
      'botcrm_realtime',
      json_build_object(
        'workspaceId', workspace_value,
        'entity', TG_TABLE_NAME,
        'operation', lower(TG_OP),
        'entityId', entity_value,
        'occurredAt', clock_timestamp()
      )::text
    );
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users', 'teams', 'bots', 'connectors', 'contacts', 'channel_identities',
    'conversations', 'messages', 'attachments', 'pipelines', 'stages',
    'deals', 'deal_stage_history', 'tags', 'contact_tags', 'segments',
    'consents', 'suppression_entries', 'campaigns', 'campaign_recipients',
    'automation_rules', 'automation_runs', 'tasks', 'notes'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS botcrm_realtime_change ON %I', table_name);
    EXECUTE format(
      'CREATE TRIGGER botcrm_realtime_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION botcrm_notify_workspace_change()',
      table_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION botcrm_notify_team_member_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_data jsonb;
  workspace_value text;
  team_value text;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  team_value := row_data ->> 'team_id';
  SELECT workspace_id::text INTO workspace_value FROM teams WHERE id = team_value::uuid;
  IF workspace_value IS NOT NULL THEN
    PERFORM pg_notify('botcrm_realtime', json_build_object(
      'workspaceId', workspace_value,
      'entity', 'team_members',
      'operation', lower(TG_OP),
      'entityId', team_value,
      'occurredAt', clock_timestamp()
    )::text);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS botcrm_realtime_change ON team_members;
CREATE TRIGGER botcrm_realtime_change
AFTER INSERT OR UPDATE OR DELETE ON team_members
FOR EACH ROW EXECUTE FUNCTION botcrm_notify_team_member_change();