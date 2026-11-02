-- migration: 2026081005_entry_overview_primary
-- Gate LPR reads may use the same read-owned continuous-recording pipeline as
-- Street LPR reads while retaining distinct provenance. Existing primary
-- profiles remain Street profiles until an administrator explicitly changes
-- their context. Street companion sharing continues to accept only the legacy
-- overview_primary result kind, so Gate Overview results cannot cross into it.
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD COLUMN IF NOT EXISTS overview_context VARCHAR(16) NOT NULL DEFAULT 'street',
  ADD COLUMN IF NOT EXISTS source_camera_short_name VARCHAR(80);

ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT IF EXISTS vehicle_overview_pair_profiles_context_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_pair_profiles_context_check CHECK (
    overview_context IN ('street','entry')
  ) NOT VALID;

ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT IF EXISTS vehicle_overview_pair_profiles_entry_camera_binding_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_pair_profiles_entry_camera_binding_check CHECK (
    overview_context <> 'entry'
    OR source_role <> 'primary'
    OR NULLIF(BTRIM(source_camera_short_name), '') IS NOT NULL
  ) NOT VALID;

DO $$
DECLARE
  duplicate_identity RECORD;
BEGIN
  SELECT LOWER(BTRIM(plate_camera_name)) AS plate_camera_key,
         LOWER(BTRIM(direction_label)) AS direction_key,
         COUNT(*) AS profile_count
  INTO duplicate_identity
  FROM public.vehicle_overview_pair_profiles
  WHERE enabled = TRUE AND source_role = 'primary'
  GROUP BY LOWER(BTRIM(plate_camera_name)), LOWER(BTRIM(direction_label))
  HAVING COUNT(*) > 1
  ORDER BY COUNT(*) DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Duplicate enabled primary overview profiles for camera % and direction % (% rows). Disable the duplicate before retrying this migration.',
      duplicate_identity.plate_camera_key,
      duplicate_identity.direction_key,
      duplicate_identity.profile_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_overview_primary_profile_identity
  ON public.vehicle_overview_pair_profiles (
    LOWER(BTRIM(plate_camera_name)), LOWER(BTRIM(direction_label))
  )
  WHERE enabled = TRUE AND source_role = 'primary';

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
 ('2026081005_entry_overview_primary','Add explicit Gate Overview primary profile context and distinct read-owned Vehicle View provenance.')
ON CONFLICT(version) DO NOTHING;
