-- migration: 2026072901_storage_monitoring_maintenance
-- Phase 1 storage monitoring and guarded maintenance. Automatic cleanup is
-- deliberately disabled and has no approved categories. The only destructive
-- operation represented by this schema is a one-time, confirmed manual run
-- over a frozen preview of reconciliation-confirmed derived-file orphans.
CREATE TABLE IF NOT EXISTS public.storage_maintenance_config (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    warning_percent NUMERIC(5,2) NOT NULL DEFAULT 80,
    critical_percent NUMERIC(5,2) NOT NULL DEFAULT 90,
    check_interval_seconds INTEGER NOT NULL DEFAULT 3600,
    stale_after_seconds INTEGER NOT NULL DEFAULT 10800,
    alert_cooldown_seconds INTEGER NOT NULL DEFAULT 21600,
    email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    email_recipients JSONB NOT NULL DEFAULT '[]'::JSONB,
    webhook_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    webhook_url TEXT,
    cleanup_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    cleanup_interval_seconds INTEGER NOT NULL DEFAULT 86400,
    automatic_categories JSONB NOT NULL DEFAULT '[]'::JSONB,
    orphan_grace_seconds INTEGER NOT NULL DEFAULT 604800,
    updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT storage_maintenance_thresholds CHECK (
        warning_percent >= 1 AND critical_percent <= 99.9 AND warning_percent < critical_percent
    ),
    CONSTRAINT storage_maintenance_intervals CHECK (
        check_interval_seconds BETWEEN 60 AND 86400 AND
        stale_after_seconds BETWEEN 120 AND 604800 AND
        alert_cooldown_seconds BETWEEN 300 AND 2592000 AND
        cleanup_interval_seconds BETWEEN 3600 AND 604800 AND
        orphan_grace_seconds BETWEEN 86400 AND 31536000
    ),
    CONSTRAINT storage_maintenance_email_recipients_array CHECK (
        jsonb_typeof(email_recipients) = 'array'
    ),
    CONSTRAINT storage_maintenance_automatic_categories_empty CHECK (
        automatic_categories = '[]'::JSONB
    )
);

INSERT INTO public.storage_maintenance_config (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.maintenance_runtime_state (
    runtime_name VARCHAR(100) PRIMARY KEY,
    worker_id VARCHAR(255),
    started_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.maintenance_runs (
    id BIGSERIAL PRIMARY KEY,
    job_name VARCHAR(100) NOT NULL,
    trigger_type VARCHAR(20) NOT NULL CHECK (trigger_type IN ('scheduled', 'manual')),
    mode VARCHAR(20) NOT NULL CHECK (mode IN ('preview', 'execute', 'measure')),
    status VARCHAR(20) NOT NULL CHECK (
        status IN ('previewed', 'queued', 'running', 'completed', 'failed', 'cancelled')
    ),
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    preview_run_id BIGINT REFERENCES public.maintenance_runs(id) ON DELETE RESTRICT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
    candidate_count BIGINT NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    candidate_bytes BIGINT NOT NULL DEFAULT 0 CHECK (candidate_bytes >= 0),
    reclaimed_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reclaimed_bytes >= 0),
    failure_count BIGINT NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    last_error TEXT,
    configuration JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(configuration) = 'object'),
    result JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(result) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_maintenance_runs_job_activity
    ON public.maintenance_runs (job_name, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.maintenance_cleanup_items (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES public.maintenance_runs(id) ON DELETE CASCADE,
    relative_path VARCHAR(2048) NOT NULL,
    category VARCHAR(30) NOT NULL CHECK (category = 'derived'),
    observed_size_bytes BIGINT NOT NULL CHECK (observed_size_bytes >= 0),
    observed_modified_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'candidate' CHECK (
        status IN (
            'candidate', 'deleted', 'skipped-missing', 'skipped-changed',
            'skipped-referenced', 'skipped-unsafe', 'failed'
        )
    ),
    reclaimed_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reclaimed_bytes >= 0),
    error TEXT,
    completed_at TIMESTAMPTZ,
    UNIQUE (run_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_cleanup_items_run
    ON public.maintenance_cleanup_items (run_id, status, id);

CREATE TABLE IF NOT EXISTS public.maintenance_cleanup_tokens (
    token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    preview_run_id BIGINT NOT NULL UNIQUE REFERENCES public.maintenance_runs(id) ON DELETE CASCADE,
    confirmation_phrase VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT maintenance_cleanup_token_lifecycle CHECK (
        consumed_at IS NULL OR consumed_at >= created_at
    )
);

CREATE TABLE IF NOT EXISTS public.storage_measurements (
    id BIGSERIAL PRIMARY KEY,
    measured_at TIMESTAMPTZ NOT NULL,
    filesystem_total_bytes BIGINT,
    filesystem_used_bytes BIGINT,
    filesystem_available_bytes BIGINT,
    filesystem_used_percent NUMERIC(5,2),
    source_image_bytes BIGINT,
    source_image_count BIGINT,
    thumbnail_bytes BIGINT,
    thumbnail_count BIGINT,
    derived_vehicle_image_bytes BIGINT,
    derived_vehicle_image_count BIGINT,
    database_bytes BIGINT,
    docker_bytes BIGINT,
    backup_bytes BIGINT,
    host_snapshot_measured_at TIMESTAMPTZ,
    errors JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(errors) = 'array'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT storage_measurements_nonnegative CHECK (
        COALESCE(filesystem_total_bytes, 0) >= 0 AND
        COALESCE(filesystem_used_bytes, 0) >= 0 AND
        COALESCE(filesystem_available_bytes, 0) >= 0 AND
        COALESCE(source_image_bytes, 0) >= 0 AND COALESCE(source_image_count, 0) >= 0 AND
        COALESCE(thumbnail_bytes, 0) >= 0 AND COALESCE(thumbnail_count, 0) >= 0 AND
        COALESCE(derived_vehicle_image_bytes, 0) >= 0 AND COALESCE(derived_vehicle_image_count, 0) >= 0 AND
        COALESCE(database_bytes, 0) >= 0 AND COALESCE(docker_bytes, 0) >= 0 AND
        COALESCE(backup_bytes, 0) >= 0
    )
);

CREATE INDEX IF NOT EXISTS idx_storage_measurements_recent
    ON public.storage_measurements (measured_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.maintenance_alert_state (
    event_key VARCHAR(255) PRIMARY KEY,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('ok', 'warning', 'critical')),
    fingerprint CHAR(64),
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_notified_at TIMESTAMPTZ,
    next_eligible_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    occurrence_count BIGINT NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
    suppressed_count BIGINT NOT NULL DEFAULT 0 CHECK (suppressed_count >= 0),
    details JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(details) = 'object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.maintenance_alert_deliveries (
    id BIGSERIAL PRIMARY KEY,
    dedupe_key CHAR(64) NOT NULL UNIQUE CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
    event_key VARCHAR(255) NOT NULL REFERENCES public.maintenance_alert_state(event_key) ON DELETE CASCADE,
    channel_type VARCHAR(20) NOT NULL CHECK (channel_type IN ('email', 'webhook')),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(payload) = 'object'),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'retry', 'succeeded', 'dead')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(255),
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT maintenance_alert_delivery_lock CHECK (
        (status = 'processing' AND locked_at IS NOT NULL AND NULLIF(BTRIM(locked_by), '') IS NOT NULL)
        OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_maintenance_alert_deliveries_due
    ON public.maintenance_alert_deliveries (next_attempt_at, id)
    WHERE status IN ('pending', 'retry');

-- Maintenance webhook destination URLs can contain bearer credentials. Keep
-- them only in storage_maintenance_config; workers resolve the current value
-- immediately before delivery. This idempotently removes legacy queue copies
-- and destination-bearing error details without changing delivery status.
UPDATE public.maintenance_alert_deliveries
SET payload = payload - 'url',
    last_error = CASE WHEN last_error IS NULL THEN NULL
        ELSE 'Maintenance webhook delivery error details were redacted' END,
    updated_at = CURRENT_TIMESTAMP
WHERE channel_type = 'webhook'
  AND (payload ? 'url' OR last_error IS NOT NULL);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_attribute column_record
          ON column_record.attrelid = constraint_record.conrelid
         AND column_record.attnum = ANY (constraint_record.conkey)
        WHERE constraint_record.contype = 'f'
          AND constraint_record.conrelid = 'public.storage_maintenance_config'::regclass
          AND column_record.attname = 'updated_by_user_id'
    ) THEN
        ALTER TABLE public.storage_maintenance_config
            ADD CONSTRAINT storage_maintenance_config_updated_by_fkey
            FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_attribute column_record
          ON column_record.attrelid = constraint_record.conrelid
         AND column_record.attnum = ANY (constraint_record.conkey)
        WHERE constraint_record.contype = 'f'
          AND constraint_record.conrelid = 'public.maintenance_runs'::regclass
          AND column_record.attname = 'actor_user_id'
    ) THEN
        ALTER TABLE public.maintenance_runs
            ADD CONSTRAINT maintenance_runs_actor_user_fkey
            FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END;
$$;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072901_storage_monitoring_maintenance',
    'Add persisted storage thresholds, runtime liveness, exact category measurements, rate-limited maintenance alerts, and token-guarded manual derived-orphan cleanup.'
)
ON CONFLICT (version) DO NOTHING;
