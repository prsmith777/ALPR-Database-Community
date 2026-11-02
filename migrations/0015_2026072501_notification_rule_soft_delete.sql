-- migration: 2026072501_notification_rule_soft_delete
-- Administrators can remove disabled rules from the active workspace without
-- breaking immutable execution, delivery, migration, or audit references.
ALTER TABLE public.notification_rules
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by_user_id BIGINT
        REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(100);

ALTER TABLE public.notification_rules
    DROP CONSTRAINT IF EXISTS notification_rules_deleted_state;
ALTER TABLE public.notification_rules
    ADD CONSTRAINT notification_rules_deleted_state CHECK (
        (deleted_at IS NULL AND deletion_reason IS NULL) OR
        (deleted_at IS NOT NULL AND enabled = FALSE AND
         NULLIF(BTRIM(deletion_reason), '') IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_notification_rules_visible
    ON public.notification_rules (enabled DESC, updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;

-- Legacy copies predate explicit rule clocks and inherited the old UTC schema
-- default. Only those tracked migration targets receive the configured local
-- timezone; independently created rules that intentionally use UTC are kept.
UPDATE public.notification_rules rule
SET time_zone = COALESCE(NULLIF(BTRIM(settings.local_timezone), ''), 'America/Denver'),
    quiet_hours = CASE
        WHEN COALESCE(rule.quiet_hours->>'timeZone', rule.quiet_hours->>'time_zone') = 'UTC'
        THEN (rule.quiet_hours - 'time_zone') || jsonb_build_object(
            'timeZone', COALESCE(NULLIF(BTRIM(settings.local_timezone), ''), 'America/Denver')
        )
        ELSE rule.quiet_hours
    END,
    version = rule.version + 1,
    updated_at = CURRENT_TIMESTAMP
FROM public.mqtt_settings settings
WHERE settings.id = 1
  AND rule.time_zone = 'UTC'
  AND EXISTS (
      SELECT 1 FROM public.notification_rule_migrations migration
      WHERE migration.target_rule_id = rule.id
  );

UPDATE public.notification_conditions condition
SET operand = (condition.operand - 'time_zone') || jsonb_build_object(
    'timeZone', COALESCE(NULLIF(BTRIM(settings.local_timezone), ''), 'America/Denver')
)
FROM public.notification_condition_groups condition_group,
     public.notification_rule_migrations migration,
     public.mqtt_settings settings
WHERE settings.id = 1
  AND condition.group_id = condition_group.id
  AND migration.target_rule_id = condition_group.rule_id
  AND condition.condition_type = 'local_time_window'
  AND COALESCE(condition.operand->>'timeZone', condition.operand->>'time_zone') = 'UTC';

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072501_notification_rule_soft_delete',
    'Allow guarded deletion of disabled notification rules and repair inherited UTC defaults on legacy-migrated rules.'
)
ON CONFLICT (version) DO NOTHING;
