-- migration: 2026072801_blue_iris_vehicle_frames
-- Keep at most one derived Blue Iris vehicle-overview frame per plate read.
-- The source BVR remains in Blue Iris; only the best bounded sample is retained.
ALTER TABLE IF EXISTS public.plate_reads
    ADD COLUMN IF NOT EXISTS vehicle_image_status VARCHAR(20),
    ADD COLUMN IF NOT EXISTS vehicle_image_path TEXT,
    ADD COLUMN IF NOT EXISTS vehicle_image_timestamp TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS vehicle_image_score REAL,
    ADD COLUMN IF NOT EXISTS vehicle_image_detection_confidence REAL,
    ADD COLUMN IF NOT EXISTS vehicle_image_detection_box JSONB,
    ADD COLUMN IF NOT EXISTS vehicle_image_width INTEGER,
    ADD COLUMN IF NOT EXISTS vehicle_image_height INTEGER,
    ADD COLUMN IF NOT EXISTS vehicle_image_sampled_count SMALLINT,
    ADD COLUMN IF NOT EXISTS vehicle_image_error_code VARCHAR(80),
    ADD COLUMN IF NOT EXISTS vehicle_image_retryable BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS vehicle_image_updated_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS public.plate_reads
    DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_status_check;
ALTER TABLE IF EXISTS public.plate_reads
    ADD CONSTRAINT plate_reads_vehicle_image_status_check
    CHECK (vehicle_image_status IS NULL OR vehicle_image_status IN ('pending', 'processing', 'ready', 'unavailable', 'failed'));

CREATE INDEX IF NOT EXISTS idx_plate_reads_vehicle_image_work
    ON public.plate_reads (vehicle_image_status, vehicle_image_retryable, vehicle_image_updated_at, id)
    WHERE vehicle_image_status IS NOT NULL AND vehicle_image_status <> 'ready';

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072801_blue_iris_vehicle_frames',
    'Retain one best derived Blue Iris vehicle-overview frame per ALPR read with terminal retention-aware states.'
)
ON CONFLICT (version) DO NOTHING;
