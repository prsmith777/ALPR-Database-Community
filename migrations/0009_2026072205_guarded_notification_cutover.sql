-- migration: 2026072205_guarded_notification_cutover
-- Append-only history for explicit per-rule cutovers and rollbacks. The live
-- source/target enabled flags remain the source of truth; these rows preserve
-- who changed them, which reviewed version was involved, and why.
CREATE TABLE IF NOT EXISTS public.notification_rule_cutover_events (
    id BIGSERIAL PRIMARY KEY,
    migration_id BIGINT NOT NULL
        REFERENCES public.notification_rule_migrations(id) ON DELETE RESTRICT,
    direction VARCHAR(20) NOT NULL
        CHECK (direction IN ('cutover', 'rollback')),
    rule_version INTEGER NOT NULL CHECK (rule_version > 0),
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_rule_cutover_events_metadata_object
        CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_notification_rule_cutover_events_activity
    ON public.notification_rule_cutover_events (migration_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.prevent_notification_cutover_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'notification_rule_cutover_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_rule_cutover_events_append_only
    ON public.notification_rule_cutover_events;
CREATE TRIGGER notification_rule_cutover_events_append_only
BEFORE UPDATE OR DELETE ON public.notification_rule_cutover_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_notification_cutover_event_mutation();

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072205_guarded_notification_cutover',
    'Add append-only evidence for guarded per-rule unified notification cutover and rollback.'
)
ON CONFLICT (version) DO NOTHING;
