-- migration: 2026110101_axis_camera_inputs
-- Configurable incoming camera sources. Existing Blue Iris inputs remain implicit.
CREATE TABLE IF NOT EXISTS public.camera_inputs (
 id UUID PRIMARY KEY,
 camera_name VARCHAR(30) NOT NULL,
 source VARCHAR(16) NOT NULL CHECK(source IN ('blue_iris','axis')),
 transport VARCHAR(8) NOT NULL CHECK(transport IN ('http','mqtt','both')),
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 device_id VARCHAR(64),
 broker_id INTEGER REFERENCES public.mqttbrokers(id) ON DELETE RESTRICT,
 topic_filter VARCHAR(512),
 qos INTEGER NOT NULL DEFAULT 1 CHECK(qos IN (0,1)),
 processing_mode VARCHAR(16) NOT NULL DEFAULT 'immediate' CHECK(processing_mode IN ('immediate','final')),
 store_images BOOLEAN NOT NULL DEFAULT TRUE,
 roi_filter VARCHAR(30),
 direction_in VARCHAR(80) NOT NULL DEFAULT 'In', direction_out VARCHAR(80) NOT NULL DEFAULT 'Out',
 credential_hash CHAR(64),
 connection_status VARCHAR(32) NOT NULL DEFAULT 'waiting',
 last_received_at TIMESTAMPTZ, last_imported_at TIMESTAMPTZ, last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(source <> 'axis' OR device_id IS NOT NULL),
 CHECK(transport NOT IN ('mqtt','both') OR (broker_id IS NOT NULL AND topic_filter IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_camera_inputs_name ON public.camera_inputs(LOWER(BTRIM(camera_name)));
CREATE UNIQUE INDEX IF NOT EXISTS uq_camera_inputs_device ON public.camera_inputs(device_id) WHERE source='axis';
CREATE TABLE IF NOT EXISTS public.camera_input_events (
 id BIGSERIAL PRIMARY KEY,
 input_id UUID NOT NULL REFERENCES public.camera_inputs(id) ON DELETE RESTRICT,
 fingerprint CHAR(64) NOT NULL,
 payload JSONB NOT NULL,
 transport VARCHAR(8) NOT NULL CHECK(transport IN ('http','mqtt')),
 status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processed','ignored')),
 read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 processed_at TIMESTAMPTZ,
 leased_until TIMESTAMPTZ, lease_token UUID,
 revision INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(input_id,fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_camera_input_pending ON public.camera_input_events(next_attempt_at,id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_camera_input_event_retention ON public.camera_input_events(processed_at,id) WHERE status<>'pending';
CREATE TABLE IF NOT EXISTS public.camera_input_passages (
 id UUID PRIMARY KEY,
 input_id UUID NOT NULL REFERENCES public.camera_inputs(id) ON DELETE RESTRICT,
 car_id VARCHAR(64) NOT NULL,
 source_camera VARCHAR(64) NOT NULL,
 first_capture TIMESTAMPTZ NOT NULL, last_capture TIMESTAMPTZ NOT NULL,
 last_event_id BIGINT REFERENCES public.camera_input_events(id) ON DELETE SET NULL,
 last_state VARCHAR(12) NOT NULL,
 last_seen TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
 finalized BOOLEAN NOT NULL DEFAULT FALSE,
 direction_label VARCHAR(80), scene_image_path VARCHAR(255), scene_thumbnail_path VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS idx_camera_input_passage_lookup ON public.camera_input_passages(input_id,car_id,last_capture DESC);
ALTER TABLE public.camera_input_events ADD COLUMN IF NOT EXISTS passage_id UUID
 REFERENCES public.camera_input_passages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_camera_input_event_passage ON public.camera_input_events(passage_id);
INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026110101_axis_camera_inputs','Configurable Blue Iris and Axis HTTP/MQTT inputs with durable Axis receipts and passage correlation.')
ON CONFLICT(version) DO NOTHING;
