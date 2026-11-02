-- migration: 2026081404_vehicle_image_asset_live_catalog
-- Durable, default-off cataloging for Overview images that become ready after
-- the initial operator campaign. The live worker is additionally gated on a
-- completed campaign and yields whenever an operator campaign is active. No
-- jobs are inserted by the migration, and current Vehicle View readiness does
-- not depend on this queue.
CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_live_catalog_control (
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

INSERT INTO public.vehicle_image_asset_live_catalog_control (
  singleton, enabled, enabled_by_user_id, enabled_at, disabled_at
) VALUES (TRUE, TRUE, NULL, CURRENT_TIMESTAMP, NULL)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_live_catalog_jobs (
  id BIGSERIAL PRIMARY KEY,
  -- Deliberately not a foreign key: durable job evidence must not block the
  -- existing single-read deletion lifecycle.
  read_id INTEGER NOT NULL UNIQUE CHECK (read_id > 0),
  source_path_snapshot TEXT NOT NULL CHECK (
    NULLIF(BTRIM(source_path_snapshot), '') IS NOT NULL
  ),
  source_kind_snapshot VARCHAR(40) NOT NULL CHECK (
    source_kind_snapshot IN (
      'overview_primary',
      'entry_overview_primary',
      'overview_fallback',
      'overview_pair_share',
      'entry_overview_route_fallback',
      'entry_overview_history'
    )
  ),
  source_updated_at_snapshot TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued','processing','cataloged','superseded',
      'unavailable','invalid','failed'
    )
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND 5
  ),
  operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (
    operator_retry_count BETWEEN 0 AND 1
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
  asset_id BIGINT REFERENCES public.vehicle_image_assets(id) ON DELETE SET NULL,
  cataloged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL
      AND processing_deadline_at IS NOT NULL)
    OR (status <> 'processing' AND claim_token IS NULL
      AND processing_deadline_at IS NULL)
  ),
  CHECK (
    (status = 'cataloged' AND asset_id IS NOT NULL AND cataloged_at IS NOT NULL)
    OR status <> 'cataloged'
  ),
  CHECK (
    (status IN ('superseded','unavailable','invalid','failed')
      AND error_code IS NOT NULL)
    OR status NOT IN ('superseded','unavailable','invalid','failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_live_catalog_claim
  ON public.vehicle_image_asset_live_catalog_jobs (
    next_attempt_at, read_id, id
  ) WHERE status IN ('queued','processing','failed');
CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_live_catalog_status
  ON public.vehicle_image_asset_live_catalog_jobs (status, updated_at DESC, id DESC);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081404_vehicle_image_asset_live_catalog','Add default-off, post-campaign automatic cataloging for newly ready Overview assets.')
ON CONFLICT(version) DO NOTHING;
