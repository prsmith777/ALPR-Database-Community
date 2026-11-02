-- migration: 2026081403_vehicle_image_asset_catalog_campaign
-- Operator-controlled, preview-first population of the canonical Overview
-- catalog. Creating a run only freezes eligible read snapshots. A dedicated
-- worker hashes and validates those source JPEGs without publishing files;
-- canonical storage is written only after an operator confirms a bounded
-- batch against the exact completed preview fingerprint.
CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_catalog_runs (
  id BIGSERIAL PRIMARY KEY,
  phase VARCHAR(16) NOT NULL DEFAULT 'preview' CHECK (
    phase IN ('preview','catalog','completed')
  ),
  status VARCHAR(16) NOT NULL DEFAULT 'previewing' CHECK (
    status IN ('previewing','ready','running','paused','completed','cancelled','failed')
  ),
  max_read_id INTEGER NOT NULL CHECK (max_read_id >= 0),
  preview_cursor_read_id INTEGER NOT NULL DEFAULT 0 CHECK (
    preview_cursor_read_id >= 0 AND preview_cursor_read_id <= max_read_id
  ),
  candidate_reads INTEGER NOT NULL DEFAULT 0 CHECK (candidate_reads >= 0),
  batch_size INTEGER NOT NULL DEFAULT 5 CHECK (
    batch_size IN (1,5,25,250)
  ),
  preview_fingerprint CHAR(64) CHECK (
    preview_fingerprint IS NULL OR preview_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  actor_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  confirmed_actor_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
  last_error_code VARCHAR(80),
  last_error_details JSONB CHECK (
    last_error_details IS NULL OR jsonb_typeof(last_error_details) = 'object'
  ),
  confirmed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'previewing' AND phase = 'preview' AND preview_fingerprint IS NULL)
    OR (status IN ('ready','running') AND phase = 'catalog' AND preview_fingerprint IS NOT NULL)
    OR (status = 'paused')
    OR (status = 'completed' AND phase = 'completed' AND preview_fingerprint IS NOT NULL)
    OR (status IN ('cancelled','failed'))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_image_asset_catalog_one_active
  ON public.vehicle_image_asset_catalog_runs ((TRUE))
  WHERE status IN ('previewing','ready','running','paused');

CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_catalog_items (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.vehicle_image_asset_catalog_runs(id)
    ON DELETE RESTRICT,
  -- This is an immutable snapshot identifier, not a live ownership edge.
  -- Keeping it scalar preserves campaign evidence without blocking the
  -- application's existing single-read deletion flow.
  read_id INTEGER NOT NULL,
  snapshot_fingerprint CHAR(64) NOT NULL CHECK (
    snapshot_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  read_camera_name VARCHAR(120),
  read_timestamp TIMESTAMPTZ NOT NULL,
  source_status VARCHAR(20) NOT NULL CHECK (source_status = 'ready'),
  source_path TEXT NOT NULL CHECK (NULLIF(BTRIM(source_path), '') IS NOT NULL),
  source_kind VARCHAR(40) NOT NULL CHECK (
    source_kind IN (
      'overview_primary',
      'entry_overview_primary',
      'overview_fallback',
      'overview_pair_share',
      'entry_overview_route_fallback',
      'entry_overview_history'
    )
  ),
  -- Preserve the exact source-read provenance that was fingerprinted even if
  -- the live source read is later deleted.
  source_read_id INTEGER,
  source_updated_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ,
  source_score REAL,
  -- These are lossless evidence snapshots. Legacy malformed metadata must be
  -- materialized and terminalized per item, never abort the entire preview.
  detection_confidence REAL,
  detection_box JSONB,
  source_width INTEGER,
  source_height INTEGER,
  sampled_count SMALLINT,
  selection_metadata JSONB,
  prior_link_state VARCHAR(12) NOT NULL CHECK (
    prior_link_state IN ('absent','stale')
  ),
  preview_sha256 CHAR(64) CHECK (
    preview_sha256 IS NULL OR preview_sha256 ~ '^[0-9a-f]{64}$'
  ),
  preview_byte_size BIGINT CHECK (preview_byte_size IS NULL OR preview_byte_size > 0),
  preview_width INTEGER CHECK (preview_width IS NULL OR preview_width > 0),
  preview_height INTEGER CHECK (preview_height IS NULL OR preview_height > 0),
  canonical_path TEXT CHECK (
    canonical_path IS NULL OR canonical_path = 'derived/vehicle-assets/'
      || SUBSTRING(preview_sha256 FROM 1 FOR 2)
      || '/' || preview_sha256 || '.jpg'
  ),
  status VARCHAR(20) NOT NULL DEFAULT 'pending_preview' CHECK (
    status IN (
      'pending_preview','previewing','previewed','queued','processing',
      'cataloged','already_current','superseded','unavailable','invalid',
      'failed','cancelled'
    )
  ),
  failure_stage VARCHAR(12) CHECK (
    failure_stage IS NULL OR failure_stage IN ('preview','catalog')
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (
    operator_retry_count BETWEEN 0 AND 1
  ),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token UUID,
  heartbeat_at TIMESTAMPTZ,
  processing_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR jsonb_typeof(error_details) = 'object'
  ),
  asset_id BIGINT REFERENCES public.vehicle_image_assets(id) ON DELETE SET NULL,
  previewed_at TIMESTAMPTZ,
  cataloged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, read_id),
  CHECK (
    (status IN ('previewed','queued','processing','cataloged','already_current')
      AND preview_sha256 IS NOT NULL
      AND preview_byte_size IS NOT NULL
      AND preview_width IS NOT NULL
      AND preview_height IS NOT NULL
      AND canonical_path IS NOT NULL)
    OR status NOT IN ('previewed','queued','processing','cataloged','already_current')
  ),
  CHECK (
    (status IN ('previewing','processing')
      AND claim_token IS NOT NULL
      AND processing_deadline_at IS NOT NULL)
    OR (status NOT IN ('previewing','processing')
      AND claim_token IS NULL
      AND processing_deadline_at IS NULL)
  ),
  CHECK (
    (status = 'failed' AND failure_stage IS NOT NULL AND error_code IS NOT NULL)
    OR status <> 'failed'
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_catalog_items_run
  ON public.vehicle_image_asset_catalog_items (run_id, status, read_id, id);
CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_catalog_items_claim
  ON public.vehicle_image_asset_catalog_items (run_id, next_attempt_at, read_id, id)
  WHERE status IN ('pending_preview','previewing','queued','processing','failed');
CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_catalog_items_hash
  ON public.vehicle_image_asset_catalog_items (run_id, preview_sha256)
  WHERE preview_sha256 IS NOT NULL;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081403_vehicle_image_asset_catalog_campaign','Add a durable preview-first, operator-confirmed campaign for canonical Overview assets.')
ON CONFLICT(version) DO NOTHING;
