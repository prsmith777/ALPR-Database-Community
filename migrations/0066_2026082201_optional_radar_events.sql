-- migration: 2026082201_optional_radar_events
-- Direct local speed-radar ingestion. The source reuses an existing MQTT broker
-- credential record, stores only bounded JSON vehicle detections, and links one
-- event to at most one ALPR read through timestamp and configured direction.
CREATE TABLE IF NOT EXISTS public.radar_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  broker_id INTEGER NOT NULL REFERENCES public.mqttbrokers(id) ON DELETE RESTRICT,
  topic_filter VARCHAR(512) NOT NULL CHECK (BTRIM(topic_filter) <> ''),
  source_key VARCHAR(255) NOT NULL CHECK (BTRIM(source_key) <> ''),
  qos SMALLINT NOT NULL DEFAULT 1 CHECK (qos BETWEEN 0 AND 2),
  correlation_window_ms INTEGER NOT NULL DEFAULT 8000 CHECK (correlation_window_ms BETWEEN 250 AND 60000),
  inbound_alpr_direction VARCHAR(80) NOT NULL DEFAULT 'Entering' CHECK (BTRIM(inbound_alpr_direction) <> ''),
  outbound_alpr_direction VARCHAR(80) NOT NULL DEFAULT 'Exiting' CHECK (BTRIM(outbound_alpr_direction) <> ''),
  last_connected_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.radar_events (
  id BIGSERIAL PRIMARY KEY,
  source_key VARCHAR(255) NOT NULL CHECK (BTRIM(source_key) <> ''),
  topic VARCHAR(512) NOT NULL CHECK (BTRIM(topic) <> ''),
  event_timestamp TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  speed_mph NUMERIC(5,1) NOT NULL CHECK (speed_mph > 0 AND speed_mph <= 200),
  signed_speed NUMERIC,
  source_unit VARCHAR(16) NOT NULL CHECK (source_unit IN ('mph','kmh','mps')),
  direction VARCHAR(16) NOT NULL CHECK (direction IN ('inbound','outbound')),
  source VARCHAR(255),
  label VARCHAR(255),
  message_hash CHAR(64) NOT NULL UNIQUE CHECK (message_hash ~ '^[0-9a-f]{64}$'),
  raw_payload JSONB NOT NULL CHECK (jsonb_typeof(raw_payload) = 'object'),
  matched_read_id INTEGER UNIQUE REFERENCES public.plate_reads(id) ON DELETE SET NULL,
  match_delta_ms INTEGER,
  matched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT radar_events_match_state CHECK (
    (matched_read_id IS NULL AND match_delta_ms IS NULL AND matched_at IS NULL)
    OR (matched_read_id IS NOT NULL AND match_delta_ms IS NOT NULL AND matched_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_radar_events_unmatched
  ON public.radar_events (event_timestamp, id) WHERE matched_read_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_radar_events_speed
  ON public.radar_events (speed_mph, event_timestamp DESC);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026082201_optional_radar_events','Add default-disabled generic radar event storage for schema compatibility.')
ON CONFLICT(version) DO NOTHING;
