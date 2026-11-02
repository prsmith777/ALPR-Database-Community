-- migration: 2026081002_street_overview_pair_sharing
-- A validated primary Street Overview frame may be copied to one uniquely
-- matching companion Street LPR read. New installations begin in shadow mode:
-- matches are recorded for review, but no read or file is changed until an
-- administrator explicitly enables active sharing.
ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS vehicle_image_source_read_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plate_reads_vehicle_image_source_read_id_fkey'
  ) THEN
    ALTER TABLE public.plate_reads
      ADD CONSTRAINT plate_reads_vehicle_image_source_read_id_fkey
      FOREIGN KEY (vehicle_image_source_read_id)
      REFERENCES public.plate_reads(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_source_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_source_kind_check CHECK (
    vehicle_image_source_kind IS NULL OR
    vehicle_image_source_kind IN (
      'legacy_plate_camera','overview_primary','entry_overview_primary',
      'overview_fallback','overview_pair_share','entry_lpr_fallback',
      'entry_overview_route_fallback','entry_overview_history'
    )
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS public.vehicle_overview_pair_sharing_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode VARCHAR(12) NOT NULL DEFAULT 'shadow'
    CHECK (mode IN ('off','shadow','active')),
  observation_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.vehicle_overview_pair_sharing_settings (singleton, mode)
VALUES (TRUE, 'shadow')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_overview_read_shares (
  id BIGSERIAL PRIMARY KEY,
  decision_identity CHAR(64) NOT NULL UNIQUE,
  source_read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
  target_read_id INTEGER NOT NULL UNIQUE REFERENCES public.plate_reads(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL CHECK (
    status IN ('proposed','processing','applied','rejected','failed')
  ),
  decision_reason VARCHAR(80) NOT NULL,
  plate_number_snapshot VARCHAR(32),
  direction_label_snapshot VARCHAR(100),
  source_camera_name_snapshot VARCHAR(120),
  target_camera_name_snapshot VARCHAR(120),
  overview_camera_name_snapshot VARCHAR(120),
  source_profile_id BIGINT,
  source_profile_revision BIGINT,
  target_profile_id BIGINT,
  target_profile_revision BIGINT,
  source_image_path_snapshot TEXT,
  source_anchor_at TIMESTAMPTZ,
  target_anchor_at TIMESTAMPTZ,
  anchor_delta_ms INTEGER,
  decision_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  claim_token UUID,
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  target_image_path TEXT,
  error_code VARCHAR(80),
  error_details JSONB,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vehicle_overview_read_shares_claim
  ON public.vehicle_overview_read_shares (status, created_at, id)
  WHERE status IN ('proposed','processing');

CREATE INDEX IF NOT EXISTS idx_vehicle_overview_read_shares_source
  ON public.vehicle_overview_read_shares (source_read_id, status, id)
  WHERE source_read_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_overview_read_shares_unique_live_source
  ON public.vehicle_overview_read_shares (source_read_id)
  WHERE source_read_id IS NOT NULL AND status IN ('proposed','processing','applied');

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081002_street_overview_pair_sharing','Add shadow-first, one-to-one Street LPR companion sharing with independent image files and durable provenance.')
ON CONFLICT(version) DO NOTHING;
