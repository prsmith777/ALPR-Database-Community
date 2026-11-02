-- migration: 2026081004_entry_lpr_route_fallback
-- Gate LPR fallback is a read-to-read association. It never consumes a Blue
-- Iris alert and never creates a synthetic Street read. New installations start
-- in shadow mode so route matches can be reviewed before copied images are
-- allowed to fill a failed Street Overview result.
ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_source_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_source_kind_check CHECK (
    vehicle_image_source_kind IS NULL OR
    vehicle_image_source_kind IN (
      'legacy_plate_camera','overview_primary','entry_overview_primary','overview_fallback',
      'overview_pair_share','entry_lpr_fallback','entry_overview_route_fallback',
      'entry_overview_history'
    )
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS public.vehicle_entry_fallback_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode VARCHAR(12) NOT NULL DEFAULT 'shadow'
    CHECK (mode IN ('off','shadow','active')),
  observation_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.vehicle_entry_fallback_settings (singleton, mode)
VALUES (TRUE, 'shadow')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_entry_route_profiles (
  id BIGSERIAL PRIMARY KEY,
  route_name VARCHAR(120) NOT NULL,
  target_camera_name VARCHAR(120) NOT NULL,
  target_camera_key VARCHAR(120) GENERATED ALWAYS AS (LOWER(BTRIM(target_camera_name))) STORED,
  target_direction_label VARCHAR(100) NOT NULL,
  target_direction_key VARCHAR(100) GENERATED ALWAYS AS (LOWER(BTRIM(target_direction_label))) STORED,
  source_direction_label VARCHAR(100) NOT NULL,
  source_camera_names TEXT[] NOT NULL,
  expected_delta_ms INTEGER NOT NULL CHECK (expected_delta_ms BETWEEN -30000 AND 30000),
  tolerance_ms INTEGER NOT NULL DEFAULT 3000 CHECK (tolerance_ms BETWEEN 250 AND 15000),
  event_window_ms INTEGER NOT NULL DEFAULT 3000 CHECK (event_window_ms BETWEEN 250 AND 5000),
  minimum_source_count SMALLINT NOT NULL DEFAULT 2 CHECK (minimum_source_count BETWEEN 2 AND 4),
  priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT vehicle_entry_route_profiles_name_check CHECK (BTRIM(route_name) <> ''),
  CONSTRAINT vehicle_entry_route_profiles_target_camera_check CHECK (BTRIM(target_camera_name) <> ''),
  CONSTRAINT vehicle_entry_route_profiles_target_direction_check CHECK (BTRIM(target_direction_label) <> ''),
  CONSTRAINT vehicle_entry_route_profiles_source_direction_check CHECK (BTRIM(source_direction_label) <> ''),
  CONSTRAINT vehicle_entry_route_profiles_source_cameras_check CHECK (
    cardinality(source_camera_names) >= minimum_source_count
  ),
  UNIQUE (target_camera_key, target_direction_key)
);

CREATE TABLE IF NOT EXISTS public.vehicle_entry_fallback_decisions (
  id BIGSERIAL PRIMARY KEY,
  decision_identity CHAR(64) NOT NULL UNIQUE,
  source_event_key CHAR(64),
  route_profile_id BIGINT NOT NULL,
  route_profile_revision BIGINT NOT NULL CHECK (route_profile_revision > 0),
  target_read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE CASCADE,
  source_read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
  corroborating_read_ids INTEGER[] NOT NULL DEFAULT '{}',
  status VARCHAR(16) NOT NULL CHECK (
    status IN ('proposed','processing','applied','rejected','failed')
  ),
  decision_reason VARCHAR(100) NOT NULL,
  route_name_snapshot VARCHAR(120) NOT NULL,
  target_plate_snapshot VARCHAR(32),
  target_camera_name_snapshot VARCHAR(120),
  target_direction_label_snapshot VARCHAR(100),
  source_direction_label_snapshot VARCHAR(100),
  source_camera_names_snapshot TEXT[] NOT NULL DEFAULT '{}',
  source_image_path_snapshot TEXT,
  source_timestamp_snapshot TIMESTAMPTZ,
  source_detection_confidence REAL CHECK (
    source_detection_confidence IS NULL OR source_detection_confidence BETWEEN 0 AND 1
  ),
  source_detection_box JSONB,
  source_image_width INTEGER CHECK (source_image_width IS NULL OR source_image_width > 0),
  source_image_height INTEGER CHECK (source_image_height IS NULL OR source_image_height > 0),
  plate_evidence_class VARCHAR(80),
  expected_delta_ms INTEGER,
  actual_delta_ms INTEGER,
  timing_error_ms INTEGER,
  decision_score REAL,
  decision_margin REAL,
  decision_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  claim_token UUID,
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  target_image_path TEXT,
  error_code VARCHAR(80),
  error_details JSONB,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (target_read_id, route_profile_id, route_profile_revision),
  CONSTRAINT vehicle_entry_fallback_decisions_metadata_check CHECK (
    jsonb_typeof(decision_metadata) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_entry_fallback_decisions_claim
  ON public.vehicle_entry_fallback_decisions (status, created_at, id)
  WHERE status IN ('proposed','processing');

CREATE INDEX IF NOT EXISTS idx_vehicle_entry_fallback_decisions_target
  ON public.vehicle_entry_fallback_decisions (target_read_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_entry_fallback_unique_live_event
  ON public.vehicle_entry_fallback_decisions (source_event_key)
  WHERE source_event_key IS NOT NULL AND status IN ('proposed','processing','applied');

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081004_entry_lpr_route_fallback','Add shadow-first, dual-camera Gate LPR read-to-read fallback for explicitly configured driveway routes.')
ON CONFLICT(version) DO NOTHING;
