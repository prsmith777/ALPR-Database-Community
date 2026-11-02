-- migration: 2026072203_disabled_notification_rule_migration
-- Record each legacy rule copied into the inert unified model. The unique source
-- identity makes the application migration safe to retry, while the restricted
-- target reference preserves provenance for later review and cutover.
CREATE TABLE IF NOT EXISTS public.notification_rule_migrations (
    id BIGSERIAL PRIMARY KEY,
    source_type VARCHAR(20) NOT NULL
        CHECK (source_type IN ('pushover', 'mqtt')),
    source_id BIGINT NOT NULL CHECK (source_id > 0),
    target_rule_id BIGINT NOT NULL UNIQUE
        REFERENCES public.notification_rules(id) ON DELETE RESTRICT,
    applied_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_rule_migrations_created_at
    ON public.notification_rule_migrations (created_at DESC, id DESC);

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072203_disabled_notification_rule_migration',
    'Track idempotent disabled-only copies of legacy Pushover and MQTT rules.'
)
ON CONFLICT (version) DO NOTHING;
