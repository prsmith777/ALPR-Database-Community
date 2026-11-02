-- migration: 2026072603_vehicle_direction_backfill
-- Historical direction work is derived from current canonical crop evidence and is
-- naturally resumable: current observations are skipped, while repeat
-- failures are retained for review instead of blocking the remaining corpus.
CREATE TABLE IF NOT EXISTS public.vehicle_direction_backfill_failures (
    read_id INTEGER PRIMARY KEY REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    embedding_model VARCHAR(80) NOT NULL,
    classifier_version VARCHAR(80) NOT NULL,
    profile_version INTEGER NOT NULL CHECK (profile_version > 0),
    attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
    error_code VARCHAR(80) NOT NULL,
    error_message VARCHAR(500) NOT NULL,
    first_failed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_failed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vehicle_direction_backfill_failures_retry
    ON public.vehicle_direction_backfill_failures (
        embedding_model, classifier_version, profile_version, attempt_count, last_failed_at
    );

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072603_vehicle_direction_backfill',
    'Add paced resumable historical direction backfill with bounded failure tracking.'
)
ON CONFLICT (version) DO NOTHING;
