-- migration: 2026110105_explicit_lpr_recording_binding
-- An ALPR camera alias and its recording camera display name may differ. The
-- explicitly selected Blue Iris short ID identifies the recording source.
ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT vehicle_overview_distinct_camera_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_distinct_camera_check CHECK (
    (source_mode = 'overview' AND LOWER(BTRIM(source_camera_name)) <> LOWER(BTRIM(plate_camera_name)))
    OR (source_mode = 'lpr_camera' AND source_role = 'primary'
      AND expected_delta_ms = 0 AND NULLIF(BTRIM(source_camera_short_name), '') IS NOT NULL)
  ) NOT VALID;
INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026110105_explicit_lpr_recording_binding', 'Bind ALPR camera aliases to an explicitly selected Blue Iris recording short ID.')
ON CONFLICT(version) DO NOTHING;
