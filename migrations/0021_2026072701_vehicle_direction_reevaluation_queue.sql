-- migration: 2026072701_vehicle_direction_reevaluation_queue
-- Historical re-evaluation is queued separately from ordinary live direction
-- work. Existing observations remain visible until their replacement is ready,
-- and an administrator can pause only the historical queue without delaying
-- newly ingested reads.
CREATE TABLE IF NOT EXISTS public.vehicle_direction_reevaluation_queue (
    read_id INTEGER PRIMARY KEY REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    camera_key VARCHAR(120) NOT NULL,
    requested_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vehicle_direction_reevaluation_queue_order
    ON public.vehicle_direction_reevaluation_queue (requested_at, read_id);

CREATE TABLE IF NOT EXISTS public.vehicle_direction_reevaluation_control (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
    paused BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.vehicle_direction_reevaluation_control (singleton, paused)
VALUES (TRUE, FALSE)
ON CONFLICT (singleton) DO NOTHING;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072701_vehicle_direction_reevaluation_queue',
    'Preserve current directions during re-evaluation and add durable pause/resume controls.'
)
ON CONFLICT (version) DO NOTHING;
