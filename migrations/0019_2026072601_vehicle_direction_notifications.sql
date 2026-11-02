-- migration: 2026072601_vehicle_direction_notifications
-- Direction classification is emitted after Vehicle ReID completes, so it has
-- a distinct event type and can be filtered using camera-configured labels.
ALTER TABLE IF EXISTS public.notification_rules
    DROP CONSTRAINT IF EXISTS notification_rules_event_type_check;
ALTER TABLE IF EXISTS public.notification_rules
    ADD CONSTRAINT notification_rules_event_type_check
    CHECK (event_type IN (
        'plate_read.accepted',
        'vehicle.direction_classified',
        'camera.activity_check'
    ));

ALTER TABLE IF EXISTS public.notification_conditions
    DROP CONSTRAINT IF EXISTS notification_conditions_condition_type_check;
ALTER TABLE IF EXISTS public.notification_conditions
    ADD CONSTRAINT notification_conditions_condition_type_check
    CHECK (condition_type IN (
        'always',
        'event_type',
        'plate_match',
        'camera',
        'direction',
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
    '2026072601_vehicle_direction_notifications',
    'Add direction-classified notification events and camera-configured direction conditions.'
)
ON CONFLICT (version) DO NOTHING;
