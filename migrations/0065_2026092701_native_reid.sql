-- migration: 2026092701_native_reid
-- One-time retirement of obsolete derived-index objects on upgrade.
-- Run only with the app stopped and a verified database backup (the updater
-- enforces both). Original reads, images, users, tags, and reviews are retained.
-- These names are upgrade targets, never runtime dependencies.
DROP FUNCTION IF EXISTS public.validate_vehicle_reid_control_transition() CASCADE;
DROP FUNCTION IF EXISTS public.validate_vehicle_reid_control_stage2_transition() CASCADE;
DROP FUNCTION IF EXISTS public.seed_vehicle_reid_v2_live_discovery_state() CASCADE;
DROP FUNCTION IF EXISTS public.guard_stopped_vehicle_reid_v1_writes() CASCADE;
DROP FUNCTION IF EXISTS public.guard_vehicle_reid_v2_origin_authority_mutation() CASCADE;
DROP FUNCTION IF EXISTS public.validate_vehicle_reid_v2_conversion_transition() CASCADE;
DROP FUNCTION IF EXISTS public.validate_vehicle_reid_v2_materialization_transition() CASCADE;
DROP FUNCTION IF EXISTS public.validate_vehicle_reid_v2_stage2_materialization_transition() CASCADE;
DROP FUNCTION IF EXISTS public.prevent_vehicle_reid_v2_conversion_snapshot_mutation() CASCADE;
DROP FUNCTION IF EXISTS public.capture_asset_set_updated_at() CASCADE;
DROP FUNCTION IF EXISTS public.camera_visual_profile_set_updated_at() CASCADE;
DROP FUNCTION IF EXISTS public.assert_vehicle_reid_v2_exact_materialization(bigint);
DROP FUNCTION IF EXISTS public.assert_vehicle_reid_v2_stage2_materialization(bigint);
DO $native_control$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vehicle_reid_control'
      AND column_name = 'previous_mode') THEN
    DROP TABLE public.vehicle_reid_control;
    UPDATE public.vehicle_image_asset_live_catalog_control
      SET enabled = TRUE, enabled_at = CURRENT_TIMESTAMP, disabled_at = NULL;
    UPDATE public.vehicle_image_crop_live_control
      SET enabled = TRUE, enabled_at = CURRENT_TIMESTAMP, disabled_at = NULL;
  END IF;
END
$native_control$;
ALTER TABLE IF EXISTS public.vehicle_reid_v2_profiles
  DROP COLUMN IF EXISTS origin_conversion_run_id CASCADE,
  DROP COLUMN IF EXISTS origin_projection_key CASCADE;
ALTER TABLE IF EXISTS public.vehicle_reid_v2_profile_members
  DROP COLUMN IF EXISTS origin_conversion_run_id CASCADE,
  DROP COLUMN IF EXISTS origin_projected_member_fingerprint CASCADE;
ALTER TABLE IF EXISTS public.vehicle_reid_v2_read_assignments
  DROP COLUMN IF EXISTS origin_conversion_run_id CASCADE,
  DROP COLUMN IF EXISTS origin_disposition_fingerprint CASCADE;
ALTER TABLE IF EXISTS public.vehicle_reid_v2_profile_plate_anchors
  DROP COLUMN IF EXISTS origin_conversion_run_id CASCADE,
  DROP COLUMN IF EXISTS origin_projection_key CASCADE;
ALTER TABLE IF EXISTS public.vehicle_reid_v2_live_discovery_state
  DROP COLUMN IF EXISTS transition_run_id CASCADE;
DROP TABLE IF EXISTS public.vehicle_reid_v2_conversion_v1_comparisons;
DROP TABLE IF EXISTS public.vehicle_reid_v2_conversion_conflicts;
DROP TABLE IF EXISTS public.vehicle_reid_v2_conversion_read_dispositions;
DROP TABLE IF EXISTS public.vehicle_reid_v2_conversion_projected_members;
DROP TABLE IF EXISTS public.vehicle_reid_v2_conversion_projected_profiles;
DROP TABLE IF EXISTS public.vehicle_reid_v2_conversion_jobs;
DROP TABLE IF EXISTS public.vehicle_reid_v2_conversion_review_evidence;
DROP TABLE IF EXISTS public.vehicle_reid_v2_conversion_read_evidence;
DROP TABLE IF EXISTS public.vehicle_reid_v2_conversion_crop_evidence;
DROP TABLE IF EXISTS public.vehicle_reid_v2_conversion_runs;
DROP TABLE IF EXISTS public.vehicle_plate_associations;
DROP TABLE IF EXISTS public.vehicle_cluster_assignments;
DROP TABLE IF EXISTS public.vehicle_clusters;
DROP TABLE IF EXISTS public.vehicle_match_feedback;
DROP TABLE IF EXISTS public.capture_assets;
DROP TABLE IF EXISTS public.camera_visual_profiles;

-- ReID is native and exclusive: there is no alternate identity provider.
CREATE TABLE IF NOT EXISTS public.vehicle_reid_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  mode VARCHAR(16) NOT NULL DEFAULT 'v2_primary' CHECK (mode = 'v2_primary'),
  processing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);
INSERT INTO public.vehicle_reid_control(singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_profiles (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(16) NOT NULL CHECK (
    status IN ('provisional','active','merged','retired')
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  provenance_basis VARCHAR(32) NOT NULL CHECK (
    provenance_basis IN (
      'exact_effective_plate','human_same','mixed','provisional_singleton'
    )
  ),
  representative_derivative_id BIGINT NOT NULL
    REFERENCES public.vehicle_image_derivatives(id) ON DELETE RESTRICT,
  representative_embedding_id BIGINT NOT NULL
    REFERENCES public.vehicle_asset_embeddings(id) ON DELETE RESTRICT,
  representative_source_sha256 CHAR(64) NOT NULL CHECK (
    representative_source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  representative_evidence_fingerprint CHAR(64) NOT NULL CHECK (
    representative_evidence_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  merged_into_profile_id BIGINT
    REFERENCES public.vehicle_reid_v2_profiles(id) ON DELETE RESTRICT,
  created_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_by_username VARCHAR(64) NOT NULL CHECK (
    NULLIF(BTRIM(created_by_username), '') IS NOT NULL
  ),
  created_by_display_name VARCHAR(120) NOT NULL CHECK (
    NULLIF(BTRIM(created_by_display_name), '') IS NOT NULL
  ),
  merged_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'merged'
      AND merged_into_profile_id IS NOT NULL
      AND merged_into_profile_id <> id
      AND merged_at IS NOT NULL
      AND retired_at IS NULL)
    OR (status <> 'merged'
      AND merged_into_profile_id IS NULL
      AND merged_at IS NULL)
  ),
  CHECK (
    (status = 'retired' AND retired_at IS NOT NULL)
    OR (status <> 'retired' AND retired_at IS NULL)
  ),
  CHECK (
    (status = 'provisional' AND provenance_basis = 'provisional_singleton')
    OR status <> 'provisional'
  )
);

CREATE INDEX IF NOT EXISTS idx_reid_v2_profiles_status
  ON public.vehicle_reid_v2_profiles (status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_reid_v2_profiles_merge_target
  ON public.vehicle_reid_v2_profiles (merged_into_profile_id)
  WHERE merged_into_profile_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_profile_members (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL
    REFERENCES public.vehicle_reid_v2_profiles(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'current' CHECK (
    status IN ('current','superseded','removed')
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  derivative_id BIGINT NOT NULL
    REFERENCES public.vehicle_image_derivatives(id) ON DELETE RESTRICT,
  asset_id BIGINT NOT NULL
    REFERENCES public.vehicle_image_assets(id) ON DELETE RESTRICT,
  derivative_kind VARCHAR(32) NOT NULL CHECK (derivative_kind = 'vehicle_crop'),
  crop_algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(crop_algorithm_version), '') IS NOT NULL
  ),
  asset_source_sha256 CHAR(64) NOT NULL CHECK (
    asset_source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  crop_content_sha256 CHAR(64) NOT NULL CHECK (
    crop_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  embedding_id BIGINT NOT NULL
    REFERENCES public.vehicle_asset_embeddings(id) ON DELETE RESTRICT,
  embedding_model VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(embedding_model), '') IS NOT NULL
  ),
  embedding_algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(embedding_algorithm_version), '') IS NOT NULL
  ),
  embedding_source_sha256 CHAR(64) NOT NULL CHECK (
    embedding_source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  embedding_sha256 CHAR(64) NOT NULL CHECK (
    embedding_sha256 ~ '^[0-9a-f]{64}$'
  ),
  membership_basis VARCHAR(32) NOT NULL CHECK (
    membership_basis IN (
      'exact_effective_plate','human_same','mixed','provisional_singleton'
    )
  ),
  representative_evidence_read_id INTEGER NOT NULL CHECK (
    representative_evidence_read_id > 0
  ),
  source_revision_fingerprint CHAR(64) NOT NULL CHECK (
    source_revision_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  evidence_fingerprint CHAR(64) NOT NULL CHECK (
    evidence_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (profile_id, id),
  CHECK (
    (status = 'current' AND ended_at IS NULL)
    OR (status <> 'current' AND ended_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reid_v2_member_one_current_crop
  ON public.vehicle_reid_v2_profile_members (derivative_id)
  WHERE status = 'current';
CREATE INDEX IF NOT EXISTS idx_reid_v2_member_profile
  ON public.vehicle_reid_v2_profile_members (
    profile_id, status, created_at DESC, id DESC
  );
CREATE INDEX IF NOT EXISTS idx_reid_v2_member_embedding
  ON public.vehicle_reid_v2_profile_members (embedding_id, status, id);

CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_read_assignments (
  id BIGSERIAL PRIMARY KEY,
  read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE CASCADE,
  profile_id BIGINT NOT NULL
    REFERENCES public.vehicle_reid_v2_profiles(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (
    status IN ('active','superseded','withdrawn')
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  assignment_basis VARCHAR(32) NOT NULL CHECK (
    assignment_basis IN (
      'canonical_image','shared_asset','exact_effective_plate','human_same'
    )
  ),
  profile_membership_basis VARCHAR(32) NOT NULL CHECK (
    profile_membership_basis IN (
      'exact_effective_plate','human_same','mixed','provisional_singleton'
    )
  ),
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  profile_member_id BIGINT,
  asset_id BIGINT REFERENCES public.vehicle_image_assets(id) ON DELETE RESTRICT,
  derivative_id BIGINT
    REFERENCES public.vehicle_image_derivatives(id) ON DELETE RESTRICT,
  embedding_id BIGINT
    REFERENCES public.vehicle_asset_embeddings(id) ON DELETE RESTRICT,
  normalized_effective_plate VARCHAR(32) CHECK (
    normalized_effective_plate IS NULL
    OR normalized_effective_plate ~ '^[A-Z0-9]+$'
  ),
  plate_review_status VARCHAR(24) NOT NULL CHECK (
    plate_review_status IN (
      'unreviewed','confirmed','corrected','rejected','alias_resolved'
    )
  ),
  plate_review_revision INTEGER NOT NULL CHECK (plate_review_revision >= 0),
  plate_review_id BIGINT CHECK (plate_review_id IS NULL OR plate_review_id > 0),
  applied_alias_id BIGINT CHECK (applied_alias_id IS NULL OR applied_alias_id > 0),
  source_kind VARCHAR(40),
  source_relationship VARCHAR(24),
  source_path_snapshot TEXT,
  source_updated_at TIMESTAMPTZ,
  source_link_updated_at TIMESTAMPTZ,
  evidence_fingerprint CHAR(64) NOT NULL CHECK (
    evidence_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id, profile_member_id)
    REFERENCES public.vehicle_reid_v2_profile_members(profile_id, id)
    ON DELETE RESTRICT,
  CHECK (plate_review_status <> 'rejected'),
  CHECK (
    (status = 'active' AND ended_at IS NULL)
    OR (status <> 'active' AND ended_at IS NOT NULL)
  ),
  CHECK (
    assignment_basis <> 'exact_effective_plate'
    OR (
      normalized_effective_plate IS NOT NULL
      AND plate_review_status IN ('confirmed','corrected','alias_resolved')
    )
  ),
  CHECK (
    assignment_basis NOT IN ('canonical_image','shared_asset','human_same')
    OR (
      profile_member_id IS NOT NULL AND asset_id IS NOT NULL
      AND derivative_id IS NOT NULL AND embedding_id IS NOT NULL
      AND NULLIF(BTRIM(source_path_snapshot), '') IS NOT NULL
      AND source_link_updated_at IS NOT NULL
    )
  )
);


-- migration intentionally preserves sealed active history after its evidence
-- becomes stale and enforces one exact-current assignment through the
-- current-contract view plus a per-read transaction lock.  Recreating the
-- obsolete index during a full migration replay would reject that valid
-- history before the later migration can replace the index again.
DROP INDEX IF EXISTS public.idx_reid_v2_assignment_one_active_read;
CREATE INDEX IF NOT EXISTS idx_reid_v2_assignment_profile
  ON public.vehicle_reid_v2_read_assignments (
    profile_id, status, created_at DESC, id DESC
  );
CREATE INDEX IF NOT EXISTS idx_reid_v2_assignment_plate
  ON public.vehicle_reid_v2_read_assignments (
    normalized_effective_plate, status, read_id
  ) WHERE normalized_effective_plate IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_vehicle_reid_v2_profile_contract()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.vehicle_image_derivatives derivatives
    JOIN public.vehicle_image_assets assets
      ON assets.id = derivatives.asset_id
    JOIN public.vehicle_asset_embeddings embeddings
      ON embeddings.id = NEW.representative_embedding_id
     AND embeddings.derivative_id = derivatives.id
    WHERE derivatives.id = NEW.representative_derivative_id
      AND derivatives.source_sha256 = assets.content_sha256
      AND embeddings.source_sha256 = derivatives.content_sha256
      AND derivatives.content_sha256 = NEW.representative_source_sha256
  ) THEN
    RAISE EXCEPTION 'ReID v2 profile representative evidence is not an exact canonical contract'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_profile_representative_contract';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_reid_v2_profiles_validate_contract
  ON public.vehicle_reid_v2_profiles;
CREATE TRIGGER vehicle_reid_v2_profiles_validate_contract
BEFORE INSERT OR UPDATE ON public.vehicle_reid_v2_profiles
FOR EACH ROW EXECUTE FUNCTION public.validate_vehicle_reid_v2_profile_contract();

CREATE OR REPLACE FUNCTION public.validate_vehicle_reid_v2_member_contract()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.vehicle_image_derivatives derivatives
    JOIN public.vehicle_image_assets assets
      ON assets.id = derivatives.asset_id
    JOIN public.vehicle_asset_embeddings embeddings
      ON embeddings.id = NEW.embedding_id
     AND embeddings.derivative_id = derivatives.id
    WHERE derivatives.id = NEW.derivative_id
      AND assets.id = NEW.asset_id
      AND derivatives.derivative_kind = NEW.derivative_kind
      AND derivatives.algorithm_version = NEW.crop_algorithm_version
      AND assets.content_sha256 = NEW.asset_source_sha256
      AND derivatives.source_sha256 = NEW.asset_source_sha256
      AND derivatives.content_sha256 = NEW.crop_content_sha256
      AND embeddings.model_name = NEW.embedding_model
      AND embeddings.algorithm_version = NEW.embedding_algorithm_version
      AND embeddings.source_sha256 = NEW.embedding_source_sha256
      AND embeddings.source_sha256 = NEW.crop_content_sha256
      AND embeddings.embedding_sha256 = NEW.embedding_sha256
  ) THEN
    RAISE EXCEPTION 'ReID v2 member evidence is not one exact asset/crop/embedding contract'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_member_canonical_contract';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_reid_v2_members_validate_contract
  ON public.vehicle_reid_v2_profile_members;
CREATE TRIGGER vehicle_reid_v2_members_validate_contract
BEFORE INSERT OR UPDATE ON public.vehicle_reid_v2_profile_members
FOR EACH ROW EXECUTE FUNCTION public.validate_vehicle_reid_v2_member_contract();
CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_profile_plate_anchors (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL
    REFERENCES public.vehicle_reid_v2_profiles(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'current' CHECK (
    status IN ('current','superseded','withdrawn')
  ),
  normalized_plate VARCHAR(32) NOT NULL CHECK (
    normalized_plate ~ '^[A-Z0-9]+$'
  ),
  evidence_read_id INTEGER NOT NULL CHECK (evidence_read_id > 0),
  plate_review_status VARCHAR(24) NOT NULL CHECK (
    plate_review_status IN ('confirmed','corrected','alias_resolved')
  ),
  plate_review_revision INTEGER NOT NULL CHECK (plate_review_revision >= 0),
  plate_review_id BIGINT CHECK (plate_review_id IS NULL OR plate_review_id > 0),
  applied_alias_id BIGINT CHECK (applied_alias_id IS NULL OR applied_alias_id > 0),
  evidence_fingerprint CHAR(64) NOT NULL CHECK (
    evidence_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'current' AND ended_at IS NULL)
    OR (status <> 'current' AND ended_at IS NOT NULL)
  )
);

-- Exact-current uniqueness is enforced by the validation trigger below.  A

-- so the physical history may contain more than one status='current' row even
-- though the current-evidence view can expose at most one.
DROP INDEX IF EXISTS public.idx_reid_v2_plate_anchor_one_current_plate;
CREATE INDEX IF NOT EXISTS idx_reid_v2_plate_anchor_current_plate
  ON public.vehicle_reid_v2_profile_plate_anchors (normalized_plate)
  WHERE status = 'current';
CREATE INDEX IF NOT EXISTS idx_reid_v2_plate_anchor_profile
  ON public.vehicle_reid_v2_profile_plate_anchors (
    profile_id, status, normalized_plate, id
  );

CREATE OR REPLACE FUNCTION public.validate_vehicle_reid_v2_plate_anchor_contract()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'current' THEN
    PERFORM pg_advisory_xact_lock(hashtext(
      'vehicle_reid_v2_plate_anchor:' || NEW.normalized_plate
    ));
    IF NOT EXISTS (
      SELECT 1
      FROM public.plate_reads reads
      WHERE reads.id = NEW.evidence_read_id
        AND UPPER(REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g'))
              = NEW.normalized_plate
        AND reads.review_status = NEW.plate_review_status
        AND reads.review_revision = NEW.plate_review_revision
        AND reads.applied_alias_id IS NOT DISTINCT FROM NEW.applied_alias_id
        AND NEW.plate_review_id IS NOT DISTINCT FROM (
          SELECT reviews.id
          FROM public.plate_read_reviews reviews
          WHERE reviews.read_id = NEW.evidence_read_id
          ORDER BY reviews.created_at DESC, reviews.id DESC
          LIMIT 1
        )
    ) THEN
      RAISE EXCEPTION 'ReID v2 plate anchor is not exact current reviewed plate evidence'
        USING ERRCODE = '23514',
              CONSTRAINT = 'vehicle_reid_v2_plate_anchor_current_contract';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.vehicle_reid_v2_profile_plate_anchors existing
      JOIN public.plate_reads evidence ON evidence.id = existing.evidence_read_id
      WHERE existing.id IS DISTINCT FROM NEW.id
        AND existing.status = 'current'
        AND existing.normalized_plate = NEW.normalized_plate
        AND UPPER(REGEXP_REPLACE(evidence.plate_number, '[^A-Za-z0-9]', '', 'g'))
              = existing.normalized_plate
        AND evidence.review_status = existing.plate_review_status
        AND evidence.review_revision = existing.plate_review_revision
        AND evidence.applied_alias_id IS NOT DISTINCT FROM existing.applied_alias_id
        AND existing.plate_review_id IS NOT DISTINCT FROM (
          SELECT reviews.id
          FROM public.plate_read_reviews reviews
          WHERE reviews.read_id = existing.evidence_read_id
          ORDER BY reviews.created_at DESC, reviews.id DESC
          LIMIT 1
        )
    ) THEN
      RAISE EXCEPTION 'ReID v2 reviewed plate already anchors a current profile'
        USING ERRCODE = '23514',
              CONSTRAINT = 'vehicle_reid_v2_plate_anchor_one_exact_current_plate';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_reid_v2_plate_anchors_validate_contract
  ON public.vehicle_reid_v2_profile_plate_anchors;
CREATE TRIGGER vehicle_reid_v2_plate_anchors_validate_contract
BEFORE INSERT OR UPDATE ON public.vehicle_reid_v2_profile_plate_anchors
FOR EACH ROW EXECUTE FUNCTION public.validate_vehicle_reid_v2_plate_anchor_contract();
CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_live_jobs (
  read_id INTEGER PRIMARY KEY
    REFERENCES public.plate_reads(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending','processing','ready','conflict','unavailable','failed')
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (
    operator_retry_count BETWEEN 0 AND 1
  ),
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  claim_token UUID,
  processing_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  profile_id BIGINT REFERENCES public.vehicle_reid_v2_profiles(id) ON DELETE RESTRICT,
  assignment_id BIGINT
    REFERENCES public.vehicle_reid_v2_read_assignments(id) ON DELETE RESTRICT,
  result_basis VARCHAR(32),
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR JSONB_TYPEOF(error_details) = 'object'
  ),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL
      AND processing_deadline_at IS NOT NULL)
    OR (status <> 'processing' AND claim_token IS NULL
      AND processing_deadline_at IS NULL)
  ),
  CHECK (
    (status = 'ready' AND profile_id IS NOT NULL AND assignment_id IS NOT NULL
      AND completed_at IS NOT NULL AND error_code IS NULL)
    OR status <> 'ready'
  ),
  CHECK (
    (status IN ('conflict','unavailable','failed') AND error_code IS NOT NULL)
    OR status NOT IN ('conflict','unavailable','failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_reid_v2_live_job_claim
  ON public.vehicle_reid_v2_live_jobs (
    status, next_attempt_at, read_id
  ) WHERE status IN ('pending','processing','failed');
CREATE INDEX IF NOT EXISTS idx_reid_v2_live_job_profile
  ON public.vehicle_reid_v2_live_jobs (profile_id, status, read_id)
  WHERE profile_id IS NOT NULL;

-- Audited Same decisions can collapse two stable public profile identifiers

-- current view below, so a revised/stale review fails closed automatically.
CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_profile_merges (
  id BIGSERIAL PRIMARY KEY,
  source_profile_id BIGINT NOT NULL
    REFERENCES public.vehicle_reid_v2_profiles(id) ON DELETE RESTRICT,
  target_profile_id BIGINT NOT NULL
    REFERENCES public.vehicle_reid_v2_profiles(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'current' CHECK (
    status IN ('current','withdrawn')
  ),
  pair_review_id BIGINT NOT NULL
    REFERENCES public.vehicle_reid_v2_pair_reviews(id) ON DELETE RESTRICT,
  pair_review_revision INTEGER NOT NULL CHECK (pair_review_revision > 0),
  evidence_fingerprint CHAR(64) NOT NULL UNIQUE CHECK (
    evidence_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  actor_username VARCHAR(64) NOT NULL CHECK (
    NULLIF(BTRIM(actor_username), '') IS NOT NULL
  ),
  actor_display_name VARCHAR(120) NOT NULL CHECK (
    NULLIF(BTRIM(actor_display_name), '') IS NOT NULL
  ),
  ended_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  ended_by_username VARCHAR(64),
  ended_by_display_name VARCHAR(120),
  end_reason VARCHAR(80),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (source_profile_id <> target_profile_id),
  CHECK (
    (status = 'current' AND ended_at IS NULL
      AND ended_by_username IS NULL AND ended_by_display_name IS NULL
      AND end_reason IS NULL)
    OR (status = 'withdrawn' AND ended_at IS NOT NULL
      AND NULLIF(BTRIM(ended_by_username), '') IS NOT NULL
      AND NULLIF(BTRIM(ended_by_display_name), '') IS NOT NULL
      AND NULLIF(BTRIM(end_reason), '') IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reid_v2_profile_merge_one_current_source
  ON public.vehicle_reid_v2_profile_merges (source_profile_id)
  WHERE status = 'current';
CREATE INDEX IF NOT EXISTS idx_reid_v2_profile_merge_target
  ON public.vehicle_reid_v2_profile_merges (
    target_profile_id, status, source_profile_id
  );

-- A profile member is usable by current consumers only while its exact crop,
-- embedding, and at least one identity-eligible canonical source link still
-- match.  The historical authority row remains untouched when a source is
-- replaced; this view is the fail-closed current contract.
CREATE OR REPLACE VIEW public.vehicle_reid_v2_exact_profile_members AS
SELECT members.*
FROM public.vehicle_reid_v2_profile_members members
JOIN public.vehicle_reid_v2_profiles profiles ON profiles.id = members.profile_id
JOIN public.vehicle_image_derivatives derivatives
  ON derivatives.id = members.derivative_id
 AND derivatives.asset_id = members.asset_id
 AND derivatives.derivative_kind = members.derivative_kind
 AND derivatives.algorithm_version = members.crop_algorithm_version
 AND derivatives.source_sha256 = members.asset_source_sha256
 AND derivatives.content_sha256 = members.crop_content_sha256
JOIN public.vehicle_image_assets assets
  ON assets.id = members.asset_id
 AND assets.content_sha256 = members.asset_source_sha256
JOIN public.vehicle_asset_embeddings embeddings
  ON embeddings.id = members.embedding_id
 AND embeddings.derivative_id = members.derivative_id
 AND embeddings.model_name = members.embedding_model
 AND embeddings.algorithm_version = members.embedding_algorithm_version
 AND embeddings.source_sha256 = members.embedding_source_sha256
 AND embeddings.embedding_sha256 = members.embedding_sha256
WHERE members.status = 'current'
  AND profiles.status IN ('active','provisional')
  AND EXISTS (
    SELECT 1
    FROM public.vehicle_image_asset_reads links
    JOIN public.plate_reads reads ON reads.id = links.read_id
    WHERE links.asset_id = members.asset_id
      AND links.identity_eligible = TRUE
      AND links.relationship <> 'display_fallback'
      AND reads.vehicle_image_status = 'ready'
      AND reads.vehicle_image_path = links.source_path_snapshot
      AND reads.vehicle_image_source_kind = links.source_kind
      AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
  )
  AND (
    SELECT COUNT(DISTINCT UPPER(
      REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g')
    ))
    FROM public.vehicle_image_asset_reads links
    JOIN public.plate_reads reads ON reads.id = links.read_id
    WHERE links.asset_id = members.asset_id
      AND links.identity_eligible = TRUE
      AND links.relationship <> 'display_fallback'
      AND reads.vehicle_image_status = 'ready'
      AND reads.vehicle_image_path = links.source_path_snapshot
      AND reads.vehicle_image_source_kind = links.source_kind
      AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
      AND reads.review_status <> 'rejected'
      AND UPPER(REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g')) <> ''
  ) <= 1;

CREATE OR REPLACE FUNCTION public.validate_vehicle_reid_v2_profile_merge()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status <> 'current' THEN
    RAISE EXCEPTION 'ReID v2 profile merge history must begin current'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_profile_merge_initial_state';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.vehicle_reid_v2_profile_merges merges
    WHERE merges.status = 'current'
      AND (merges.target_profile_id = NEW.source_profile_id
       OR merges.source_profile_id = NEW.target_profile_id)
  ) THEN
    RAISE EXCEPTION 'ReID profile merge chains are not permitted'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_profile_merge_no_chain';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.vehicle_reid_v2_pair_reviews reviews
    JOIN public.vehicle_reid_v2_exact_profile_members low_member
      ON low_member.derivative_id = reviews.derivative_id_low
    JOIN public.vehicle_reid_v2_exact_profile_members high_member
      ON high_member.derivative_id = reviews.derivative_id_high
    LEFT JOIN public.vehicle_reid_v2_current_profile_merges low_existing_merge
      ON low_existing_merge.source_profile_id = low_member.profile_id
    LEFT JOIN public.vehicle_reid_v2_current_profile_merges high_existing_merge
      ON high_existing_merge.source_profile_id = high_member.profile_id
    WHERE reviews.id = NEW.pair_review_id
      AND reviews.revision = NEW.pair_review_revision
      AND reviews.label = 'same_vehicle'
      AND (
        (COALESCE(low_existing_merge.target_profile_id, low_member.profile_id)
            = NEW.source_profile_id
          AND COALESCE(high_existing_merge.target_profile_id, high_member.profile_id)
            = NEW.target_profile_id)
        OR (COALESCE(low_existing_merge.target_profile_id, low_member.profile_id)
            = NEW.target_profile_id
          AND COALESCE(high_existing_merge.target_profile_id, high_member.profile_id)
            = NEW.source_profile_id)
      )
      AND reviews.source_sha256_low = low_member.crop_content_sha256
      AND reviews.source_sha256_high = high_member.crop_content_sha256
      AND reviews.embedding_id_low = low_member.embedding_id
      AND reviews.embedding_id_high = high_member.embedding_id
      AND reviews.embedding_model = low_member.embedding_model
      AND reviews.embedding_model = high_member.embedding_model
      AND reviews.algorithm_version = low_member.embedding_algorithm_version
      AND reviews.algorithm_version = high_member.embedding_algorithm_version
      AND EXISTS (
        SELECT 1
        FROM public.vehicle_reid_v2_current_profile_members current_members
        WHERE current_members.canonical_profile_id = NEW.source_profile_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.vehicle_reid_v2_current_profile_members current_members
        WHERE current_members.canonical_profile_id = NEW.target_profile_id
      )
  ) THEN
    RAISE EXCEPTION 'ReID profile merge requires an exact-current audited Same review'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_profile_merge_same_contract';
  END IF;

  IF (
    SELECT COUNT(DISTINCT anchors.normalized_plate)
    FROM public.vehicle_reid_v2_profile_plate_anchors anchors
    JOIN public.plate_reads evidence ON evidence.id = anchors.evidence_read_id
    WHERE anchors.status = 'current'
      AND anchors.profile_id IN (NEW.source_profile_id, NEW.target_profile_id)
      AND UPPER(REGEXP_REPLACE(evidence.plate_number, '[^A-Za-z0-9]', '', 'g'))
            = anchors.normalized_plate
      AND evidence.review_status = anchors.plate_review_status
      AND evidence.review_revision = anchors.plate_review_revision
      AND evidence.applied_alias_id IS NOT DISTINCT FROM anchors.applied_alias_id
      AND anchors.plate_review_id IS NOT DISTINCT FROM (
        SELECT reviews.id
        FROM public.plate_read_reviews reviews
        WHERE reviews.read_id = anchors.evidence_read_id
        ORDER BY reviews.created_at DESC, reviews.id DESC
        LIMIT 1
      )
  ) > 1 THEN
    RAISE EXCEPTION 'ReID profiles with clearly different reviewed plates cannot merge'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_profile_merge_plate_conflict';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_reid_v2_profile_merges_validate
  ON public.vehicle_reid_v2_profile_merges;
CREATE TRIGGER vehicle_reid_v2_profile_merges_validate
BEFORE INSERT ON public.vehicle_reid_v2_profile_merges
FOR EACH ROW EXECUTE FUNCTION public.validate_vehicle_reid_v2_profile_merge();

CREATE OR REPLACE FUNCTION public.guard_vehicle_reid_v2_profile_merge_history()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ReID v2 profile merge history cannot be deleted'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_profile_merge_history_immutable';
  END IF;
  IF NOT (
    OLD.status = 'current' AND NEW.status = 'withdrawn'
    AND (TO_JSONB(NEW) - ARRAY[
      'status','ended_by_user_id','ended_by_username',
      'ended_by_display_name','end_reason','ended_at'
    ]) = (TO_JSONB(OLD) - ARRAY[
      'status','ended_by_user_id','ended_by_username',
      'ended_by_display_name','end_reason','ended_at'
    ])
  ) THEN
    RAISE EXCEPTION 'ReID v2 profile merge history permits only one audited withdrawal'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_profile_merge_withdrawal_only';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_reid_v2_profile_merges_history_guard
  ON public.vehicle_reid_v2_profile_merges;
CREATE TRIGGER vehicle_reid_v2_profile_merges_history_guard
BEFORE UPDATE OR DELETE ON public.vehicle_reid_v2_profile_merges
FOR EACH ROW EXECUTE FUNCTION public.guard_vehicle_reid_v2_profile_merge_history();

CREATE OR REPLACE VIEW public.vehicle_reid_v2_current_profile_merges AS
SELECT merges.*
FROM public.vehicle_reid_v2_profile_merges merges
JOIN public.vehicle_reid_v2_pair_reviews reviews
  ON reviews.id = merges.pair_review_id
 AND reviews.revision = merges.pair_review_revision
 AND reviews.label = 'same_vehicle'
WHERE EXISTS (
  SELECT 1
  FROM public.vehicle_reid_v2_exact_profile_members low_member
  JOIN public.vehicle_reid_v2_exact_profile_members high_member ON TRUE
  LEFT JOIN public.vehicle_reid_v2_profile_merges low_existing_merge
    ON low_existing_merge.source_profile_id = low_member.profile_id
   AND low_existing_merge.status = 'current'
   AND low_existing_merge.id <> merges.id
  LEFT JOIN public.vehicle_reid_v2_profile_merges high_existing_merge
    ON high_existing_merge.source_profile_id = high_member.profile_id
   AND high_existing_merge.status = 'current'
   AND high_existing_merge.id <> merges.id
  WHERE low_member.derivative_id = reviews.derivative_id_low
    AND high_member.derivative_id = reviews.derivative_id_high
    AND reviews.source_sha256_low = low_member.crop_content_sha256
    AND reviews.source_sha256_high = high_member.crop_content_sha256
    AND reviews.embedding_id_low = low_member.embedding_id
    AND reviews.embedding_id_high = high_member.embedding_id
    AND reviews.embedding_model = low_member.embedding_model
    AND reviews.embedding_model = high_member.embedding_model
    AND reviews.algorithm_version = low_member.embedding_algorithm_version
    AND reviews.algorithm_version = high_member.embedding_algorithm_version
    AND (
      (COALESCE(low_existing_merge.target_profile_id, low_member.profile_id)
          = merges.source_profile_id
        AND COALESCE(high_existing_merge.target_profile_id, high_member.profile_id)
          = merges.target_profile_id)
      OR (COALESCE(low_existing_merge.target_profile_id, low_member.profile_id)
          = merges.target_profile_id
        AND COALESCE(high_existing_merge.target_profile_id, high_member.profile_id)
          = merges.source_profile_id)
    )
)
AND merges.status = 'current'
AND (
  SELECT COUNT(DISTINCT anchors.normalized_plate)
  FROM public.vehicle_reid_v2_profile_plate_anchors anchors
  JOIN public.plate_reads evidence ON evidence.id = anchors.evidence_read_id
  WHERE anchors.status = 'current'
    AND anchors.profile_id IN (merges.source_profile_id, merges.target_profile_id)
    AND UPPER(REGEXP_REPLACE(evidence.plate_number, '[^A-Za-z0-9]', '', 'g'))
          = anchors.normalized_plate
    AND evidence.review_status = anchors.plate_review_status
    AND evidence.review_revision = anchors.plate_review_revision
    AND evidence.applied_alias_id IS NOT DISTINCT FROM anchors.applied_alias_id
    AND anchors.plate_review_id IS NOT DISTINCT FROM (
      SELECT latest_reviews.id
      FROM public.plate_read_reviews latest_reviews
      WHERE latest_reviews.read_id = anchors.evidence_read_id
      ORDER BY latest_reviews.created_at DESC, latest_reviews.id DESC
      LIMIT 1
    )
) <= 1;

-- Reviewed plate anchors also remain historical rows.  Only the exact latest
-- plate-review contract is current, and merge aliases resolve to one stable

CREATE OR REPLACE VIEW public.vehicle_reid_v2_current_plate_anchors AS
SELECT anchors.*,
       COALESCE(merges.target_profile_id, anchors.profile_id)
         AS canonical_profile_id
FROM public.vehicle_reid_v2_profile_plate_anchors anchors
JOIN public.plate_reads evidence ON evidence.id = anchors.evidence_read_id
LEFT JOIN public.vehicle_reid_v2_current_profile_merges merges
  ON merges.source_profile_id = anchors.profile_id
JOIN public.vehicle_reid_v2_profiles profiles
  ON profiles.id = COALESCE(merges.target_profile_id, anchors.profile_id)
WHERE anchors.status = 'current'
  AND profiles.status IN ('active','provisional')
  AND UPPER(REGEXP_REPLACE(evidence.plate_number, '[^A-Za-z0-9]', '', 'g'))
        = anchors.normalized_plate
  AND evidence.review_status = anchors.plate_review_status
  AND evidence.review_revision = anchors.plate_review_revision
  AND evidence.applied_alias_id IS NOT DISTINCT FROM anchors.applied_alias_id
  AND anchors.plate_review_id IS NOT DISTINCT FROM (
    SELECT reviews.id
    FROM public.plate_read_reviews reviews
    WHERE reviews.read_id = anchors.evidence_read_id
    ORDER BY reviews.created_at DESC, reviews.id DESC
    LIMIT 1
  );

CREATE OR REPLACE VIEW public.vehicle_reid_v2_current_profile_members AS
WITH canonical_members AS (
  SELECT members.*,
         COALESCE(merges.target_profile_id, members.profile_id)
           AS canonical_profile_id
  FROM public.vehicle_reid_v2_exact_profile_members members
  LEFT JOIN public.vehicle_reid_v2_current_profile_merges merges
    ON merges.source_profile_id = members.profile_id
)
SELECT members.*
FROM canonical_members members
WHERE NOT EXISTS (
  SELECT 1
  FROM public.vehicle_image_asset_reads links
  JOIN public.plate_reads reads ON reads.id = links.read_id
  JOIN public.vehicle_reid_v2_current_plate_anchors anchors
    ON anchors.normalized_plate = UPPER(
      REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g')
    )
  WHERE links.asset_id = members.asset_id
    AND links.identity_eligible = TRUE
    AND links.relationship <> 'display_fallback'
    AND reads.vehicle_image_status = 'ready'
    AND reads.vehicle_image_path = links.source_path_snapshot
    AND reads.vehicle_image_source_kind = links.source_kind
    AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
    AND reads.review_status IN ('confirmed','corrected','alias_resolved')
    AND anchors.canonical_profile_id <> members.canonical_profile_id
)
AND NOT EXISTS (
  SELECT 1
  FROM public.vehicle_reid_v2_pair_reviews reviews
  JOIN public.vehicle_reid_v2_exact_profile_members low_member
    ON low_member.derivative_id = reviews.derivative_id_low
  JOIN public.vehicle_reid_v2_exact_profile_members high_member
    ON high_member.derivative_id = reviews.derivative_id_high
  LEFT JOIN public.vehicle_reid_v2_current_profile_merges low_merges
    ON low_merges.source_profile_id = low_member.profile_id
  LEFT JOIN public.vehicle_reid_v2_current_profile_merges high_merges
    ON high_merges.source_profile_id = high_member.profile_id
  WHERE reviews.label IN ('different_vehicle','unsure')
    AND reviews.embedding_model = low_member.embedding_model
    AND reviews.embedding_model = high_member.embedding_model
    AND reviews.algorithm_version = low_member.embedding_algorithm_version
    AND reviews.algorithm_version = high_member.embedding_algorithm_version
    AND reviews.source_sha256_low = low_member.crop_content_sha256
    AND reviews.source_sha256_high = high_member.crop_content_sha256
    AND reviews.embedding_id_low = low_member.embedding_id
    AND reviews.embedding_id_high = high_member.embedding_id
    AND COALESCE(low_merges.target_profile_id, low_member.profile_id)
          = members.canonical_profile_id
    AND COALESCE(high_merges.target_profile_id, high_member.profile_id)
          = members.canonical_profile_id
);

-- Exact-plate assignments now bind a durable current plate anchor.  Frozen

-- assignments may use the same current anchor without fabricating a frozen
-- disposition fingerprint.
--

-- from a sealed row whose source/review contract later changed.  Preserve the
-- sealed history and enforce one exact-current assignment per read under a
-- per-read transaction lock instead.
DROP INDEX IF EXISTS public.idx_reid_v2_assignment_one_active_read;
CREATE INDEX IF NOT EXISTS idx_reid_v2_assignment_active_read_history
  ON public.vehicle_reid_v2_read_assignments (read_id, id DESC)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION public.validate_vehicle_reid_v2_assignment_contract()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'active' AND NOT EXISTS (
    SELECT 1
    FROM public.vehicle_reid_v2_profiles profiles
    LEFT JOIN public.vehicle_reid_v2_profile_members members
      ON members.id = NEW.profile_member_id
     AND members.profile_id = NEW.profile_id
     AND members.status = 'current'
    WHERE profiles.id = NEW.profile_id
      AND profiles.revision = NEW.profile_revision
      AND profiles.status IN ('active','provisional')
      AND (
        (NEW.assignment_basis = 'exact_effective_plate')
        OR (NEW.assignment_basis IN ('canonical_image','shared_asset','human_same')
          AND members.membership_basis = NEW.profile_membership_basis)
      )
  ) THEN
    RAISE EXCEPTION 'ReID v2 assignment does not bind the current profile/member revision and evidence basis'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_assignment_profile_contract';
  END IF;

  IF NEW.status = 'active'
    AND NEW.assignment_basis IN ('canonical_image','shared_asset','human_same')
    AND NOT EXISTS (
      SELECT 1
      FROM public.vehicle_reid_v2_profile_members members
      JOIN public.vehicle_image_asset_reads links
        ON links.asset_id = members.asset_id
       AND links.read_id = NEW.read_id
      JOIN public.plate_reads reads ON reads.id = links.read_id
      WHERE members.id = NEW.profile_member_id
        AND members.profile_id = NEW.profile_id
        AND members.status = 'current'
        AND members.asset_id = NEW.asset_id
        AND members.derivative_id = NEW.derivative_id
        AND members.embedding_id = NEW.embedding_id
        AND links.identity_eligible = TRUE
        AND links.relationship <> 'display_fallback'
        AND links.source_kind IS NOT DISTINCT FROM NEW.source_kind
        AND links.relationship IS NOT DISTINCT FROM NEW.source_relationship
        AND links.source_path_snapshot IS NOT DISTINCT FROM NEW.source_path_snapshot
        AND links.source_updated_at IS NOT DISTINCT FROM NEW.source_updated_at
        AND links.updated_at IS NOT DISTINCT FROM NEW.source_link_updated_at
        AND reads.vehicle_image_status = 'ready'
        AND reads.vehicle_image_path = links.source_path_snapshot
        AND reads.vehicle_image_source_kind = links.source_kind
        AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
    ) THEN
    RAISE EXCEPTION 'ReID v2 image assignment is not an exact current member/source-link contract'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_assignment_member_contract';
  END IF;

  IF NEW.status = 'active'
    AND NEW.assignment_basis = 'exact_effective_plate'
    AND NOT EXISTS (
      SELECT 1 FROM public.plate_reads reads
      WHERE reads.id = NEW.read_id
        AND UPPER(REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g'))
              = NEW.normalized_effective_plate
        AND reads.review_status = NEW.plate_review_status
        AND reads.review_revision = NEW.plate_review_revision
        AND reads.applied_alias_id IS NOT DISTINCT FROM NEW.applied_alias_id
        AND NEW.plate_review_id IS NOT DISTINCT FROM (
          SELECT reviews.id
          FROM public.plate_read_reviews reviews
          WHERE reviews.read_id = NEW.read_id
          ORDER BY reviews.created_at DESC, reviews.id DESC
          LIMIT 1
        )
    ) THEN
    RAISE EXCEPTION 'ReID v2 exact-plate assignment is not current reviewed plate evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_assignment_plate_contract';
  END IF;

  IF NEW.status = 'active'
    AND NEW.assignment_basis = 'exact_effective_plate'
    AND NOT EXISTS (
      SELECT 1
      FROM public.vehicle_reid_v2_profile_plate_anchors anchors
      WHERE anchors.profile_id = NEW.profile_id
        AND anchors.status = 'current'
        AND anchors.normalized_plate = NEW.normalized_effective_plate
    ) THEN
    RAISE EXCEPTION 'ReID v2 exact-plate assignment requires a current profile plate anchor'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_assignment_plate_profile_contract';
  END IF;


  IF NEW.status = 'active' THEN
    PERFORM pg_advisory_xact_lock(hashtext(
      'vehicle_reid_v2_read_assignment:' || NEW.read_id::TEXT
    ));
    -- Most Stage 2 materializations start from an empty authority table.  Do
    -- the cheap indexed history probe first so those thousands of inserts do
    -- not repeatedly expand the exact-current consumer view.  If history is
    -- present, retain the full fail-closed current-contract validation.
    IF EXISTS (
      SELECT 1
      FROM public.vehicle_reid_v2_read_assignments prior
      WHERE prior.read_id = NEW.read_id
        AND prior.status = 'active'
        AND prior.id IS DISTINCT FROM NEW.id
    ) THEN
      IF EXISTS (
        SELECT 1
        FROM public.vehicle_reid_v2_current_read_assignments existing
        WHERE existing.read_id = NEW.read_id
          AND existing.id IS DISTINCT FROM NEW.id
      ) THEN
        RAISE EXCEPTION 'ReID v2 read already has an exact-current assignment'
          USING ERRCODE = '23514',
                CONSTRAINT = 'vehicle_reid_v2_assignment_one_exact_current_read';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Every primary consumer reads this view rather than trusting status='active'.
-- It revalidates the exact current plate review or canonical source-link/member
-- contract and resolves a current merge alias without mutating history.
CREATE OR REPLACE VIEW public.vehicle_reid_v2_current_read_assignments AS
SELECT assignments.*,
       COALESCE(merges.target_profile_id, assignments.profile_id)
         AS canonical_profile_id
FROM public.vehicle_reid_v2_read_assignments assignments
JOIN public.vehicle_reid_v2_profiles source_profiles
  ON source_profiles.id = assignments.profile_id
LEFT JOIN public.vehicle_reid_v2_current_profile_merges merges
  ON merges.source_profile_id = assignments.profile_id
JOIN public.vehicle_reid_v2_profiles canonical_profiles
  ON canonical_profiles.id = COALESCE(merges.target_profile_id, assignments.profile_id)
JOIN public.plate_reads reads ON reads.id = assignments.read_id
WHERE assignments.status = 'active'
  AND source_profiles.status IN ('active','provisional')
  AND canonical_profiles.status IN ('active','provisional')
  AND source_profiles.revision = assignments.profile_revision
  AND (
    (
      assignments.assignment_basis = 'exact_effective_plate'
      AND UPPER(REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g'))
            = assignments.normalized_effective_plate
      AND reads.review_status = assignments.plate_review_status
      AND reads.review_revision = assignments.plate_review_revision
      AND reads.applied_alias_id IS NOT DISTINCT FROM assignments.applied_alias_id
      AND assignments.plate_review_id IS NOT DISTINCT FROM (
        SELECT reviews.id
        FROM public.plate_read_reviews reviews
        WHERE reviews.read_id = assignments.read_id
        ORDER BY reviews.created_at DESC, reviews.id DESC
        LIMIT 1
      )
      AND EXISTS (
        SELECT 1
        FROM public.vehicle_reid_v2_current_plate_anchors anchors
        WHERE anchors.canonical_profile_id =
                COALESCE(merges.target_profile_id, assignments.profile_id)
          AND anchors.normalized_plate = assignments.normalized_effective_plate
      )
    )
    OR (
      assignments.assignment_basis IN ('canonical_image','shared_asset','human_same')
      AND EXISTS (
        SELECT 1
        FROM public.vehicle_reid_v2_current_profile_members members
        JOIN public.vehicle_image_asset_reads links
          ON links.asset_id = members.asset_id
         AND links.read_id = assignments.read_id
        WHERE members.id = assignments.profile_member_id
          AND members.profile_id = assignments.profile_id
          AND members.asset_id = assignments.asset_id
          AND members.derivative_id = assignments.derivative_id
          AND members.embedding_id = assignments.embedding_id
          AND members.membership_basis = assignments.profile_membership_basis
          AND members.canonical_profile_id =
                COALESCE(merges.target_profile_id, assignments.profile_id)
          AND links.identity_eligible = TRUE
          AND links.relationship <> 'display_fallback'
          AND links.source_kind IS NOT DISTINCT FROM assignments.source_kind
          AND links.relationship IS NOT DISTINCT FROM assignments.source_relationship
          AND links.source_path_snapshot IS NOT DISTINCT FROM assignments.source_path_snapshot
          AND links.source_updated_at IS NOT DISTINCT FROM assignments.source_updated_at
          AND links.updated_at IS NOT DISTINCT FROM assignments.source_link_updated_at
          AND reads.vehicle_image_status = 'ready'
          AND reads.vehicle_image_path = links.source_path_snapshot
          AND reads.vehicle_image_source_kind = links.source_kind
          AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
      )
    )
  );

CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_live_discovery_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  forward_cursor_read_id INTEGER NOT NULL DEFAULT 0 CHECK (
    forward_cursor_read_id >= 0
  ),
  revisit_cursor_read_id INTEGER NOT NULL DEFAULT 0 CHECK (
    revisit_cursor_read_id >= 0
  ),
  revisit_upper_read_id INTEGER NOT NULL DEFAULT 0 CHECK (
    revisit_upper_read_id >= 0
    AND revisit_cursor_read_id <= revisit_upper_read_id
  ),
  revisit_epoch BIGINT NOT NULL DEFAULT 0 CHECK (revisit_epoch >= 0),
  forward_windows_since_revisit SMALLINT NOT NULL DEFAULT 0 CHECK (
    forward_windows_since_revisit BETWEEN 0 AND 8
  ),
  last_scanned_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (revisit_upper_read_id <= forward_cursor_read_id)
);
CREATE OR REPLACE FUNCTION public.validate_vehicle_reid_v2_live_discovery_state()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'The ReID v2 live discovery singleton cannot be deleted'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_live_discovery_singleton_immutable';
  END IF;
  IF NEW.forward_cursor_read_id < OLD.forward_cursor_read_id THEN
    RAISE EXCEPTION 'The ReID v2 live forward cursor cannot rewind'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_live_discovery_forward_monotonic';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'ReID v2 live discovery updates require the next revision'
      USING ERRCODE = '23514',
            CONSTRAINT = 'vehicle_reid_v2_live_discovery_revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_reid_v2_live_discovery_validate
  ON public.vehicle_reid_v2_live_discovery_state;
CREATE TRIGGER vehicle_reid_v2_live_discovery_validate
BEFORE UPDATE OR DELETE ON public.vehicle_reid_v2_live_discovery_state
FOR EACH ROW EXECUTE FUNCTION public.validate_vehicle_reid_v2_live_discovery_state();

INSERT INTO public.vehicle_reid_v2_live_discovery_state(singleton)
VALUES (TRUE) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_asset_analysis_jobs (
  derivative_id BIGINT PRIMARY KEY REFERENCES public.vehicle_image_derivatives(id) ON DELETE CASCADE,
  status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed')),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  claim_token UUID,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error_code VARCHAR(100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vehicle_asset_analysis_pending
  ON public.vehicle_asset_analysis_jobs(next_attempt_at, derivative_id)
  WHERE status <> 'ready' AND attempt_count < 3;


-- Read-facing attributes project exact-current canonical crops.
DO $attribute_upgrade$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'vehicle_attribute_observations' AND c.relkind = 'r') THEN
    DROP TABLE public.vehicle_attribute_observations;
  END IF;
END
$attribute_upgrade$;
CREATE OR REPLACE VIEW public.vehicle_attribute_observations AS
SELECT observations.id, links.read_id, observations.attribute_key,
       observations.provider, observations.model_version, observations.status,
       observations.attribute_value, observations.confidence, observations.raw_result,
       observations.created_at AS evaluated_at
FROM public.vehicle_image_asset_reads links
JOIN public.plate_reads reads ON reads.id = links.read_id
JOIN public.vehicle_image_assets assets ON assets.id = links.asset_id
JOIN public.vehicle_image_derivatives derivatives ON derivatives.asset_id = assets.id
  AND derivatives.source_sha256 = assets.content_sha256
  AND derivatives.derivative_kind = 'vehicle_crop'
  AND derivatives.algorithm_version = 'canonical-overview-detection-box-v1'
JOIN public.vehicle_asset_attribute_observations observations
  ON observations.derivative_id = derivatives.id
 AND observations.source_sha256 = derivatives.content_sha256
 AND observations.algorithm_version = 'canonical-overview-crop-attributes-v1'
WHERE links.identity_eligible = TRUE AND links.relationship <> 'display_fallback'
  AND reads.vehicle_image_status = 'ready' AND reads.vehicle_image_path = links.source_path_snapshot
  AND reads.vehicle_image_source_kind = links.source_kind
  AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at;

CREATE OR REPLACE VIEW public.vehicle_direction_sources AS
SELECT DISTINCT ON (links.read_id)
  links.read_id, derivatives.id AS derivative_id, embeddings.id AS embedding_id,
  derivatives.storage_path AS derived_path, derivatives.content_sha256 AS source_sha256,
  embeddings.embedding AS vehicle_embedding,
  'canonical-crop-direction-v2'::text AS embedding_model,
  'vehicle_crop'::text AS asset_type,
  embeddings.algorithm_version,
  'ready'::text AS status
FROM public.vehicle_image_asset_reads links
JOIN public.plate_reads reads ON reads.id = links.read_id
JOIN public.vehicle_image_assets assets ON assets.id = links.asset_id
JOIN public.vehicle_image_derivatives derivatives
  ON derivatives.asset_id = assets.id
 AND derivatives.source_sha256 = assets.content_sha256
 AND derivatives.derivative_kind = 'vehicle_crop'
 AND derivatives.algorithm_version = 'canonical-overview-detection-box-v1'
JOIN public.vehicle_asset_embeddings embeddings
  ON embeddings.derivative_id = derivatives.id
 AND embeddings.source_sha256 = derivatives.content_sha256
 AND embeddings.model_name = 'vehicle-reid-0001-ir-fp16-v1'
 AND embeddings.algorithm_version = 'canonical-overview-crop-embedding-v1'
WHERE links.identity_eligible = TRUE AND links.relationship <> 'display_fallback'
  AND reads.vehicle_image_status = 'ready'
  AND reads.vehicle_image_path = links.source_path_snapshot
  AND reads.vehicle_image_source_kind = links.source_kind
  AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
ORDER BY links.read_id, derivatives.id DESC, embeddings.id DESC;


ALTER TABLE public.vehicle_orientation_labels
  ADD COLUMN IF NOT EXISTS source_embedding_id BIGINT REFERENCES public.vehicle_asset_embeddings(id) ON DELETE CASCADE;
ALTER TABLE public.vehicle_direction_observations
  ADD COLUMN IF NOT EXISTS source_embedding_id BIGINT REFERENCES public.vehicle_asset_embeddings(id) ON DELETE CASCADE;

-- Reviewed examples and predictions belong to the exact current canonical crop.
CREATE OR REPLACE VIEW public.current_vehicle_orientation_labels AS
SELECT labels.* FROM public.vehicle_orientation_labels labels
JOIN public.vehicle_direction_sources source
  ON source.read_id = labels.read_id AND source.embedding_id = labels.source_embedding_id
WHERE labels.embedding_model = 'canonical-crop-direction-v2';

CREATE OR REPLACE VIEW public.current_vehicle_direction_observations AS
SELECT observations.* FROM public.vehicle_direction_observations observations
WHERE observations.classifier_version IN ('blue-iris-zone-crossing-v1','blue-iris-zone-crossing-v2-primary','axis-lpv-direction-v1')
   OR (observations.classifier_version = 'canonical-crop-orientation-knn-v2'
     AND EXISTS (SELECT 1 FROM public.vehicle_direction_sources source
       WHERE source.read_id = observations.read_id
         AND source.embedding_id = observations.source_embedding_id));

-- Retire only derived predictions/calibration that cannot identify their crop.
DELETE FROM public.vehicle_direction_observations
  WHERE classifier_version IN ('vehicle-reid-orientation-knn-v1','canonical-crop-orientation-knn-v2') AND source_embedding_id IS NULL;
DELETE FROM public.vehicle_orientation_labels WHERE source_embedding_id IS NULL;

INSERT INTO public.schema_migrations(version, description) VALUES
  ('2026092701_native_reid', 'Native canonical vehicle identity and automatic image processing')
ON CONFLICT (version) DO NOTHING;
