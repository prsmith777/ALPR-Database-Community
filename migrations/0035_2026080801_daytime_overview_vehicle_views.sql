-- migration: 2026080801_daytime_overview_vehicle_views
-- Phase 2 overview Vehicle Views. Motion alerts from an overview-capable Blue
-- Iris camera are screened and sampled independently from plate ingestion.
-- Direction-aware, camera-pair timing profiles associate one retained daytime
-- frame only after both LPR reads have had time to arrive. Nighttime candidates
-- and nighttime plate reads are terminal and never enter the processing queue.
CREATE TABLE IF NOT EXISTS public.vehicle_overview_pair_profiles (
  id BIGSERIAL PRIMARY KEY,
  source_camera_name VARCHAR(120) NOT NULL CHECK (BTRIM(source_camera_name) <> ''),
  plate_camera_name VARCHAR(120) NOT NULL CHECK (BTRIM(plate_camera_name) <> ''),
  direction_label VARCHAR(80) NOT NULL CHECK (BTRIM(direction_label) <> ''),
  source_role VARCHAR(16) NOT NULL DEFAULT 'primary'
    CHECK (source_role IN ('primary','fallback')),
  expected_delta_ms INTEGER NOT NULL DEFAULT 0
    CHECK (expected_delta_ms BETWEEN -30000 AND 30000),
  tolerance_ms INTEGER NOT NULL DEFAULT 1500
    CHECK (tolerance_ms BETWEEN 250 AND 10000),
  priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_camera_name, plate_camera_name, direction_label)
);

CREATE TABLE IF NOT EXISTS public.vehicle_overview_candidates (
  id BIGSERIAL PRIMARY KEY,
  event_identity CHAR(64) NOT NULL UNIQUE CHECK (event_identity ~ '^[0-9a-f]{64}$'),
  source_camera_name VARCHAR(120) NOT NULL CHECK (BTRIM(source_camera_name) <> ''),
  event_timestamp TIMESTAMPTZ NOT NULL,
  bi_alert_clip TEXT,
  bi_alert_path TEXT,
  bi_alert_offset_ms BIGINT,
  bi_trigger_type VARCHAR(80),
  daylight_status VARCHAR(16) NOT NULL
    CHECK (daylight_status IN ('daytime','nighttime')),
  monochrome_ratio REAL CHECK (monochrome_ratio IS NULL OR monochrome_ratio BETWEEN 0 AND 1),
  status VARCHAR(20) NOT NULL
    CHECK (status IN ('pending','processing','ready','matching','associated','ambiguous','unavailable','failed')),
  frame_path TEXT,
  frame_timestamp TIMESTAMPTZ,
  frame_score REAL,
  detection_confidence REAL,
  detection_box JSONB,
  image_width INTEGER,
  image_height INTEGER,
  sampled_count SMALLINT,
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  match_attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (match_attempt_count BETWEEN 0 AND 20),
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  error_code VARCHAR(80),
  selection_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vehicle_overview_candidates_work
  ON public.vehicle_overview_candidates (status, updated_at, event_timestamp, id)
  WHERE status IN ('pending','processing','ready','matching','failed');

CREATE INDEX IF NOT EXISTS idx_vehicle_overview_pair_profiles_lookup
  ON public.vehicle_overview_pair_profiles (
    LOWER(BTRIM(source_camera_name)), LOWER(BTRIM(plate_camera_name)),
    LOWER(BTRIM(direction_label))
  ) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS public.vehicle_overview_associations (
  id BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES public.vehicle_overview_candidates(id) ON DELETE RESTRICT,
  read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE RESTRICT,
  pair_profile_id BIGINT NOT NULL REFERENCES public.vehicle_overview_pair_profiles(id) ON DELETE RESTRICT,
  algorithm VARCHAR(80) NOT NULL,
  association_score REAL NOT NULL,
  actual_delta_ms INTEGER NOT NULL,
  timing_error_ms INTEGER NOT NULL CHECK (timing_error_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (candidate_id, read_id),
  UNIQUE (read_id)
);

ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS vehicle_image_source_kind VARCHAR(24),
  ADD COLUMN IF NOT EXISTS vehicle_overview_candidate_id BIGINT;

DO $$
DECLARE
  current_length INTEGER;
BEGIN
  SELECT columns.character_maximum_length
  INTO current_length
  FROM information_schema.columns
  WHERE columns.table_schema = 'public'
    AND columns.table_name = 'plate_reads'
    AND columns.column_name = 'vehicle_image_source_kind';

  IF current_length IS DISTINCT FROM 40 THEN
    EXECUTE 'ALTER TABLE public.plate_reads ALTER COLUMN vehicle_image_source_kind TYPE VARCHAR(40)';
  END IF;
END $$;

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
  ADD CONSTRAINT plate_reads_vehicle_image_queue_kind_check
  CHECK (vehicle_image_queue_kind IS NULL OR vehicle_image_queue_kind IN ('live', 'historical', 'manual', 'overview', 'overview_backfill', 'overview_repair'));

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plate_reads_vehicle_overview_candidate_fkey'
      AND conrelid = 'public.plate_reads'::regclass
  ) THEN
    ALTER TABLE public.plate_reads
      ADD CONSTRAINT plate_reads_vehicle_overview_candidate_fkey
      FOREIGN KEY (vehicle_overview_candidate_id)
      REFERENCES public.vehicle_overview_candidates(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_plate_reads_overview_waiting
  ON public.plate_reads (vehicle_image_queue_kind, timestamp DESC, id DESC)
  WHERE vehicle_image_queue_kind = 'overview' AND vehicle_image_path IS NULL;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080801_daytime_overview_vehicle_views','Ingest daytime Blue Iris overview candidates and conservatively associate primary or driveway-fallback Vehicle Views by camera timing and direction.')
ON CONFLICT(version) DO NOTHING;
