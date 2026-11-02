-- migration: 2026082301_vehicle_passage_foundation
-- Passage-first traffic foundation. This is additive and default-shadow: the
-- legacy radar-to-read fields remain readable while new observations acquire
-- explicit clock provenance, audit evidence, and canonical passage ownership.
CREATE TABLE IF NOT EXISTS public.traffic_correlation_profiles (
  id BIGSERIAL PRIMARY KEY,
  profile_key VARCHAR(100) NOT NULL CHECK (NULLIF(BTRIM(profile_key), '') IS NOT NULL),
  version INTEGER NOT NULL CHECK (version > 0),
  state VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (
    state IN ('draft','shadow','active','retired')
  ),
  camera_order JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(camera_order) = 'array'),
  measured_distances JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(measured_distances) = 'object'),
  direction_mappings JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(direction_mappings) = 'object'),
  timing_offsets JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(timing_offsets) = 'object'),
  correlation_window_ms INTEGER NOT NULL DEFAULT 15000 CHECK (
    correlation_window_ms BETWEEN 1000 AND 120000
  ),
  confidence_thresholds JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(confidence_thresholds) = 'object'),
  overview_settings JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(overview_settings) = 'object'),
  clock_sanity_seconds INTEGER NOT NULL DEFAULT 300 CHECK (
    clock_sanity_seconds BETWEEN 5 AND 86400
  ),
  supersedes_profile_id BIGINT REFERENCES public.traffic_correlation_profiles(id) ON DELETE RESTRICT,
  created_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  activated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (profile_key, version),
  CHECK ((state = 'active' AND activated_at IS NOT NULL) OR state <> 'active')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_traffic_correlation_profiles_one_active
  ON public.traffic_correlation_profiles (profile_key)
  WHERE state = 'active';

INSERT INTO public.traffic_correlation_profiles (
  profile_key, version, state, camera_order, measured_distances,
  direction_mappings, timing_offsets, confidence_thresholds,
  overview_settings, clock_sanity_seconds
) VALUES (
  'generic-radar-profile', 1, 'shadow',
  '["street-lpr-1","street-lpr-2","street-overview"]'::JSONB,
  '{}'::JSONB, '{}'::JSONB, '{}'::JSONB, '{}'::JSONB, '{}'::JSONB, 300
)
ON CONFLICT (profile_key, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_passages (
  id BIGSERIAL PRIMARY KEY,
  canonical_event_time TIMESTAMPTZ NOT NULL,
  direction VARCHAR(100),
  selected_speed_mph NUMERIC(5,1) CHECK (
    selected_speed_mph IS NULL OR (selected_speed_mph > 0 AND selected_speed_mph <= 200)
  ),
  lifecycle_state VARCHAR(24) NOT NULL DEFAULT 'provisional' CHECK (
    lifecycle_state IN ('provisional','finalized','ambiguous','rejected')
  ),
  association_confidence NUMERIC(6,5) CHECK (
    association_confidence IS NULL OR (association_confidence >= 0 AND association_confidence <= 1)
  ),
  review_state VARCHAR(24) NOT NULL DEFAULT 'unreviewed' CHECK (
    review_state IN ('unreviewed','needs_review','confirmed','rejected')
  ),
  correlation_profile_id BIGINT REFERENCES public.traffic_correlation_profiles(id) ON DELETE RESTRICT,
  correlation_profile_version INTEGER CHECK (correlation_profile_version IS NULL OR correlation_profile_version > 0),
  correlation_algorithm VARCHAR(100),
  legacy_radar_event_id BIGINT UNIQUE REFERENCES public.radar_events(id) ON DELETE RESTRICT,
  manual_locked BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((lifecycle_state = 'finalized' AND finalized_at IS NOT NULL) OR lifecycle_state <> 'finalized'),
  CHECK ((reviewed_at IS NULL AND reviewed_by_user_id IS NULL) OR reviewed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_passages_recent
  ON public.vehicle_passages (canonical_event_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_passages_review
  ON public.vehicle_passages (review_state, canonical_event_time DESC, id DESC)
  WHERE review_state IN ('unreviewed','needs_review');

CREATE TABLE IF NOT EXISTS public.camera_observations (
  id BIGSERIAL PRIMARY KEY,
  source_key VARCHAR(255) NOT NULL CHECK (NULLIF(BTRIM(source_key), '') IS NOT NULL),
  camera_key VARCHAR(120) NOT NULL CHECK (NULLIF(BTRIM(camera_key), '') IS NOT NULL),
  observation_kind VARCHAR(20) NOT NULL CHECK (
    observation_kind IN ('lpr','overview','track','other')
  ),
  observation_timestamp TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  direction_label VARCHAR(100),
  lane_label VARCHAR(100),
  zone_label VARCHAR(100),
  blue_iris_timeline_path TEXT,
  blue_iris_clip_name VARCHAR(255),
  detection_track_key VARCHAR(255),
  plate_read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
  overview_image_path TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(raw_payload) = 'object'),
  idempotency_key CHAR(64) NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_camera_observations_recent
  ON public.camera_observations (observation_timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_camera_observations_unidentified
  ON public.camera_observations (camera_key, observation_timestamp DESC, id DESC)
  WHERE plate_read_id IS NULL;

ALTER TABLE public.vehicle_passages
  ADD COLUMN IF NOT EXISTS selected_overview_observation_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vehicle_passages_selected_overview_observation_fkey'
      AND conrelid = 'public.vehicle_passages'::regclass
  ) THEN
    ALTER TABLE public.vehicle_passages
      ADD CONSTRAINT vehicle_passages_selected_overview_observation_fkey
      FOREIGN KEY (selected_overview_observation_id)
      REFERENCES public.camera_observations(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.passage_observation_associations (
  id BIGSERIAL PRIMARY KEY,
  passage_id BIGINT NOT NULL REFERENCES public.vehicle_passages(id) ON DELETE CASCADE,
  observation_type VARCHAR(16) NOT NULL CHECK (observation_type IN ('radar','camera')),
  radar_event_id BIGINT REFERENCES public.radar_events(id) ON DELETE RESTRICT,
  camera_observation_id BIGINT REFERENCES public.camera_observations(id) ON DELETE RESTRICT,
  time_delta_ms INTEGER,
  predicted_travel_delta_ms INTEGER,
  direction_score NUMERIC(8,5),
  ordering_score NUMERIC(8,5),
  headway_score NUMERIC(8,5),
  plate_score NUMERIC(8,5),
  reid_score NUMERIC(8,5),
  lane_score NUMERIC(8,5),
  clock_quality_score NUMERIC(8,5),
  missing_observation_penalty NUMERIC(8,5),
  reflection_penalty NUMERIC(8,5),
  total_score NUMERIC(10,5),
  confidence NUMERIC(6,5) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  confidence_class VARCHAR(16) CHECK (
    confidence_class IS NULL OR confidence_class IN ('high','medium','low','ambiguous')
  ),
  algorithm VARCHAR(100) NOT NULL CHECK (NULLIF(BTRIM(algorithm), '') IS NOT NULL),
  algorithm_revision INTEGER NOT NULL CHECK (algorithm_revision > 0),
  correlation_profile_id BIGINT REFERENCES public.traffic_correlation_profiles(id) ON DELETE RESTRICT,
  correlation_profile_version INTEGER CHECK (correlation_profile_version IS NULL OR correlation_profile_version > 0),
  association_source VARCHAR(16) NOT NULL CHECK (
    association_source IN ('automatic','manual','migration')
  ),
  manual_locked BOOLEAN NOT NULL DEFAULT FALSE,
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(evidence) = 'object'),
  created_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  detached_at TIMESTAMPTZ,
  detached_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  detach_reason TEXT,
  CHECK (
    (observation_type = 'radar' AND radar_event_id IS NOT NULL AND camera_observation_id IS NULL)
    OR (observation_type = 'camera' AND camera_observation_id IS NOT NULL AND radar_event_id IS NULL)
  ),
  CHECK (
    (detached_at IS NULL AND detached_by_user_id IS NULL AND detach_reason IS NULL)
    OR (detached_at IS NOT NULL AND NULLIF(BTRIM(detach_reason), '') IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_passage_associations_active_radar
  ON public.passage_observation_associations (radar_event_id)
  WHERE radar_event_id IS NOT NULL AND detached_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_passage_associations_active_camera
  ON public.passage_observation_associations (camera_observation_id)
  WHERE camera_observation_id IS NOT NULL AND detached_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_passage_associations_passage
  ON public.passage_observation_associations (passage_id, created_at, id);

CREATE OR REPLACE FUNCTION public.protect_locked_passage_association()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.manual_locked THEN
    RAISE EXCEPTION 'locked passage association must be explicitly unlocked before detach';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.manual_locked THEN
    IF NEW.manual_locked THEN
      IF (to_jsonb(NEW) - ARRAY['updated_at']) IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['updated_at']) THEN
        RAISE EXCEPTION 'automatic overwrite of a locked passage association is forbidden';
      END IF;
    ELSIF (to_jsonb(NEW) - ARRAY['manual_locked','updated_at']) IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['manual_locked','updated_at']) THEN
      RAISE EXCEPTION 'unlock and mutation of a passage association must be separate operations';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS passage_association_manual_lock ON public.passage_observation_associations;
CREATE TRIGGER passage_association_manual_lock
BEFORE UPDATE OR DELETE ON public.passage_observation_associations
FOR EACH ROW EXECUTE FUNCTION public.protect_locked_passage_association();

CREATE TABLE IF NOT EXISTS public.passage_review_history (
  id BIGSERIAL PRIMARY KEY,
  passage_id BIGINT NOT NULL REFERENCES public.vehicle_passages(id) ON DELETE RESTRICT,
  association_id BIGINT REFERENCES public.passage_observation_associations(id) ON DELETE SET NULL,
  action VARCHAR(24) NOT NULL CHECK (
    action IN ('attach','detach','split','merge','reject','confirm','lock','unlock','note')
  ),
  actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  reason TEXT,
  before_state JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(before_state) = 'object'),
  after_state JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(after_state) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_passage_review_history_passage
  ON public.passage_review_history (passage_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.reject_passage_review_history_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'passage_review_history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS passage_review_history_append_only ON public.passage_review_history;
CREATE TRIGGER passage_review_history_append_only
BEFORE UPDATE OR DELETE ON public.passage_review_history
FOR EACH ROW EXECUTE FUNCTION public.reject_passage_review_history_mutation();

ALTER TABLE public.radar_settings
  ADD COLUMN IF NOT EXISTS legacy_correlation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS clock_sanity_seconds INTEGER NOT NULL DEFAULT 300;

ALTER TABLE public.radar_settings
  DROP CONSTRAINT IF EXISTS radar_settings_clock_sanity_seconds_check;
ALTER TABLE public.radar_settings
  ADD CONSTRAINT radar_settings_clock_sanity_seconds_check CHECK (
    clock_sanity_seconds BETWEEN 5 AND 86400
  );

ALTER TABLE public.radar_events
  ADD COLUMN IF NOT EXISTS device_timestamp_raw TEXT,
  ADD COLUMN IF NOT EXISTS device_timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS canonical_timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timestamp_quality VARCHAR(32),
  ADD COLUMN IF NOT EXISTS timestamp_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS payload_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS idempotency_key CHAR(64),
  ADD COLUMN IF NOT EXISTS duplicate_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_duplicate_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS passage_id BIGINT REFERENCES public.vehicle_passages(id) ON DELETE SET NULL;

UPDATE public.radar_events
SET device_timestamp_raw = COALESCE(
      raw_payload->>'timestamp', raw_payload->>'time',
      raw_payload->>'event_timestamp', raw_payload->>'eventTimestamp', raw_payload->>'ts'
    ),
    device_timestamp = CASE
      WHEN event_timestamp >= TIMESTAMPTZ '2000-01-01 00:00:00+00'
       AND event_timestamp < TIMESTAMPTZ '2100-01-01 00:00:00+00'
      THEN event_timestamp ELSE NULL END,
    canonical_timestamp = CASE
      WHEN event_timestamp >= TIMESTAMPTZ '2000-01-01 00:00:00+00'
       AND event_timestamp < TIMESTAMPTZ '2100-01-01 00:00:00+00'
       AND ABS(EXTRACT(EPOCH FROM (event_timestamp - received_at))) <= 300
      THEN event_timestamp ELSE received_at END,
    timestamp_quality = CASE
      WHEN event_timestamp < TIMESTAMPTZ '2000-01-01 00:00:00+00'
      THEN 'historical_unsynced'
      WHEN ABS(EXTRACT(EPOCH FROM (event_timestamp - received_at))) <= 300
      THEN 'device_synced'
      ELSE 'receipt_fallback' END,
    timestamp_reason = CASE
      WHEN event_timestamp < TIMESTAMPTZ '2000-01-01 00:00:00+00'
      THEN 'migration_pre_ntp_uptime'
      WHEN ABS(EXTRACT(EPOCH FROM (event_timestamp - received_at))) <= 300
      THEN 'migration_device_within_receipt_window'
      ELSE 'migration_device_outside_receipt_window' END,
    payload_hash = message_hash,
    idempotency_key = message_hash
WHERE canonical_timestamp IS NULL
   OR timestamp_quality IS NULL
   OR timestamp_reason IS NULL
   OR payload_hash IS NULL
   OR idempotency_key IS NULL;

ALTER TABLE public.radar_events
  ALTER COLUMN canonical_timestamp SET NOT NULL,
  ALTER COLUMN timestamp_quality SET NOT NULL,
  ALTER COLUMN timestamp_reason SET NOT NULL,
  ALTER COLUMN payload_hash SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL;

ALTER TABLE public.radar_events
  DROP CONSTRAINT IF EXISTS radar_events_timestamp_quality_check;
ALTER TABLE public.radar_events
  ADD CONSTRAINT radar_events_timestamp_quality_check CHECK (
    timestamp_quality IN ('device_synced','receipt_fallback','invalid','historical_unsynced')
  );
ALTER TABLE public.radar_events
  DROP CONSTRAINT IF EXISTS radar_events_duplicate_count_check;
ALTER TABLE public.radar_events
  ADD CONSTRAINT radar_events_duplicate_count_check CHECK (duplicate_count >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_events_idempotency_key
  ON public.radar_events (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_radar_events_canonical_recent
  ON public.radar_events (canonical_timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_radar_events_passage
  ON public.radar_events (passage_id, canonical_timestamp, id)
  WHERE passage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_radar_events_unassociated_passage
  ON public.radar_events (canonical_timestamp, id)
  WHERE passage_id IS NULL;

-- Preserve an existing legacy match as explicitly reviewable migration
-- evidence. Unmatched and pre-NTP rows are not guessed into passages here;
-- the former belongs to bounded shadow processing and the latter remains at
-- the historical-backfill approval gate.
INSERT INTO public.vehicle_passages (
  canonical_event_time, direction, selected_speed_mph, lifecycle_state,
  review_state, correlation_profile_id, correlation_profile_version,
  correlation_algorithm, legacy_radar_event_id
)
SELECT radar.canonical_timestamp, radar.direction, radar.speed_mph,
       'ambiguous', 'needs_review', profiles.id, profiles.version,
       'legacy-radar-read-migration-v1', radar.id
FROM public.radar_events radar
JOIN public.traffic_correlation_profiles profiles
  ON profiles.profile_key = 'generic-radar-profile' AND profiles.version = 1
WHERE radar.matched_read_id IS NOT NULL
  AND radar.timestamp_quality <> 'historical_unsynced'
ON CONFLICT (legacy_radar_event_id) DO NOTHING;

INSERT INTO public.camera_observations (
  source_key, camera_key, observation_kind, observation_timestamp,
  received_at, direction_label, blue_iris_timeline_path, plate_read_id,
  raw_payload, idempotency_key
)
SELECT 'legacy-plate-read',
       COALESCE(NULLIF(BTRIM(reads.camera_name), ''), 'unconfigured-camera'),
       'lpr', reads."timestamp", reads.created_at,
       COALESCE(direction.direction_label, reads.bi_trigger_direction_label),
       reads.bi_alert_path, reads.id,
       jsonb_build_object('migration', 'legacy-radar-read-v1'),
       repeat(md5('legacy-radar-read:' || reads.id::text), 2)
FROM public.vehicle_passages passages
JOIN public.radar_events radar ON radar.id = passages.legacy_radar_event_id
JOIN public.plate_reads reads ON reads.id = radar.matched_read_id
LEFT JOIN LATERAL (
  SELECT observations.direction_label
  FROM public.vehicle_direction_observations observations
  WHERE observations.read_id = reads.id
  ORDER BY observations.evaluated_at DESC, observations.read_id DESC
  LIMIT 1
) direction ON TRUE
WHERE passages.correlation_algorithm = 'legacy-radar-read-migration-v1'
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO public.passage_observation_associations (
  passage_id, observation_type, radar_event_id, time_delta_ms,
  total_score, confidence_class, algorithm, algorithm_revision,
  correlation_profile_id, correlation_profile_version,
  association_source, evidence
)
SELECT passages.id, 'radar', radar.id, 0, NULL, 'ambiguous',
       'legacy-radar-read-migration-v1', 1,
       passages.correlation_profile_id, passages.correlation_profile_version,
       'migration', jsonb_build_object(
         'legacyMatchedReadId', radar.matched_read_id,
         'legacyMatchDeltaMs', radar.match_delta_ms,
         'requiresReview', TRUE
       )
FROM public.vehicle_passages passages
JOIN public.radar_events radar ON radar.id = passages.legacy_radar_event_id
ON CONFLICT DO NOTHING;

INSERT INTO public.passage_observation_associations (
  passage_id, observation_type, camera_observation_id, time_delta_ms,
  total_score, confidence_class, algorithm, algorithm_revision,
  correlation_profile_id, correlation_profile_version,
  association_source, evidence
)
SELECT passages.id, 'camera', camera.id,
       ROUND(EXTRACT(EPOCH FROM (
         camera.observation_timestamp - passages.canonical_event_time
       )) * 1000)::INTEGER,
       NULL, 'ambiguous', 'legacy-radar-read-migration-v1', 1,
       passages.correlation_profile_id, passages.correlation_profile_version,
       'migration', jsonb_build_object('requiresReview', TRUE)
FROM public.vehicle_passages passages
JOIN public.radar_events radar ON radar.id = passages.legacy_radar_event_id
JOIN public.camera_observations camera ON camera.plate_read_id = radar.matched_read_id
WHERE camera.idempotency_key = repeat(md5('legacy-radar-read:' || radar.matched_read_id::text), 2)
ON CONFLICT DO NOTHING;

UPDATE public.radar_events radar
SET passage_id = passages.id
FROM public.vehicle_passages passages
WHERE passages.legacy_radar_event_id = radar.id
  AND radar.passage_id IS DISTINCT FROM passages.id;

CREATE TABLE IF NOT EXISTS public.radar_ingest_receipts (
  id BIGSERIAL PRIMARY KEY,
  source_key VARCHAR(255) NOT NULL CHECK (NULLIF(BTRIM(source_key), '') IS NOT NULL),
  topic VARCHAR(512) NOT NULL CHECK (NULLIF(BTRIM(topic), '') IS NOT NULL),
  received_at TIMESTAMPTZ NOT NULL,
  qos SMALLINT CHECK (qos IS NULL OR qos BETWEEN 0 AND 2),
  retained BOOLEAN,
  mqtt_duplicate BOOLEAN,
  status VARCHAR(16) NOT NULL CHECK (status IN ('accepted','duplicate','rejected')),
  rejection_reason VARCHAR(100),
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key CHAR(64) CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[0-9a-f]{64}$'),
  raw_payload_text TEXT NOT NULL,
  raw_payload JSONB CHECK (raw_payload IS NULL OR jsonb_typeof(raw_payload) = 'object'),
  radar_event_id BIGINT REFERENCES public.radar_events(id) ON DELETE SET NULL,
  duplicate_of_event_id BIGINT REFERENCES public.radar_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((status = 'rejected' AND rejection_reason IS NOT NULL) OR status <> 'rejected'),
  CHECK ((status = 'duplicate' AND duplicate_of_event_id IS NOT NULL) OR status <> 'duplicate')
);

CREATE INDEX IF NOT EXISTS idx_radar_ingest_receipts_recent
  ON public.radar_ingest_receipts (received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_radar_ingest_receipts_status
  ON public.radar_ingest_receipts (status, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_radar_ingest_receipts_event
  ON public.radar_ingest_receipts (radar_event_id, id)
  WHERE radar_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_radar_ingest_receipts_duplicate_event
  ON public.radar_ingest_receipts (duplicate_of_event_id, id)
  WHERE duplicate_of_event_id IS NOT NULL;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026082301_vehicle_passage_foundation','Retain the default-shadow vehicle-passage schema for compatibility without enabling a Community traffic interface.')
ON CONFLICT(version) DO NOTHING;
