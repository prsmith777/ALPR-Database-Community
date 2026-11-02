-- migration: 2026081006_entry_overview_history_backfill
-- Direction-independent Gate Overview history is deliberately separate from
-- the live direction profiles. A run first materializes an immutable preview;
-- confirmation may queue only that exact preview. No migration statement
-- enqueues a read or changes an existing Vehicle View.
CREATE TABLE IF NOT EXISTS public.vehicle_entry_overview_history_profiles (
  id BIGSERIAL PRIMARY KEY,
  profile_key CHAR(64) NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  profile_kind VARCHAR(32) NOT NULL DEFAULT 'entry_history'
    CHECK (profile_kind = 'entry_history'),
  source_kind VARCHAR(32) NOT NULL DEFAULT 'entry_overview_history'
    CHECK (source_kind = 'entry_overview_history'),
  overview_context VARCHAR(16) NOT NULL DEFAULT 'entry'
    CHECK (overview_context = 'entry'),
  source_camera_name VARCHAR(120) NOT NULL
    CHECK (BTRIM(source_camera_name) = 'Gate Overview'),
  source_camera_short_name VARCHAR(80) NOT NULL
    CHECK (BTRIM(source_camera_short_name) = 'Overview01'),
  plate_camera_name VARCHAR(120) NOT NULL CHECK (
    LOWER(BTRIM(plate_camera_name)) IN ('gate lpr 1','gate lpr 2')
  ),
  expected_delta_ms INTEGER NOT NULL CHECK (expected_delta_ms BETWEEN -30000 AND 30000),
  tolerance_ms INTEGER NOT NULL DEFAULT 3000 CHECK (tolerance_ms = 3000),
  algorithm_revision VARCHAR(80) NOT NULL CHECK (BTRIM(algorithm_revision) <> ''),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  supersedes_profile_id BIGINT REFERENCES public.vehicle_entry_overview_history_profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disabled_at TIMESTAMPTZ,
  UNIQUE (profile_key, revision),
  CHECK ((enabled = TRUE AND disabled_at IS NULL)
      OR (enabled = FALSE AND disabled_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_overview_history_profile_enabled
  ON public.vehicle_entry_overview_history_profiles (LOWER(BTRIM(plate_camera_name)))
  WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_entry_overview_history_profile_versions
  ON public.vehicle_entry_overview_history_profiles (profile_key, revision DESC, id DESC);

CREATE OR REPLACE FUNCTION public.guard_entry_overview_history_profile_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.profile_key, NEW.revision, NEW.profile_kind, NEW.source_kind,
    NEW.overview_context, NEW.source_camera_name, NEW.source_camera_short_name,
    NEW.plate_camera_name, NEW.expected_delta_ms, NEW.tolerance_ms,
    NEW.algorithm_revision, NEW.supersedes_profile_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.profile_key, OLD.revision, OLD.profile_kind, OLD.source_kind,
    OLD.overview_context, OLD.source_camera_name, OLD.source_camera_short_name,
    OLD.plate_camera_name, OLD.expected_delta_ms, OLD.tolerance_ms,
    OLD.algorithm_revision, OLD.supersedes_profile_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Gate Overview history profile snapshots are immutable; create a new revision.';
  END IF;
  IF OLD.enabled = FALSE AND (
    NEW.enabled IS DISTINCT FROM OLD.enabled
    OR NEW.disabled_at IS DISTINCT FROM OLD.disabled_at
  ) THEN
    RAISE EXCEPTION 'Disabled Gate Overview history profile snapshots cannot be revived or changed.';
  END IF;
  IF OLD.enabled = TRUE AND NOT (
    (NEW.enabled = TRUE AND NEW.disabled_at IS NULL)
    OR (NEW.enabled = FALSE AND NEW.disabled_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Gate Overview history profile retirement must be one-way and timestamped.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_entry_overview_history_profile_snapshot
  ON public.vehicle_entry_overview_history_profiles;
CREATE TRIGGER trg_guard_entry_overview_history_profile_snapshot
BEFORE UPDATE ON public.vehicle_entry_overview_history_profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_entry_overview_history_profile_snapshot();

ALTER TABLE public.vehicle_entry_overview_history_profiles
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_history_profiles_check;
ALTER TABLE public.vehicle_entry_overview_history_profiles
  ADD CONSTRAINT vehicle_entry_overview_history_profiles_check CHECK (
    (enabled = TRUE AND disabled_at IS NULL)
    OR (enabled = FALSE AND disabled_at IS NOT NULL)
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS public.vehicle_entry_overview_backfill_runs (
  id BIGSERIAL PRIMARY KEY,
  scope_key CHAR(64) NOT NULL,
  preview_fingerprint CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'previewed' CHECK (
    status IN ('previewed','running','paused','completed','cancelled')
  ),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  plate_camera_names JSONB NOT NULL,
  profile_snapshot JSONB NOT NULL,
  daylight_provider VARCHAR(80) NOT NULL,
  daylight_model VARCHAR(80) NOT NULL,
  algorithm_revision VARCHAR(80) NOT NULL,
  batch_size INTEGER NOT NULL CHECK (batch_size BETWEEN 1 AND 500),
  confirmed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (end_at > start_at),
  CHECK (jsonb_typeof(plate_camera_names) = 'array'),
  CHECK (jsonb_typeof(profile_snapshot) = 'array')
);

CREATE TABLE IF NOT EXISTS public.vehicle_entry_overview_backfill_jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.vehicle_entry_overview_backfill_runs(id) ON DELETE RESTRICT,
  read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE RESTRICT,
  semantic_key CHAR(64) NOT NULL,
  profile_id BIGINT NOT NULL REFERENCES public.vehicle_entry_overview_history_profiles(id) ON DELETE RESTRICT,
  profile_key CHAR(64) NOT NULL,
  profile_revision BIGINT NOT NULL CHECK (profile_revision > 0),
  profile_kind VARCHAR(32) NOT NULL DEFAULT 'entry_history' CHECK (profile_kind = 'entry_history'),
  source_kind VARCHAR(32) NOT NULL DEFAULT 'entry_overview_history'
    CHECK (source_kind = 'entry_overview_history'),
  overview_context VARCHAR(16) NOT NULL DEFAULT 'entry' CHECK (overview_context = 'entry'),
  source_camera_name VARCHAR(120) NOT NULL CHECK (BTRIM(source_camera_name) = 'Gate Overview'),
  source_camera_short_name VARCHAR(80) NOT NULL CHECK (BTRIM(source_camera_short_name) = 'Overview01'),
  plate_camera_name VARCHAR(120) NOT NULL,
  read_timestamp TIMESTAMPTZ NOT NULL,
  anchor_at TIMESTAMPTZ NOT NULL,
  expected_delta_ms INTEGER NOT NULL,
  tolerance_ms INTEGER NOT NULL DEFAULT 3000 CHECK (tolerance_ms = 3000),
  algorithm_revision VARCHAR(80) NOT NULL,
  daylight_provider VARCHAR(80) NOT NULL,
  daylight_model VARCHAR(80) NOT NULL,
  daylight_status VARCHAR(24) NOT NULL CHECK (
    daylight_status IN ('eligible','needs_preflight','nighttime','unverified','live_busy','preserved')
  ),
  daylight_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'previewed' CHECK (
    status IN ('previewed','queued','processing','ready','failed','unavailable','cancelled','superseded')
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token UUID,
  heartbeat_at TIMESTAMPTZ,
  processing_deadline_at TIMESTAMPTZ,
  hard_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB,
  operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (operator_retry_count BETWEEN 0 AND 1),
  operator_retry_at TIMESTAMPTZ,
  operator_retry_error_code VARCHAR(80),
  prior_state_fingerprint CHAR(64) NOT NULL,
  prior_image_path TEXT,
  prior_image_status VARCHAR(20),
  prior_queue_kind VARCHAR(24),
  prior_attempt_count SMALLINT,
  prior_retryable BOOLEAN,
  prior_error_code VARCHAR(80),
  prior_source_kind VARCHAR(32),
  prior_overview_candidate_id BIGINT,
  prior_source_read_id INTEGER,
  prior_image_timestamp TIMESTAMPTZ,
  prior_image_score REAL,
  prior_detection_confidence REAL,
  prior_detection_box JSONB,
  prior_image_width INTEGER,
  prior_image_height INTEGER,
  prior_sampled_count SMALLINT,
  prior_selection_metadata JSONB,
  confirmed_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, read_id),
  CHECK (jsonb_typeof(daylight_evidence) = 'object'),
  CHECK (error_details IS NULL OR jsonb_typeof(error_details) = 'object'),
  CHECK (prior_detection_box IS NULL OR jsonb_typeof(prior_detection_box) = 'object'),
  CHECK (prior_selection_metadata IS NULL OR jsonb_typeof(prior_selection_metadata) = 'object')
);

-- Keep migration replay safe if a development snapshot created this new table
-- before the complete provenance snapshot was added.
ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  ADD COLUMN IF NOT EXISTS prior_overview_candidate_id BIGINT,
  ADD COLUMN IF NOT EXISTS prior_source_read_id INTEGER,
  ADD COLUMN IF NOT EXISTS operator_retry_count SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS operator_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operator_retry_error_code VARCHAR(80);

ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_backfill_jobs_operator_retry_count_check;
ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  ADD CONSTRAINT vehicle_entry_overview_backfill_jobs_operator_retry_count_check CHECK (
    operator_retry_count BETWEEN 0 AND 1
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_entry_overview_backfill_jobs_claim
  ON public.vehicle_entry_overview_backfill_jobs (read_timestamp, id)
  WHERE status IN ('queued','processing','failed');

CREATE INDEX IF NOT EXISTS idx_entry_overview_backfill_jobs_run
  ON public.vehicle_entry_overview_backfill_jobs (run_id, status, read_timestamp, id);

ALTER TABLE public.vehicle_entry_overview_backfill_runs
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_backfill_runs_scope_key_key;
ALTER TABLE public.vehicle_entry_overview_backfill_runs
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_backfill_runs_preview_fingerprint_key;
ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_backfill_jobs_semantic_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_overview_backfill_active_scope
  ON public.vehicle_entry_overview_backfill_runs (scope_key)
  WHERE status <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_overview_backfill_active_preview
  ON public.vehicle_entry_overview_backfill_runs (preview_fingerprint)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_entry_overview_backfill_jobs_semantic
  ON public.vehicle_entry_overview_backfill_jobs (semantic_key, id);

ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_backfill_jobs_daylight_status_check;
ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  ADD CONSTRAINT vehicle_entry_overview_backfill_jobs_daylight_status_check CHECK (
    daylight_status IN ('eligible','needs_preflight','nighttime','unverified','live_busy','preserved')
  ) NOT VALID;

ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS vehicle_image_backfill_job_id BIGINT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plate_reads_vehicle_image_backfill_job_fkey'
      AND conrelid = 'public.plate_reads'::regclass
  ) THEN
    ALTER TABLE public.plate_reads
      ADD CONSTRAINT plate_reads_vehicle_image_backfill_job_fkey
      FOREIGN KEY (vehicle_image_backfill_job_id)
      REFERENCES public.vehicle_entry_overview_backfill_jobs(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.blue_iris_timeline_exports
  ADD COLUMN IF NOT EXISTS profile_kind VARCHAR(32),
  ADD COLUMN IF NOT EXISTS profile_identity CHAR(64);

ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_profile_kind_check;
ALTER TABLE public.blue_iris_timeline_exports
  ADD CONSTRAINT blue_iris_timeline_exports_profile_kind_check CHECK (
    profile_kind IS NULL OR profile_kind IN ('pair','entry_history')
  ) NOT VALID;

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_source_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_source_kind_check CHECK (
    vehicle_image_source_kind IS NULL OR
    vehicle_image_source_kind IN (
      'legacy_plate_camera','overview_primary','entry_overview_primary',
      'overview_fallback','overview_pair_share','entry_lpr_fallback',
      'entry_overview_route_fallback','entry_overview_history'
    )
  ) NOT VALID;

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_queue_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_queue_kind_check CHECK (
    vehicle_image_queue_kind IS NULL OR
    vehicle_image_queue_kind IN ('live','historical','manual','overview','overview_backfill','overview_repair')
  ) NOT VALID;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081006_entry_overview_history_backfill','Add immutable direction-independent Gate Overview history profiles and preview-first, bounded, resumable backfill runs without auto-queueing reads.')
ON CONFLICT(version) DO NOTHING;
