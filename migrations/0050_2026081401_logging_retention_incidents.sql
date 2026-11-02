-- migration: 2026081401_logging_retention_incidents
-- Immutable incident snapshots preserve a bounded, sanitized evidence package
-- before retention can remove source rows. A scope protects matching live rows
-- until protected_until, while the snapshot and its digest remain append-only.
CREATE TABLE IF NOT EXISTS public.logging_incidents (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  description VARCHAR(1000),
  scope_type VARCHAR(16) NOT NULL CHECK (
    scope_type IN ('request','read','window')
  ),
  request_id VARCHAR(128),
  read_id INTEGER,
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  protected_until TIMESTAMPTZ NOT NULL,
  snapshot_schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (
    snapshot_schema_version = 1
  ),
  snapshot JSONB NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 16777216
  ),
  snapshot_sha256 CHAR(64) NOT NULL CHECK (
    snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  evidence_counts JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (
    jsonb_typeof(evidence_counts) = 'object'
  ),
  created_by_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (protected_until > created_at),
  CHECK (
    (scope_type = 'request' AND NULLIF(BTRIM(request_id), '') IS NOT NULL
      AND read_id IS NULL AND window_start IS NULL AND window_end IS NULL)
    OR
    (scope_type = 'read' AND read_id IS NOT NULL
      AND request_id IS NULL AND window_start IS NULL AND window_end IS NULL)
    OR
    (scope_type = 'window' AND request_id IS NULL AND read_id IS NULL
      AND window_start IS NOT NULL AND window_end IS NOT NULL
      AND window_start < window_end)
  )
);

CREATE INDEX IF NOT EXISTS idx_logging_incidents_protection
  ON public.logging_incidents (protected_until DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_logging_incidents_request
  ON public.logging_incidents (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_logging_incidents_read
  ON public.logging_incidents (read_id) WHERE read_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_logging_incident_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'logging_incidents is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS logging_incidents_append_only ON public.logging_incidents;
CREATE TRIGGER logging_incidents_append_only
BEFORE UPDATE OR DELETE ON public.logging_incidents
FOR EACH ROW EXECUTE FUNCTION public.prevent_logging_incident_mutation();

-- Old audit rows move into an immutable, time-partitioned archive before the
-- hot table can release them. The default partition is bounded by the manual
-- preview batch; future releases may add narrower monthly partitions without
-- changing the archive contract.
CREATE TABLE IF NOT EXISTS public.audit_event_archive (
  source_event_id BIGINT NOT NULL,
  actor_user_id BIGINT,
  actor_api_credential_id BIGINT,
  source VARCHAR(20) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100),
  resource_id VARCHAR(255),
  outcome VARCHAR(20) NOT NULL,
  reason TEXT,
  request_id VARCHAR(100),
  metadata JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_preview_id BIGINT,
  PRIMARY KEY (source_event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS public.audit_event_archive_default
  PARTITION OF public.audit_event_archive DEFAULT;

CREATE INDEX IF NOT EXISTS idx_audit_event_archive_occurred
  ON public.audit_event_archive (occurred_at DESC, source_event_id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_archive_request
  ON public.audit_event_archive (request_id, occurred_at DESC)
  WHERE request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_audit_archive_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_event_archive is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_event_archive_append_only
  ON public.audit_event_archive;
CREATE TRIGGER audit_event_archive_append_only
BEFORE UPDATE OR DELETE ON public.audit_event_archive
FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_archive_mutation();

-- The hot audit table remains update-proof. A delete is permitted only after
-- an exact immutable archive copy exists, preserving the append-only evidence
-- contract while allowing the operational table to stay bounded.
CREATE OR REPLACE FUNCTION public.prevent_audit_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1
    FROM public.audit_event_archive archived
    WHERE archived.source_event_id = OLD.id
      AND archived.occurred_at = OLD.occurred_at
      AND archived.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
      AND archived.actor_api_credential_id IS NOT DISTINCT FROM OLD.actor_api_credential_id
      AND archived.source = OLD.source
      AND archived.event_type = OLD.event_type
      AND archived.resource_type IS NOT DISTINCT FROM OLD.resource_type
      AND archived.resource_id IS NOT DISTINCT FROM OLD.resource_id
      AND archived.outcome = OLD.outcome
      AND archived.reason IS NOT DISTINCT FROM OLD.reason
      AND archived.request_id IS NOT DISTINCT FROM OLD.request_id
      AND archived.metadata = OLD.metadata
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.logging_retention_previews (
  id BIGSERIAL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'previewed' CHECK (
    status IN ('previewed','executed','invalidated')
  ),
  policy JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  receipt_ids BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  audit_event_ids BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  candidate_bytes BIGINT NOT NULL DEFAULT 0 CHECK (candidate_bytes >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  executed_at TIMESTAMPTZ,
  result JSONB,
  CHECK (array_position(receipt_ids, NULL) IS NULL),
  CHECK (array_position(audit_event_ids, NULL) IS NULL),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'previewed' AND executed_at IS NULL)
    OR (status IN ('executed','invalidated') AND executed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_logging_retention_previews_actor
  ON public.logging_retention_previews (actor_user_id, created_at DESC);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081401_logging_retention_incidents','Add immutable incident snapshots, preview-bound log retention, and a partitioned append-only audit archive.')
ON CONFLICT(version) DO NOTHING;
