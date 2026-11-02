-- migration: 2026072802_blue_iris_vehicle_frame_queue
-- New accepted reads are processed automatically while historical work is
-- explicitly queued and can be paused independently. A short processing lease
-- lets work recover safely after an application restart.
ALTER TABLE IF EXISTS public.plate_reads
    ADD COLUMN IF NOT EXISTS vehicle_image_queue_kind VARCHAR(20),
    ADD COLUMN IF NOT EXISTS vehicle_image_attempt_count SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS public.plate_reads
    DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_status_check;
ALTER TABLE IF EXISTS public.plate_reads
    ADD CONSTRAINT plate_reads_vehicle_image_status_check
    CHECK (vehicle_image_status IS NULL OR vehicle_image_status IN ('pending', 'processing', 'ready', 'unavailable', 'failed'));

ALTER TABLE IF EXISTS public.plate_reads
    DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_queue_kind_check;
ALTER TABLE IF EXISTS public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_queue_kind_check
  CHECK (vehicle_image_queue_kind IS NULL OR vehicle_image_queue_kind IN ('live', 'historical', 'manual', 'overview', 'overview_backfill', 'overview_repair'));

CREATE TABLE IF NOT EXISTS public.vehicle_frame_processing_control (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    historical_paused BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.vehicle_frame_processing_control (singleton, historical_paused)
VALUES (TRUE, TRUE)
ON CONFLICT (singleton) DO NOTHING;

DROP INDEX IF EXISTS public.idx_plate_reads_vehicle_image_work;
CREATE INDEX IF NOT EXISTS idx_plate_reads_vehicle_image_work
    ON public.plate_reads (
        vehicle_image_status, vehicle_image_queue_kind,
        vehicle_image_retryable, vehicle_image_updated_at, id
    )
    WHERE vehicle_image_path IS NULL;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072802_blue_iris_vehicle_frame_queue',
    'Automatically process live Blue Iris vehicle frames with durable retries and controlled historical backfill.'
)
ON CONFLICT (version) DO NOTHING;
