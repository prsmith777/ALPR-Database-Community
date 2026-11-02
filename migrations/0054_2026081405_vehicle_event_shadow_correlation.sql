-- migration: 2026081405_vehicle_event_shadow_correlation
-- Provider-neutral shadow passage events built only from current,
-- identity-eligible canonical Overview links. The correlator is default-off,
-- never gates ingestion or Vehicle View readiness, and does not alter the
-- current ReID, cluster, attribute, notification, or plate-review paths.
CREATE TABLE IF NOT EXISTS public.vehicle_event_shadow_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  settle_seconds INTEGER NOT NULL DEFAULT 20 CHECK (
    settle_seconds BETWEEN 5 AND 300
  ),
  batch_size INTEGER NOT NULL DEFAULT 25 CHECK (
    batch_size IN (5,25,100)
  ),
  enabled_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((enabled = TRUE AND enabled_at IS NOT NULL) OR enabled = FALSE)
);

INSERT INTO public.vehicle_event_shadow_control (
  singleton, enabled, settle_seconds, batch_size, disabled_at
) VALUES (TRUE, FALSE, 20, 25, CURRENT_TIMESTAMP)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_events (
  id BIGSERIAL PRIMARY KEY,
  event_identity CHAR(64) NOT NULL UNIQUE CHECK (
    event_identity ~ '^[0-9a-f]{64}$'
  ),
  status VARCHAR(16) NOT NULL DEFAULT 'shadow' CHECK (
    status IN ('shadow','retired')
  ),
  overview_context VARCHAR(12) NOT NULL CHECK (
    overview_context IN ('street','entry')
  ),
  correlation_class VARCHAR(20) NOT NULL CHECK (
    correlation_class IN ('shared_asset','timed_pair')
  ),
  event_timestamp TIMESTAMPTZ NOT NULL,
  first_read_at TIMESTAMPTZ NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL,
  effective_plate_snapshot VARCHAR(32) NOT NULL CHECK (
    NULLIF(BTRIM(effective_plate_snapshot), '') IS NOT NULL
  ),
  direction_label_snapshot VARCHAR(100),
  correlation_algorithm VARCHAR(80) NOT NULL,
  correlation_revision INTEGER NOT NULL DEFAULT 1 CHECK (
    correlation_revision > 0
  ),
  decision_metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (
    jsonb_typeof(decision_metadata) = 'object'
  ),
  retired_reason VARCHAR(80),
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (first_read_at <= last_read_at),
  CHECK (
    (status = 'shadow' AND retired_reason IS NULL AND retired_at IS NULL)
    OR (status = 'retired' AND retired_reason IS NOT NULL AND retired_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_events_shadow_recent
  ON public.vehicle_events (event_timestamp DESC, id DESC)
  WHERE status = 'shadow';

CREATE TABLE IF NOT EXISTS public.vehicle_event_reads (
  event_id BIGINT NOT NULL REFERENCES public.vehicle_events(id) ON DELETE CASCADE,
  -- Immutable evidence scalar: event history must not block single-read deletion.
  read_id INTEGER NOT NULL CHECK (read_id > 0),
  role VARCHAR(16) NOT NULL CHECK (role IN ('anchor','companion')),
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  read_camera_name VARCHAR(120) NOT NULL CHECK (
    NULLIF(BTRIM(read_camera_name), '') IS NOT NULL
  ),
  read_timestamp TIMESTAMPTZ NOT NULL,
  effective_plate_snapshot VARCHAR(32) NOT NULL CHECK (
    NULLIF(BTRIM(effective_plate_snapshot), '') IS NOT NULL
  ),
  direction_status_snapshot VARCHAR(20),
  direction_label_snapshot VARCHAR(100),
  source_kind_snapshot VARCHAR(40) NOT NULL,
  source_read_id_snapshot INTEGER,
  source_path_snapshot TEXT NOT NULL CHECK (
    NULLIF(BTRIM(source_path_snapshot), '') IS NOT NULL
  ),
  source_updated_at_snapshot TIMESTAMPTZ,
  captured_at_snapshot TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, read_id),
  CHECK (
    direction_status_snapshot IS DISTINCT FROM 'ready'
    OR NULLIF(BTRIM(direction_label_snapshot), '') IS NOT NULL
  ),
  CHECK (source_kind_snapshot IN (
    'overview_primary','entry_overview_primary','overview_fallback',
    'overview_pair_share','entry_overview_history'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_event_reads_one_active_event
  ON public.vehicle_event_reads (read_id)
  WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_vehicle_event_reads_asset
  ON public.vehicle_event_reads (asset_id, event_id);

CREATE TABLE IF NOT EXISTS public.vehicle_event_assets (
  event_id BIGINT NOT NULL REFERENCES public.vehicle_events(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  role VARCHAR(16) NOT NULL CHECK (role IN ('primary','supporting')),
  identity_eligible BOOLEAN NOT NULL DEFAULT TRUE CHECK (
    identity_eligible = TRUE
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, asset_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_event_assets_one_primary
  ON public.vehicle_event_assets (event_id)
  WHERE role = 'primary';
CREATE INDEX IF NOT EXISTS idx_vehicle_event_assets_asset
  ON public.vehicle_event_assets (asset_id, event_id);

CREATE TABLE IF NOT EXISTS public.vehicle_event_shadow_decisions (
  id BIGSERIAL PRIMARY KEY,
  decision_identity CHAR(64) NOT NULL UNIQUE CHECK (
    decision_identity ~ '^[0-9a-f]{64}$'
  ),
  event_id BIGINT REFERENCES public.vehicle_events(id) ON DELETE RESTRICT,
  outcome VARCHAR(16) NOT NULL CHECK (
    outcome IN ('proposed','rejected')
  ),
  reason VARCHAR(80) NOT NULL CHECK (NULLIF(BTRIM(reason), '') IS NOT NULL),
  overview_context VARCHAR(12) NOT NULL CHECK (
    overview_context IN ('street','entry')
  ),
  anchor_read_id INTEGER NOT NULL CHECK (anchor_read_id > 0),
  companion_read_id INTEGER CHECK (
    companion_read_id IS NULL OR companion_read_id > 0
  ),
  anchor_asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  companion_asset_id BIGINT REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  anchor_source_kind VARCHAR(40) NOT NULL,
  anchor_source_read_id INTEGER,
  anchor_source_path TEXT NOT NULL CHECK (
    NULLIF(BTRIM(anchor_source_path), '') IS NOT NULL
  ),
  anchor_source_updated_at TIMESTAMPTZ,
  anchor_captured_at TIMESTAMPTZ,
  anchor_plate_snapshot VARCHAR(32) NOT NULL,
  anchor_direction_status VARCHAR(20),
  anchor_direction_label VARCHAR(100),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  correlation_algorithm VARCHAR(80) NOT NULL,
  decision_metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (
    jsonb_typeof(decision_metadata) = 'object'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (outcome = 'proposed' AND event_id IS NOT NULL
      AND companion_read_id IS NOT NULL AND companion_asset_id IS NOT NULL)
    OR (outcome = 'rejected' AND event_id IS NULL)
  ),
  CHECK (anchor_source_kind IN (
    'overview_primary','entry_overview_primary','overview_fallback',
    'overview_pair_share','entry_overview_history'
  ))
);

CREATE INDEX IF NOT EXISTS idx_vehicle_event_shadow_decisions_anchor
  ON public.vehicle_event_shadow_decisions (
    anchor_read_id, created_at DESC, id DESC
  );
CREATE INDEX IF NOT EXISTS idx_vehicle_event_shadow_decisions_recent
  ON public.vehicle_event_shadow_decisions (created_at DESC, id DESC);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081405_vehicle_event_shadow_correlation','Add default-off provider-neutral shadow correlation for conservative paired canonical Overview observations.')
ON CONFLICT(version) DO NOTHING;
