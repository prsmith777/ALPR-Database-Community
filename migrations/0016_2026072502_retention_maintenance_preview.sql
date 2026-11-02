-- migration: 2026072502_retention_maintenance_preview
-- Retention planning now runs outside ingestion. The initial maintenance job
-- is deliberately dry-run only: it records bounded database candidate counts
-- and never deletes rows or files.
CREATE TABLE IF NOT EXISTS public.maintenance_job_state (
    job_name VARCHAR(100) PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    mode VARCHAR(20) NOT NULL DEFAULT 'dry-run',
    status VARCHAR(20) NOT NULL DEFAULT 'idle',
    interval_seconds INTEGER NOT NULL DEFAULT 86400,
    next_run_at TIMESTAMPTZ,
    last_started_at TIMESTAMPTZ,
    last_completed_at TIMESTAMPTZ,
    last_result JSONB,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT maintenance_job_mode CHECK (mode = 'dry-run'),
    CONSTRAINT maintenance_job_status CHECK (status IN ('idle', 'running', 'failed')),
    CONSTRAINT maintenance_job_interval CHECK (interval_seconds BETWEEN 3600 AND 604800),
    CONSTRAINT maintenance_job_result_object CHECK (
        last_result IS NULL OR jsonb_typeof(last_result) = 'object'
    )
);

CREATE INDEX IF NOT EXISTS idx_maintenance_job_due
    ON public.maintenance_job_state (next_run_at, job_name)
    WHERE enabled = TRUE;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072502_retention_maintenance_preview',
    'Move retention planning out of ingestion into a scheduled, single-flight, dry-run-only maintenance worker.'
)
ON CONFLICT (version) DO NOTHING;
