-- migration: 2026110103_preserve_event_directions
-- Zone events have no image embedding. Their visibility is independent of crops.
CREATE OR REPLACE VIEW public.current_vehicle_direction_observations AS
SELECT observations.* FROM public.vehicle_direction_observations observations
WHERE observations.classifier_version IN (
  'blue-iris-zone-crossing-v1', 'blue-iris-zone-crossing-v2-primary', 'axis-lpv-direction-v1'
) OR (observations.classifier_version = 'canonical-crop-orientation-knn-v2'
  AND EXISTS (SELECT 1 FROM public.vehicle_direction_sources source
    WHERE source.read_id = observations.read_id
      AND source.embedding_id = observations.source_embedding_id));
INSERT INTO public.schema_migrations(version, description) VALUES
 ('2026110103_preserve_event_directions', 'Preserve Blue Iris and Axis events and expose current primary direction observations.')
ON CONFLICT(version) DO NOTHING;
