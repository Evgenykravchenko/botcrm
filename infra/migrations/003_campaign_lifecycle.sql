-- Campaign lifecycle needs a terminal recipient state distinct from channel failure.
ALTER TYPE message_status ADD VALUE IF NOT EXISTS 'CANCELLED';

CREATE INDEX IF NOT EXISTS campaign_recipient_status_idx
  ON campaign_recipients(campaign_id,status,next_attempt_at);