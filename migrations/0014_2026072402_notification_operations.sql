-- migration: 2026072402_notification_operations
-- Notification operations adds an explicit rule clock, optional quiet hours,
-- and lease-safe scheduled evaluation for camera activity rules. Existing
-- accepted-read rules retain their behavior and remain unscheduled.
ALTER TABLE public.notification_rules
    ADD COLUMN IF NOT EXISTS time_zone VARCHAR(100) NOT NULL DEFAULT 'UTC',
    ADD COLUMN IF NOT EXISTS quiet_hours JSONB NOT NULL DEFAULT '{"enabled":false}'::JSONB,
    ADD COLUMN IF NOT EXISTS evaluation_interval_seconds INTEGER,
    ADD COLUMN IF NOT EXISTS next_evaluation_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS evaluation_locked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS evaluation_locked_by VARCHAR(255);

ALTER TABLE public.notification_rules
    DROP CONSTRAINT IF EXISTS notification_rules_quiet_hours_object;
ALTER TABLE public.notification_rules
    ADD CONSTRAINT notification_rules_quiet_hours_object
        CHECK (jsonb_typeof(quiet_hours) = 'object');
ALTER TABLE public.notification_rules
    DROP CONSTRAINT IF EXISTS notification_rules_evaluation_interval;
ALTER TABLE public.notification_rules
    ADD CONSTRAINT notification_rules_evaluation_interval
        CHECK (evaluation_interval_seconds IS NULL OR
               evaluation_interval_seconds BETWEEN 60 AND 86400);
ALTER TABLE public.notification_rules
    DROP CONSTRAINT IF EXISTS notification_rules_evaluation_lock_state;
ALTER TABLE public.notification_rules
    ADD CONSTRAINT notification_rules_evaluation_lock_state CHECK (
        (evaluation_locked_at IS NULL AND evaluation_locked_by IS NULL) OR
        (evaluation_locked_at IS NOT NULL AND NULLIF(BTRIM(evaluation_locked_by), '') IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_notification_rules_activity_due
    ON public.notification_rules (next_evaluation_at, id)
    WHERE enabled = TRUE AND event_type = 'camera.activity_check';

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072402_notification_operations',
    'Add explicit rule time zones, quiet hours, and lease-safe scheduled camera activity evaluation.'
)
ON CONFLICT (version) DO NOTHING;
