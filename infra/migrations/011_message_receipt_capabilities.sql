UPDATE connectors
SET capabilities = capabilities || CASE channel
  WHEN 'telegram' THEN '{"read":false,"receiptMode":"sent_only"}'::jsonb
  WHEN 'vk' THEN '{"read":false,"receiptMode":"sent_only"}'::jsonb
  WHEN 'whatsapp' THEN '{"read":true,"receiptMode":"webhook"}'::jsonb
  WHEN 'avito' THEN '{"read":false,"receiptMode":"sent_only"}'::jsonb
  WHEN 'api' THEN '{"read":true,"receiptMode":"message.status"}'::jsonb
  ELSE '{}'::jsonb
END;
