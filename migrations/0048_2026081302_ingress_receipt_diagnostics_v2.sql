-- migration: 2026081302_ingress_receipt_diagnostics_v2
-- Versioned, metadata-only evidence for ambiguous trigger aliases and the
-- existing reads targeted by duplicate submissions. Existing receipts remain
-- schema v1; new application writes explicitly identify schema v2.
ALTER TABLE public.integration_ingress_receipts
  ADD COLUMN IF NOT EXISTS receipt_schema_version SMALLINT NOT NULL DEFAULT 1
    CHECK (receipt_schema_version BETWEEN 1 AND 32767),
  ADD COLUMN IF NOT EXISTS trigger_alias_fields TEXT[] NOT NULL
    DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS trigger_alias_conflict BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS trigger_alias_distinct_value_count SMALLINT NOT NULL DEFAULT 0
    CHECK (trigger_alias_distinct_value_count BETWEEN 0 AND 3),
  ADD COLUMN IF NOT EXISTS duplicate_target_read_ids BIGINT[] NOT NULL
    DEFAULT ARRAY[]::BIGINT[];

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081302_ingress_receipt_diagnostics_v2','Version ingress receipts and add sanitized trigger-alias conflict plus duplicate-target read evidence.')
ON CONFLICT(version) DO NOTHING;
