with labels(key, old_label, new_label) as (
  values
    ('funnel_hint', 'Funnel Hint', 'Рекомендуемый этап воронки'),
    ('intent', 'Intent', 'Намерение клиента'),
    ('last_bot_command', 'Last Bot Command', 'Последняя команда боту'),
    ('lead_score', 'Lead Score', 'Оценка интереса'),
    ('lifecycle', 'Lifecycle', 'Статус клиента'),
    ('needs_human', 'Needs Human', 'Нужен оператор'),
    ('payment_status', 'Payment Status', 'Статус оплаты'),
    ('plan', 'Plan', 'Тариф'),
    ('priority', 'Priority', 'Приоритет'),
    ('qualified', 'Qualified', 'Квалифицирован'),
    ('requested_plan', 'Requested Plan', 'Запрошенный тариф'),
    ('risk_level', 'Risk Level', 'Уровень риска'),
    ('score', 'Score', 'Оценка'),
    ('segment_test_key', 'Segment Test Key', 'Тестовый признак сегмента'),
    ('source', 'Source', 'Источник'),
    ('source_key', 'Source Key', 'Ключ источника'),
    ('support_requested', 'Support Requested', 'Запрошена поддержка'),
    ('telegram_chat_type', 'Telegram Chat Type', 'Тип чата Telegram'),
    ('telegram_language', 'Telegram Language', 'Язык Telegram'),
    ('telegram_username', 'Telegram Username', 'Имя пользователя Telegram'),
    ('test_scenario', 'Test Scenario', 'Тестовый сценарий'),
    ('topic', 'Topic', 'Тема обращения')
)
update attribute_definitions ad
set label = labels.new_label
from labels
where ad.key = labels.key
  and lower(ad.label) = lower(labels.old_label)
  and coalesce((ad.config->>'discovered')::boolean, false) = true;