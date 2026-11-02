-- migration: 2026072403_finalize_legacy_mqtt_rules
-- Finalization is the deliberate end of a legacy notification rule runtime. Preserve
-- an immutable, credential-free copy of each source rule before deleting it,
-- then remove the mapping from active migration/cutover workflows. Unified
-- rule delivery and its append-only cutover evidence remain authoritative.
ALTER TABLE public.notification_rule_migrations
    ADD COLUMN IF NOT EXISTS legacy_snapshot JSONB,
    ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finalized_by_user_id BIGINT
        REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS finalization_reason TEXT;

ALTER TABLE public.notification_rule_migrations
    DROP CONSTRAINT IF EXISTS notification_rule_migrations_legacy_snapshot_object;
ALTER TABLE public.notification_rule_migrations
    ADD CONSTRAINT notification_rule_migrations_legacy_snapshot_object
    CHECK (legacy_snapshot IS NULL OR jsonb_typeof(legacy_snapshot) = 'object');

ALTER TABLE public.notification_rule_migrations
    DROP CONSTRAINT IF EXISTS notification_rule_migrations_finalization_complete;
ALTER TABLE public.notification_rule_migrations
    ADD CONSTRAINT notification_rule_migrations_finalization_complete
    CHECK (
        (finalized_at IS NULL AND legacy_snapshot IS NULL AND finalization_reason IS NULL)
        OR
        (finalized_at IS NOT NULL AND legacy_snapshot IS NOT NULL
         AND NULLIF(BTRIM(finalization_reason), '') IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_notification_rule_migrations_unfinalized
    ON public.notification_rule_migrations (source_type, source_id)
    WHERE retired_at IS NULL AND finalized_at IS NULL;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072403_finalize_legacy_mqtt_rules',
    'Archive verified cutover MQTT source rules and remove their legacy runtime rows.'
)
ON CONFLICT (version) DO NOTHING;
