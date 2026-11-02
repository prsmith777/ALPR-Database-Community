-- migration: 2026072202_notification_migration_preview
-- Extend the inert shared evaluator vocabulary for legacy known-name rules.
-- This still copies no rules and changes no active delivery path.
ALTER TABLE IF EXISTS public.notification_conditions
    DROP CONSTRAINT IF EXISTS notification_conditions_condition_type_check;
ALTER TABLE IF EXISTS public.notification_conditions
    ADD CONSTRAINT notification_conditions_condition_type_check
    CHECK (condition_type IN (
        'always',
        'event_type',
        'plate_match',
        'camera',
        'known_plate',
        'known_name',
        'tag',
        'watchlist',
        'confidence',
        'read_count',
        'local_time_window'
    ));

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072202_notification_migration_preview',
    'Add known-name rule vocabulary for the read-only legacy notification migration preview.'
)
ON CONFLICT (version) DO NOTHING;
