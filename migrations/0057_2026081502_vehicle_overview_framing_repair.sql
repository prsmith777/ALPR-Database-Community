-- migration: 2026081502_vehicle_overview_framing_repair
-- Operator-selected repair of genuinely clipped or overly tight direct
-- Overview images. Preview rows freeze the original ready image and its
-- acquisition profile. No migration work is queued, and the original image
-- remains the current Vehicle View until a replacement proves materially more
-- complete. Blur, exposure, and multi-vehicle review findings are never repair
-- eligibility by themselves.
ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_queue_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_queue_kind_check CHECK (
    vehicle_image_queue_kind IS NULL OR
    vehicle_image_queue_kind IN (
      'live','historical','manual','overview','overview_backfill','overview_repair'
    )
  );

CREATE TABLE IF NOT EXISTS public.vehicle_overview_framing_repair_runs (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(16) NOT NULL DEFAULT 'previewed' CHECK (
    status IN ('previewed','running','completed','cancelled')
  ),
  preview_fingerprint CHAR(64) NOT NULL CHECK (
    preview_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  created_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  confirmed_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_overview_framing_repair_one_active
  ON public.vehicle_overview_framing_repair_runs ((TRUE))
  WHERE status IN ('previewed','running');

CREATE TABLE IF NOT EXISTS public.vehicle_overview_framing_repair_jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.vehicle_overview_framing_repair_runs(id)
    ON DELETE CASCADE,
  -- Snapshot scalars intentionally have no plate_reads foreign key. Durable
  -- repair evidence must not block the existing per-read delete operation.
  read_id INTEGER NOT NULL CHECK (read_id > 0),
  plate_number VARCHAR(32),
  camera_name VARCHAR(120) NOT NULL CHECK (NULLIF(BTRIM(camera_name), '') IS NOT NULL),
  read_timestamp_text TEXT NOT NULL CHECK (NULLIF(BTRIM(read_timestamp_text), '') IS NOT NULL),
  direction_label VARCHAR(80),
  prior_image_path TEXT NOT NULL CHECK (NULLIF(BTRIM(prior_image_path), '') IS NOT NULL),
  prior_image_status VARCHAR(24) NOT NULL CHECK (prior_image_status = 'ready'),
  prior_queue_kind VARCHAR(24),
  prior_attempt_count INTEGER NOT NULL CHECK (prior_attempt_count >= 0),
  prior_retryable BOOLEAN NOT NULL,
  prior_error_code VARCHAR(80),
  prior_source_kind VARCHAR(40) NOT NULL CHECK (
    prior_source_kind IN ('overview_primary','entry_overview_primary')
  ),
  prior_source_read_id INTEGER,
  prior_image_timestamp_text TEXT,
  prior_image_score REAL,
  prior_detection_confidence REAL CHECK (
    prior_detection_confidence IS NULL
    OR (prior_detection_confidence >= 0 AND prior_detection_confidence <= 1)
  ),
  prior_detection_box JSONB CHECK (
    prior_detection_box IS NULL OR jsonb_typeof(prior_detection_box) = 'object'
  ),
  prior_image_width INTEGER CHECK (prior_image_width IS NULL OR prior_image_width > 0),
  prior_image_height INTEGER CHECK (prior_image_height IS NULL OR prior_image_height > 0),
  prior_sampled_count INTEGER CHECK (prior_sampled_count IS NULL OR prior_sampled_count >= 0),
  prior_selection_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(prior_selection_metadata) = 'object'
  ),
  prior_image_updated_at_text TEXT NOT NULL CHECK (
    NULLIF(BTRIM(prior_image_updated_at_text), '') IS NOT NULL
  ),
  audited_detection_box JSONB NOT NULL CHECK (
    jsonb_typeof(audited_detection_box) = 'object'
    AND audited_detection_box ?& ARRAY['left','top','right','bottom']
  ),
  audited_completeness_tier SMALLINT NOT NULL CHECK (
    audited_completeness_tier IN (0,1)
  ),
  audited_edge_margin REAL NOT NULL CHECK (audited_edge_margin >= 0 AND audited_edge_margin < 0.015),
  audited_edge_contacts SMALLINT NOT NULL CHECK (audited_edge_contacts BETWEEN 0 AND 4),
  repair_reason VARCHAR(40) NOT NULL CHECK (
    repair_reason IN ('VEHICLE_TOUCHES_IMAGE_EDGE','VEHICLE_FRAMING_TOO_TIGHT')
  ),
  profile_id BIGINT NOT NULL CHECK (profile_id > 0),
  profile_revision BIGINT NOT NULL CHECK (profile_revision > 0),
  overview_context VARCHAR(12) NOT NULL CHECK (overview_context IN ('street','entry')),
  source_camera_name VARCHAR(120) NOT NULL CHECK (NULLIF(BTRIM(source_camera_name), '') IS NOT NULL),
  source_camera_short_name VARCHAR(80),
  expected_delta_ms INTEGER NOT NULL CHECK (ABS(expected_delta_ms) <= 30000),
  tolerance_ms INTEGER NOT NULL CHECK (tolerance_ms BETWEEN 250 AND 3000),
  status VARCHAR(20) NOT NULL DEFAULT 'previewed' CHECK (
    status IN (
      'previewed','queued','processing','repaired','preserved',
      'source_changed','unavailable','failed','cancelled'
    )
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  claim_token UUID,
  heartbeat_at TIMESTAMPTZ,
  processing_deadline_at TIMESTAMPTZ,
  hard_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR jsonb_typeof(error_details) = 'object'
  ),
  replacement_image_path TEXT,
  replacement_detection_box JSONB CHECK (
    replacement_detection_box IS NULL OR jsonb_typeof(replacement_detection_box) = 'object'
  ),
  replacement_completeness_tier SMALLINT CHECK (
    replacement_completeness_tier IS NULL OR replacement_completeness_tier BETWEEN 0 AND 3
  ),
  replacement_edge_margin REAL CHECK (
    replacement_edge_margin IS NULL OR replacement_edge_margin BETWEEN 0 AND 1
  ),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, read_id),
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL
      AND processing_deadline_at IS NOT NULL AND hard_deadline_at IS NOT NULL)
    OR (status <> 'processing' AND claim_token IS NULL
      AND processing_deadline_at IS NULL AND hard_deadline_at IS NULL)
  ),
  CHECK (
    (status IN ('source_changed','unavailable','failed','preserved') AND error_code IS NOT NULL)
    OR status NOT IN ('source_changed','unavailable','failed','preserved')
  ),
  CHECK (
    (status = 'repaired' AND replacement_image_path IS NOT NULL
      AND replacement_detection_box IS NOT NULL
      AND replacement_completeness_tier IS NOT NULL
      AND replacement_edge_margin IS NOT NULL AND completed_at IS NOT NULL)
    OR status <> 'repaired'
  )
);

CREATE INDEX IF NOT EXISTS idx_overview_framing_repair_jobs_claim
  ON public.vehicle_overview_framing_repair_jobs (
    status, next_attempt_at, id
  ) WHERE status IN ('queued','processing','failed');
CREATE INDEX IF NOT EXISTS idx_overview_framing_repair_jobs_run
  ON public.vehicle_overview_framing_repair_jobs (run_id, status, id);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081502_vehicle_overview_framing_repair','Add inert preview-first bounded repair jobs for operator-selected edge-clipped or overly tight direct Overview images while preserving the current image unless a replacement proves more complete.')
ON CONFLICT(version) DO NOTHING;
