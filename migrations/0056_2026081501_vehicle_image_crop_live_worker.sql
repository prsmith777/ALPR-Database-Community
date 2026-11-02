-- migration: 2026081501_vehicle_image_crop_live_worker
-- Durable, default-off crop generation for canonical Overview assets that
-- become identity-eligible after the operator-controlled crop campaign. The
-- migration queues no work. The low-priority worker reuses the exact campaign
-- crop algorithm and yields whenever an operator crop campaign is active.
CREATE TABLE IF NOT EXISTS public.vehicle_image_crop_live_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  enabled_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (enabled = TRUE AND enabled_at IS NOT NULL)
    OR enabled = FALSE
  )
);

INSERT INTO public.vehicle_image_crop_live_control (
  singleton, enabled, enabled_by_user_id, enabled_at, disabled_at
) VALUES (TRUE, TRUE, NULL, CURRENT_TIMESTAMP, NULL)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_image_crop_live_jobs (
  id BIGSERIAL PRIMARY KEY,
  -- Snapshot scalars deliberately avoid foreign keys so durable worker
  -- evidence cannot block existing read or future asset-retention workflows.
  asset_id BIGINT NOT NULL UNIQUE CHECK (asset_id > 0),
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_path TEXT NOT NULL CHECK (NULLIF(BTRIM(source_path), '') IS NOT NULL),
  source_width INTEGER NOT NULL CHECK (source_width > 0),
  source_height INTEGER NOT NULL CHECK (source_height > 0),
  evidence_read_id INTEGER NOT NULL CHECK (evidence_read_id > 0),
  evidence_source_kind VARCHAR(40) NOT NULL CHECK (
    evidence_source_kind IN (
      'overview_primary','entry_overview_primary','overview_fallback',
      'overview_pair_share','entry_overview_route_fallback',
      'entry_overview_history'
    )
  ),
  evidence_source_path TEXT NOT NULL CHECK (
    NULLIF(BTRIM(evidence_source_path), '') IS NOT NULL
  ),
  evidence_source_updated_at TIMESTAMPTZ,
  detection_box JSONB NOT NULL CHECK (
    jsonb_typeof(detection_box) = 'object'
    AND detection_box ?& ARRAY['left','top','right','bottom']
  ),
  detection_confidence REAL CHECK (
    detection_confidence IS NULL
    OR (detection_confidence >= 0 AND detection_confidence <= 1)
  ),
  status VARCHAR(24) NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued','processing','ready','already_current','source_changed',
      'unavailable','invalid','failed'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
    attempt_count >= 0 AND attempt_count <= 5
  ),
  operator_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (
    operator_retry_count >= 0 AND operator_retry_count <= 1
  ),
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  claim_token UUID,
  heartbeat_at TIMESTAMPTZ,
  processing_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR jsonb_typeof(error_details) = 'object'
  ),
  derivative_id BIGINT REFERENCES public.vehicle_image_derivatives(id)
    ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'processing'
      AND claim_token IS NOT NULL AND processing_deadline_at IS NOT NULL)
    OR (status <> 'processing'
      AND claim_token IS NULL AND processing_deadline_at IS NULL)
  ),
  CHECK (
    (status IN ('source_changed','unavailable','invalid','failed')
      AND error_code IS NOT NULL)
    OR status NOT IN ('source_changed','unavailable','invalid','failed')
  ),
  CHECK (
    (status IN ('ready','already_current')
      AND derivative_id IS NOT NULL AND completed_at IS NOT NULL)
    OR status NOT IN ('ready','already_current')
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_image_crop_live_claim
  ON public.vehicle_image_crop_live_jobs (
    next_attempt_at, asset_id, id
  ) WHERE status IN ('queued','processing','failed');
CREATE INDEX IF NOT EXISTS idx_vehicle_image_crop_live_status
  ON public.vehicle_image_crop_live_jobs (status, updated_at DESC, id DESC);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081501_vehicle_image_crop_live_worker','Add default-off automatic canonical Overview crop generation after a completed operator crop campaign.')
ON CONFLICT(version) DO NOTHING;
