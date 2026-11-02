-- migration: 2026100501_portable_vehicle_image_sources
-- Explicitly reviewed full-vehicle recording sources. Existing mappings retain
-- overview behavior; a same-camera source requires an explicit opt-in.
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD COLUMN IF NOT EXISTS source_mode VARCHAR(16) NOT NULL DEFAULT 'overview';
ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT IF EXISTS vehicle_overview_distinct_camera_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_distinct_camera_check CHECK (
    (source_mode = 'overview' AND LOWER(BTRIM(source_camera_name)) <> LOWER(BTRIM(plate_camera_name)))
    OR (source_mode = 'lpr_camera' AND source_role = 'primary'
      AND LOWER(BTRIM(source_camera_name)) = LOWER(BTRIM(plate_camera_name))
      AND expected_delta_ms = 0 AND NULLIF(BTRIM(source_camera_short_name), '') IS NOT NULL)
  ) NOT VALID;
INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026100501_portable_vehicle_image_sources','Record explicit whole-vehicle LPR recording sources alongside existing overview mappings.')
ON CONFLICT(version) DO NOTHING;
