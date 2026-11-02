-- migration: 2026080901_overview_primary_claim_safety
-- Primary Street Overview retrieval is read-owned and may outlive the worker
-- process which originally claimed it. A per-claim token prevents a reclaimed
-- worker from overwriting a newer result, while next_attempt_at supports one
-- short, bounded retry when a fresh Blue Iris recording is still finalizing.
ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS vehicle_image_claim_token UUID,
  ADD COLUMN IF NOT EXISTS vehicle_image_next_attempt_at TIMESTAMPTZ;

ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT IF EXISTS vehicle_overview_primary_tolerance_ms_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_primary_tolerance_ms_check CHECK (
    source_role <> 'primary' OR tolerance_ms <= 3000
  ) NOT VALID;

ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT IF EXISTS vehicle_overview_distinct_camera_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_distinct_camera_check CHECK (
    LOWER(BTRIM(source_camera_name)) <> LOWER(BTRIM(plate_camera_name))
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_plate_reads_overview_retry_ready
  ON public.plate_reads (vehicle_image_next_attempt_at, timestamp DESC, id DESC)
  WHERE vehicle_image_queue_kind = 'overview'
    AND vehicle_image_status = 'failed'
    AND vehicle_image_retryable = TRUE;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080901_overview_primary_claim_safety','Add token-guarded profile-aware Street Overview claims, bounded recording-finalization retries, and a primary timing tolerance compatible with the six-second sample window.')
ON CONFLICT(version) DO NOTHING;
