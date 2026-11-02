-- migration: 2026081506_vehicle_asset_attribute_campaign
-- Provider-neutral local attribute observations for immutable canonical crop bytes.
-- This migration is deliberately inert: it creates no run or job and does not
-- alter current read-owned attributes, ReID, assignments, events, or providers.
CREATE TABLE IF NOT EXISTS public.vehicle_asset_attribute_observations (
  id BIGSERIAL PRIMARY KEY,
  derivative_id BIGINT NOT NULL REFERENCES public.vehicle_image_derivatives(id)
    ON DELETE RESTRICT,
  attribute_key VARCHAR(40) NOT NULL CHECK (
    attribute_key IN ('color','body_type')
  ),
  provider VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(provider), '') IS NOT NULL
  ),
  model_version VARCHAR(120) NOT NULL CHECK (
    NULLIF(BTRIM(model_version), '') IS NOT NULL
  ),
  algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(algorithm_version), '') IS NOT NULL
  ),
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  status VARCHAR(12) NOT NULL CHECK (status IN ('ready','unknown')),
  attribute_value VARCHAR(120),
  confidence REAL CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  result_sha256 CHAR(64) NOT NULL CHECK (
    result_sha256 ~ '^[0-9a-f]{64}$'
  ),
  raw_result JSONB NOT NULL CHECK (jsonb_typeof(raw_result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (
    derivative_id, attribute_key, provider, model_version, algorithm_version
  ),
  CHECK (
    (status = 'ready' AND NULLIF(BTRIM(attribute_value), '') IS NOT NULL
      AND confidence IS NOT NULL)
    OR (status = 'unknown' AND attribute_value IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_asset_attribute_observations_contract
  ON public.vehicle_asset_attribute_observations (
    attribute_key, provider, model_version, algorithm_version, derivative_id
  );
CREATE INDEX IF NOT EXISTS idx_vehicle_asset_attribute_observations_value
  ON public.vehicle_asset_attribute_observations (
    attribute_key, attribute_value, confidence DESC, derivative_id
  ) WHERE status = 'ready';

CREATE OR REPLACE FUNCTION public.prevent_vehicle_asset_attribute_observation_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'vehicle_asset_attribute_observations content is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_asset_attribute_observations_immutable
  ON public.vehicle_asset_attribute_observations;
CREATE TRIGGER vehicle_asset_attribute_observations_immutable
BEFORE UPDATE ON public.vehicle_asset_attribute_observations
FOR EACH ROW EXECUTE FUNCTION public.prevent_vehicle_asset_attribute_observation_update();

CREATE TABLE IF NOT EXISTS public.vehicle_asset_attribute_runs (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(16) NOT NULL DEFAULT 'previewing' CHECK (
    status IN ('previewing','ready','running','paused','completed','cancelled','failed')
  ),
  max_derivative_id BIGINT NOT NULL CHECK (max_derivative_id >= 0),
  algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(algorithm_version), '') IS NOT NULL
  ),
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_asset_attribute_one_active
  ON public.vehicle_asset_attribute_runs ((TRUE))
  WHERE status IN ('previewing','ready','running','paused');

CREATE TABLE IF NOT EXISTS public.vehicle_asset_attribute_jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.vehicle_asset_attribute_runs(id)
    ON DELETE RESTRICT,
  derivative_id BIGINT NOT NULL REFERENCES public.vehicle_image_derivatives(id)
    ON DELETE RESTRICT,
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_path TEXT NOT NULL CHECK (NULLIF(BTRIM(source_path), '') IS NOT NULL),
  source_width INTEGER NOT NULL CHECK (source_width > 0),
  source_height INTEGER NOT NULL CHECK (source_height > 0),
  source_algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(source_algorithm_version), '') IS NOT NULL
  ),
  evidence_read_id INTEGER NOT NULL CHECK (evidence_read_id > 0),
  evidence_source_kind VARCHAR(40) NOT NULL,
  evidence_source_path TEXT NOT NULL CHECK (
    NULLIF(BTRIM(evidence_source_path), '') IS NOT NULL
  ),
  evidence_source_updated_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_preview' CHECK (
    status IN (
      'pending_preview','previewing','previewed','queued','processing',
      'ready','already_current','source_changed','invalid','failed','cancelled'
    )
  ),
  failure_stage VARCHAR(12) CHECK (
    failure_stage IS NULL OR failure_stage IN ('preview','observe')
  ),
  preview_result_sha256 CHAR(64) CHECK (
    preview_result_sha256 IS NULL OR preview_result_sha256 ~ '^[0-9a-f]{64}$'
  ),
  preview_result JSONB CHECK (
    preview_result IS NULL OR jsonb_typeof(preview_result) = 'object'
  ),
  preview_result_bytes INTEGER CHECK (
    preview_result_bytes IS NULL OR preview_result_bytes > 0
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
  observations_created SMALLINT CHECK (
    observations_created IS NULL OR observations_created BETWEEN 0 AND 2
  ),
  previewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, derivative_id),
  CHECK (
    (status IN ('previewed','queued','processing','ready','already_current')
      AND preview_result_sha256 IS NOT NULL
      AND preview_result IS NOT NULL
      AND preview_result_bytes > 0)
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
      AND observations_created IS NOT NULL AND completed_at IS NOT NULL)
    OR status NOT IN ('ready','already_current')
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_asset_attribute_jobs_run
  ON public.vehicle_asset_attribute_jobs (run_id, status, derivative_id, id);
CREATE INDEX IF NOT EXISTS idx_vehicle_asset_attribute_jobs_claim
  ON public.vehicle_asset_attribute_jobs (status, next_attempt_at, derivative_id, id)
  WHERE status IN ('pending_preview','previewing','queued','processing','failed');

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081506_vehicle_asset_attribute_campaign','Add inert immutable crop-owned local color and body-type observations plus a preview-first operator campaign without changing current ReID or external providers.')
ON CONFLICT(version) DO NOTHING;
