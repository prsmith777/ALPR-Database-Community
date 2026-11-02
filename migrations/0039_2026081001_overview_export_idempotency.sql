-- migration: 2026081001_overview_export_idempotency
-- Overview processing must not use PostgreSQL timestamps as compare-and-swap
-- revisions because the JavaScript Date representation loses microseconds.
-- Timeline exports also need a stable identity which survives claim renewal,
-- retries, and worker restarts. Existing ledger rows represent an export which
-- was already requested, so they are conservatively marked as dispatched.
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;

ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT IF EXISTS vehicle_overview_pair_profiles_revision_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_pair_profiles_revision_check
  CHECK (revision > 0) NOT VALID;

ALTER TABLE public.blue_iris_timeline_exports
  ADD COLUMN IF NOT EXISTS export_key CHAR(64),
  ADD COLUMN IF NOT EXISTS pair_profile_id BIGINT,
  ADD COLUMN IF NOT EXISTS profile_revision BIGINT,
  ADD COLUMN IF NOT EXISTS algorithm_revision VARCHAR(80),
  ADD COLUMN IF NOT EXISTS automatic_start_count SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS start_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preexisting_remote_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS legacy_imported BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS vehicle_image_recovery_count SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vehicle_image_last_recovered_at TIMESTAMPTZ;

UPDATE public.blue_iris_timeline_exports
SET automatic_start_count = 1,
    legacy_imported = TRUE,
    start_requested_at = COALESCE(start_requested_at, created_at),
    updated_at = CURRENT_TIMESTAMP
WHERE export_key IS NULL AND automatic_start_count = 0;

ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_automatic_start_count_check;
ALTER TABLE public.blue_iris_timeline_exports
  ADD CONSTRAINT blue_iris_timeline_exports_automatic_start_count_check
  CHECK (automatic_start_count BETWEEN 0 AND 1) NOT VALID;

-- pair_profile_id is an immutable historical snapshot, not a live relation.
-- Deleting or editing a profile must not mutate an in-flight export identity.
ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_pair_profile_fkey;
ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_pair_profile_id_fkey;

CREATE UNIQUE INDEX IF NOT EXISTS idx_blue_iris_timeline_exports_stable_key
  ON public.blue_iris_timeline_exports (export_key)
  WHERE export_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_blue_iris_timeline_exports_read_resume
  ON public.blue_iris_timeline_exports (
    read_id, source_camera_name, requested_start_at, requested_duration_ms, id
  );

ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_preexisting_paths_check;
ALTER TABLE public.blue_iris_timeline_exports
  ADD CONSTRAINT blue_iris_timeline_exports_preexisting_paths_check
  CHECK (jsonb_typeof(preexisting_remote_paths) = 'array') NOT VALID;

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_recovery_count_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_recovery_count_check
  CHECK (vehicle_image_recovery_count BETWEEN 0 AND 20) NOT VALID;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081001_overview_export_idempotency','Use integer overview-profile revisions and stable at-most-once Blue Iris timeline-export identities across retries and worker restarts.')
ON CONFLICT(version) DO NOTHING;
