-- migration: 2026081201_entry_overview_route_payload
-- Route fallback v2 keeps the two Gate LPR reads as immutable identity and
-- timing evidence, but may copy only an already validated Gate Overview
-- (Overview01) result owned by one of those exact reads. The independent payload
-- gate starts in shadow even when the older route matcher was already active.
ALTER TABLE public.vehicle_entry_fallback_settings
  ADD COLUMN IF NOT EXISTS overview_payload_mode VARCHAR(12) NOT NULL DEFAULT 'shadow';

ALTER TABLE public.vehicle_entry_fallback_settings
  DROP CONSTRAINT IF EXISTS vehicle_entry_fallback_settings_overview_payload_mode_check;
ALTER TABLE public.vehicle_entry_fallback_settings
  ADD CONSTRAINT vehicle_entry_fallback_settings_overview_payload_mode_check CHECK (
    overview_payload_mode IN ('off','shadow','active')
  ) NOT VALID;

ALTER TABLE public.vehicle_entry_fallback_decisions
  ADD COLUMN IF NOT EXISTS algorithm_revision VARCHAR(80) NOT NULL DEFAULT 'entry-lpr-route-fallback-v1',
  ADD COLUMN IF NOT EXISTS payload_read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payload_image_path_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS payload_source_kind_snapshot VARCHAR(40),
  ADD COLUMN IF NOT EXISTS payload_timestamp_snapshot TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payload_detection_confidence REAL,
  ADD COLUMN IF NOT EXISTS payload_detection_box JSONB,
  ADD COLUMN IF NOT EXISTS payload_image_width INTEGER,
  ADD COLUMN IF NOT EXISTS payload_image_height INTEGER,
  ADD COLUMN IF NOT EXISTS payload_score REAL,
  ADD COLUMN IF NOT EXISTS payload_sampled_count SMALLINT,
  ADD COLUMN IF NOT EXISTS payload_selection_metadata JSONB;

DO $entry_fallback_old_unique$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.vehicle_entry_fallback_decisions'::regclass
      AND con.contype = 'u'
      AND (
        SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM unnest(con.conkey) WITH ORDINALITY key_column(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = con.conrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['target_read_id','route_profile_id','route_profile_revision']::name[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.vehicle_entry_fallback_decisions DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END
$entry_fallback_old_unique$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_entry_fallback_algorithm_route_target
  ON public.vehicle_entry_fallback_decisions (
    target_read_id, route_profile_id, route_profile_revision, algorithm_revision
  );

ALTER TABLE public.vehicle_entry_fallback_decisions
  DROP CONSTRAINT IF EXISTS vehicle_entry_fallback_payload_confidence_check;
ALTER TABLE public.vehicle_entry_fallback_decisions
  ADD CONSTRAINT vehicle_entry_fallback_payload_confidence_check CHECK (
    payload_detection_confidence IS NULL OR payload_detection_confidence BETWEEN 0 AND 1
  ) NOT VALID;
ALTER TABLE public.vehicle_entry_fallback_decisions
  DROP CONSTRAINT IF EXISTS vehicle_entry_fallback_payload_dimensions_check;
ALTER TABLE public.vehicle_entry_fallback_decisions
  ADD CONSTRAINT vehicle_entry_fallback_payload_dimensions_check CHECK (
    (payload_image_width IS NULL OR payload_image_width > 0)
    AND (payload_image_height IS NULL OR payload_image_height > 0)
    AND (payload_sampled_count IS NULL OR payload_sampled_count > 0)
  ) NOT VALID;
ALTER TABLE public.vehicle_entry_fallback_decisions
  DROP CONSTRAINT IF EXISTS vehicle_entry_fallback_payload_metadata_check;
ALTER TABLE public.vehicle_entry_fallback_decisions
  ADD CONSTRAINT vehicle_entry_fallback_payload_metadata_check CHECK (
    payload_selection_metadata IS NULL OR jsonb_typeof(payload_selection_metadata) = 'object'
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

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081201_entry_overview_route_payload','Add shadow-gated Overview01 payload snapshots to dual-Entry-read route fallback without enabling or queuing work.')
ON CONFLICT(version) DO NOTHING;
