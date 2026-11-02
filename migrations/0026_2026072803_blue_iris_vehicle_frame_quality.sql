-- migration: 2026072803_blue_iris_vehicle_frame_quality
-- Explain why the quality-aware multiframe selector chose a particular
-- vehicle view without retaining the other sampled images or Blue Iris video.
ALTER TABLE IF EXISTS public.plate_reads
    ADD COLUMN IF NOT EXISTS vehicle_image_selection_metadata JSONB;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072803_blue_iris_vehicle_frame_quality',
    'Record bounded quality, tracking, and timing diagnostics for the selected Blue Iris vehicle frame.'
)
ON CONFLICT (version) DO NOTHING;
