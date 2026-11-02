-- migration: 2026110102_axis_ready_state
ALTER TABLE public.vehicle_direction_observations DROP CONSTRAINT IF EXISTS vehicle_direction_ready_state;
ALTER TABLE public.vehicle_direction_observations ADD CONSTRAINT vehicle_direction_ready_state CHECK (
 (status='ready' AND direction_label IS NOT NULL AND
   ((classifier_version='axis-lpv-direction-v1' AND orientation IN ('front','rear','unknown')) OR
    (orientation IN ('front','rear') AND orientation_confidence IS NOT NULL))) OR
 (status<>'ready' AND orientation='unknown' AND direction_label IS NULL)
) NOT VALID;
INSERT INTO public.schema_migrations(version,description) VALUES ('2026110102_axis_ready_state','Preserve Axis observation state validation in the migration ledger.') ON CONFLICT(version) DO NOTHING;
