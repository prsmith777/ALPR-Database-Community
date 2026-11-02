-- migration: 2026081406_vehicle_image_crop_campaign
-- Asset-owned vehicle crops derived from immutable canonical Overview JPEGs.
-- The migration is deliberately inert: it creates no run, job, derivative,
-- file, embedding, attribute, ReID result, or external-provider request.
CREATE TABLE IF NOT EXISTS public.vehicle_image_derivatives (
  id BIGSERIAL PRIMARY KEY,
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  derivative_kind VARCHAR(32) NOT NULL CHECK (
    derivative_kind = 'vehicle_crop'
  ),
  algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(algorithm_version), '') IS NOT NULL
  ),
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  content_sha256 CHAR(64) NOT NULL CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  storage_path TEXT NOT NULL CHECK (
    storage_path = 'derived/vehicle-crops/'
      || SUBSTRING(content_sha256 FROM 1 FOR 2)
      || '/' || content_sha256 || '.jpg'
  ),
  media_type VARCHAR(40) NOT NULL DEFAULT 'image/jpeg' CHECK (
    media_type = 'image/jpeg'
  ),
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  image_width INTEGER NOT NULL CHECK (image_width > 0),
  image_height INTEGER NOT NULL CHECK (image_height > 0),
  crop_box JSONB NOT NULL CHECK (
    jsonb_typeof(crop_box) = 'object'
    AND crop_box ?& ARRAY['left','top','width','height','paddingRatio']
    AND jsonb_typeof(crop_box->'left') = 'number'
    AND jsonb_typeof(crop_box->'top') = 'number'
    AND jsonb_typeof(crop_box->'width') = 'number'
    AND jsonb_typeof(crop_box->'height') = 'number'
    AND jsonb_typeof(crop_box->'paddingRatio') = 'number'
    AND (crop_box->>'left')::integer >= 0
    AND (crop_box->>'top')::integer >= 0
    AND (crop_box->>'width')::integer > 0
    AND (crop_box->>'height')::integer > 0
    AND (crop_box->>'paddingRatio')::numeric BETWEEN 0 AND 0.5
  ),
  detector_model VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(detector_model), '') IS NOT NULL
  ),
  detection_confidence REAL CHECK (
    detection_confidence IS NULL OR detection_confidence BETWEEN 0 AND 1
  ),
  evidence_read_id INTEGER NOT NULL CHECK (evidence_read_id > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (asset_id, derivative_kind, algorithm_version)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_image_derivatives_content
  ON public.vehicle_image_derivatives (content_sha256, id);
CREATE INDEX IF NOT EXISTS idx_vehicle_image_derivatives_storage
  ON public.vehicle_image_derivatives (storage_path, id);

CREATE OR REPLACE FUNCTION public.prevent_vehicle_image_derivative_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'vehicle_image_derivatives content is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_image_derivatives_immutable
  ON public.vehicle_image_derivatives;
CREATE TRIGGER vehicle_image_derivatives_immutable
BEFORE UPDATE ON public.vehicle_image_derivatives
FOR EACH ROW EXECUTE FUNCTION public.prevent_vehicle_image_derivative_update();

CREATE TABLE IF NOT EXISTS public.vehicle_image_crop_runs (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(16) NOT NULL DEFAULT 'previewing' CHECK (
    status IN ('previewing','ready','running','paused','completed','cancelled','failed')
  ),
  max_asset_id BIGINT NOT NULL CHECK (max_asset_id >= 0),
  preview_fingerprint CHAR(64) CHECK (
    preview_fingerprint IS NULL OR preview_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  batch_size INTEGER NOT NULL DEFAULT 5 CHECK (
    batch_size IN (1,5,25,250)
  ),
  actor_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  confirmed_actor_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
  confirmed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code VARCHAR(80),
  last_error_details JSONB CHECK (
    last_error_details IS NULL OR jsonb_typeof(last_error_details) = 'object'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'previewing' AND preview_fingerprint IS NULL)
    OR (status IN ('ready','running','paused','completed')
      AND preview_fingerprint IS NOT NULL)
    OR status IN ('cancelled','failed')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_image_crop_one_active
  ON public.vehicle_image_crop_runs ((TRUE))
  WHERE status IN ('previewing','ready','running','paused');

CREATE TABLE IF NOT EXISTS public.vehicle_image_crop_jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.vehicle_image_crop_runs(id)
    ON DELETE RESTRICT,
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_path TEXT NOT NULL CHECK (NULLIF(BTRIM(source_path), '') IS NOT NULL),
  source_width INTEGER NOT NULL CHECK (source_width > 0),
  source_height INTEGER NOT NULL CHECK (source_height > 0),
  evidence_read_id INTEGER NOT NULL CHECK (evidence_read_id > 0),
  evidence_source_kind VARCHAR(40) NOT NULL,
  evidence_source_path TEXT NOT NULL CHECK (
    NULLIF(BTRIM(evidence_source_path), '') IS NOT NULL
  ),
  evidence_source_updated_at TIMESTAMPTZ,
  detection_box JSONB,
  detection_confidence REAL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_preview' CHECK (
    status IN (
      'pending_preview','previewing','previewed','queued','processing',
      'ready','already_current','source_changed','invalid','failed','cancelled'
    )
  ),
  failure_stage VARCHAR(12) CHECK (
    failure_stage IS NULL OR failure_stage IN ('preview','catalog')
  ),
  preview_sha256 CHAR(64) CHECK (
    preview_sha256 IS NULL OR preview_sha256 ~ '^[0-9a-f]{64}$'
  ),
  preview_path TEXT CHECK (
    preview_path IS NULL OR preview_path = 'derived/vehicle-crops/'
      || SUBSTRING(preview_sha256 FROM 1 FOR 2)
      || '/' || preview_sha256 || '.jpg'
  ),
  preview_byte_size BIGINT CHECK (
    preview_byte_size IS NULL OR preview_byte_size > 0
  ),
  preview_width INTEGER CHECK (preview_width IS NULL OR preview_width > 0),
  preview_height INTEGER CHECK (preview_height IS NULL OR preview_height > 0),
  preview_crop_box JSONB CHECK (
    preview_crop_box IS NULL OR jsonb_typeof(preview_crop_box) = 'object'
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (
    operator_retry_count BETWEEN 0 AND 1
  ),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token UUID,
  processing_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR jsonb_typeof(error_details) = 'object'
  ),
  derivative_id BIGINT REFERENCES public.vehicle_image_derivatives(id)
    ON DELETE SET NULL,
  previewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, asset_id),
  CHECK (
    (status IN ('previewed','queued','processing','ready','already_current')
      AND preview_sha256 IS NOT NULL AND preview_path IS NOT NULL
      AND preview_byte_size IS NOT NULL AND preview_width IS NOT NULL
      AND preview_height IS NOT NULL AND preview_crop_box IS NOT NULL)
    OR status NOT IN ('previewed','queued','processing','ready','already_current')
  ),
  CHECK (
    (status IN ('previewing','processing')
      AND claim_token IS NOT NULL AND processing_deadline_at IS NOT NULL)
    OR (status NOT IN ('previewing','processing')
      AND claim_token IS NULL AND processing_deadline_at IS NULL)
  ),
  CHECK (
    (status IN ('source_changed','invalid','failed') AND error_code IS NOT NULL)
    OR status NOT IN ('source_changed','invalid','failed')
  ),
  CHECK (
    (status IN ('ready','already_current')
      AND derivative_id IS NOT NULL AND completed_at IS NOT NULL)
    OR status NOT IN ('ready','already_current')
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_image_crop_jobs_claim
  ON public.vehicle_image_crop_jobs (
    run_id, status, next_attempt_at, asset_id, id
  ) WHERE status IN (
    'pending_preview','previewing','queued','processing','failed'
  );
CREATE INDEX IF NOT EXISTS idx_vehicle_image_crop_jobs_hash
  ON public.vehicle_image_crop_jobs (run_id, preview_sha256)
  WHERE preview_sha256 IS NOT NULL;

ALTER TABLE public.storage_reconciliation_runs
  ADD COLUMN IF NOT EXISTS max_vehicle_image_derivative_id BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vehicle_image_derivative_cursor BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.storage_reconciliation_runs
  DROP CONSTRAINT IF EXISTS storage_reconciliation_phase;
ALTER TABLE public.storage_reconciliation_runs
  ADD CONSTRAINT storage_reconciliation_phase CHECK (
    phase IN (
      'filesystem', 'plate-reads',
      'vehicle-image-assets', 'vehicle-image-derivatives', 'completed'
    )
  );

ALTER TABLE public.storage_reconciliation_runs
  DROP CONSTRAINT IF EXISTS storage_reconciliation_counts;
ALTER TABLE public.storage_reconciliation_runs
  ADD CONSTRAINT storage_reconciliation_counts CHECK (
    max_plate_read_id >= 0
    AND max_vehicle_image_asset_id >= 0
    AND max_vehicle_image_derivative_id >= 0
    AND plate_read_cursor >= 0
    AND vehicle_image_asset_cursor >= 0
    AND vehicle_image_derivative_cursor >= 0
    AND files_scanned >= 0 AND bytes_scanned >= 0
    AND references_checked >= 0 AND recent_files_skipped >= 0
    AND skipped_entries >= 0 AND error_count >= 0
    AND orphan_files >= 0 AND orphan_bytes >= 0
    AND missing_reference_paths >= 0
  );

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081406_vehicle_image_crop_campaign','Add inert asset-owned canonical Overview vehicle crops with preview-first bounded operator batches and storage-reference protection.')
ON CONFLICT(version) DO NOTHING;
