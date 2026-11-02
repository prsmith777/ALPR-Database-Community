-- migration: 2026081301_integration_ingress_receipts
-- Bounded operational receipts for authenticated integration requests. These
-- rows intentionally contain request shape and outcome metadata only. Plate
-- values, request bodies, images, AI dumps, and Blue Iris paths are excluded.
CREATE TABLE IF NOT EXISTS public.integration_ingress_receipts (
  id BIGSERIAL PRIMARY KEY,
  request_id VARCHAR(128) NOT NULL,
  integration VARCHAR(64) NOT NULL,
  route_name VARCHAR(128) NOT NULL,
  method VARCHAR(12),
  content_type VARCHAR(128),
  body_bytes BIGINT CHECK (body_bytes IS NULL OR body_bytes >= 0),
  body_sha256 CHAR(64) CHECK (
    body_sha256 IS NULL OR body_sha256 ~ '^[0-9a-f]{64}$'
  ),
  payload_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  unknown_payload_key_count INTEGER NOT NULL DEFAULT 0
    CHECK (unknown_payload_key_count >= 0),
  camera_name VARCHAR(100),
  event_timestamp_text VARCHAR(128),
  trigger_field VARCHAR(32),
  trigger_present BOOLEAN NOT NULL DEFAULT FALSE,
  trigger_value_state VARCHAR(16) NOT NULL DEFAULT 'absent'
    CHECK (trigger_value_state IN ('absent','blank','invalid','recorded')),
  trigger_type VARCHAR(128),
  heavy_fields JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(heavy_fields) = 'object'),
  state VARCHAR(16) NOT NULL DEFAULT 'received'
    CHECK (state IN ('received','completed')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  http_status SMALLINT CHECK (
    http_status IS NULL OR http_status BETWEEN 100 AND 599
  ),
  outcome VARCHAR(64),
  error_code VARCHAR(128),
  processed_read_ids BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  ignored_count INTEGER NOT NULL DEFAULT 0 CHECK (ignored_count >= 0),
  overview_work_queued BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (array_position(payload_keys, NULL) IS NULL),
  CHECK (array_position(processed_read_ids, NULL) IS NULL),
  CHECK (
    (state = 'received' AND completed_at IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_integration_ingress_receipts_received
  ON public.integration_ingress_receipts (received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_integration_ingress_receipts_request
  ON public.integration_ingress_receipts (request_id);
CREATE INDEX IF NOT EXISTS idx_integration_ingress_receipts_trigger_diagnostics
  ON public.integration_ingress_receipts (
    integration, camera_name, trigger_value_state, received_at DESC
  );

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081301_integration_ingress_receipts','Add bounded metadata-only integration request receipts and trigger-type diagnostics.')
ON CONFLICT(version) DO NOTHING;
