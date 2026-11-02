-- migration: 2026072401_monitored_plates_and_orphan_retirement
-- Preserve the legacy flagged boolean for evaluator compatibility while adding
-- user-facing monitoring context. Existing monitored plates receive a stable
-- timestamp and the normal priority; original reads and plate identities are
-- unchanged.
ALTER TABLE public.plates
    ADD COLUMN IF NOT EXISTS monitor_reason TEXT,
    ADD COLUMN IF NOT EXISTS monitor_priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    ADD COLUMN IF NOT EXISTS monitored_at TIMESTAMPTZ;

ALTER TABLE public.plates
    DROP CONSTRAINT IF EXISTS plates_monitor_priority_check;
ALTER TABLE public.plates
    ADD CONSTRAINT plates_monitor_priority_check
    CHECK (monitor_priority IN ('low', 'normal', 'high', 'critical'));

UPDATE public.plates
SET monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
WHERE flagged = TRUE AND monitored_at IS NULL;

-- A removed legacy source can leave a safely disabled unified copy behind.
-- Retiring the mapping keeps the target disabled and preserves all rows and
-- evidence while removing it from active migration workflows.
ALTER TABLE public.notification_rule_migrations
    ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retired_by_user_id BIGINT
        REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS retirement_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_notification_rule_migrations_active
    ON public.notification_rule_migrations (source_type, source_id)
    WHERE retired_at IS NULL;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072401_monitored_plates_and_orphan_retirement',
    'Add monitored-plate context and audited retirement for safely disabled orphaned notification migrations.'
)
ON CONFLICT (version) DO NOTHING;
