-- migration: 2026081303_read_pipeline_timeline
-- Sanitized, append-only application evidence for each accepted read. Events
-- follow the parent read lifecycle so existing read cleanup remains unchanged.
-- The details object is deliberately small and never stores plate text,
-- request bodies, images, paths, alternate trigger values, or credentials.
CREATE TABLE IF NOT EXISTS public.plate_read_pipeline_events (
  id BIGSERIAL PRIMARY KEY,
  read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE CASCADE,
  request_id VARCHAR(128),
  ingress_receipt_id BIGINT REFERENCES public.integration_ingress_receipts(id)
    ON DELETE SET NULL,
  stage VARCHAR(32) NOT NULL CHECK (
    stage IN ('ingress','direction','notifications','vehicle-view')
  ),
  event_type VARCHAR(96) NOT NULL CHECK (
    event_type ~ '^[a-z0-9][a-z0-9_.-]*$'
  ),
  status VARCHAR(32) NOT NULL CHECK (
    status IN ('accepted','succeeded','queued','skipped','partial','failed','completed')
  ),
  component VARCHAR(64) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (
    jsonb_typeof(details) = 'object' AND pg_column_size(details) <= 8192
  ),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_plate_read_pipeline_events_read
  ON public.plate_read_pipeline_events (read_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_plate_read_pipeline_events_request
  ON public.plate_read_pipeline_events (request_id)
  WHERE request_id IS NOT NULL;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081303_read_pipeline_timeline','Add sanitized append-only per-read pipeline events without changing read cleanup behavior.')
ON CONFLICT(version) DO NOTHING;
