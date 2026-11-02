-- migration: 2026081602_vehicle_reid_v2_profile_candidates
-- ReID v2 profile candidates are immutable shadow snapshots built only from
-- exact effective/corrected plate agreement and audited Same-vehicle labels.
-- They preserve explicit evidence and do not infer a score cutoff,
-- or create a vehicle assignment. Conflicts fail closed into separate evidence.
CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_profile_candidate_runs (
  id BIGSERIAL PRIMARY KEY,
  snapshot_fingerprint CHAR(64) NOT NULL UNIQUE CHECK (
    snapshot_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  status VARCHAR(16) NOT NULL DEFAULT 'completed' CHECK (status = 'completed'),
  algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(algorithm_version), '') IS NOT NULL
  ),
  embedding_model VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(embedding_model), '') IS NOT NULL
  ),
  embedding_algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(embedding_algorithm_version), '') IS NOT NULL
  ),
  frozen_max_derivative_id BIGINT NOT NULL CHECK (frozen_max_derivative_id >= 0),
  total_sources INTEGER NOT NULL CHECK (total_sources >= 0),
  exact_plate_eligible_sources INTEGER NOT NULL CHECK (
    exact_plate_eligible_sources BETWEEN 0 AND total_sources
  ),
  human_same_reviews INTEGER NOT NULL CHECK (human_same_reviews >= 0),
  human_different_reviews INTEGER NOT NULL CHECK (human_different_reviews >= 0),
  candidate_profiles INTEGER NOT NULL CHECK (candidate_profiles >= 0),
  candidate_members INTEGER NOT NULL CHECK (candidate_members >= 0),
  conflicted_components INTEGER NOT NULL CHECK (conflicted_components >= 0),
  conflicted_members INTEGER NOT NULL CHECK (conflicted_members >= 0),
  ungrouped_sources INTEGER NOT NULL CHECK (ungrouped_sources >= 0),
  -- Immutable actor snapshot scalar; not a live FK that could rewrite history.
  actor_user_id BIGINT,
  actor_username VARCHAR(64) NOT NULL CHECK (
    NULLIF(BTRIM(actor_username), '') IS NOT NULL
  ),
  actor_display_name VARCHAR(120) NOT NULL CHECK (
    NULLIF(BTRIM(actor_display_name), '') IS NOT NULL
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (candidate_members + conflicted_members + ungrouped_sources = total_sources)
);

CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_profile_candidates (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL
    REFERENCES public.vehicle_reid_v2_profile_candidate_runs(id) ON DELETE RESTRICT,
  candidate_key CHAR(64) NOT NULL CHECK (candidate_key ~ '^[0-9a-f]{64}$'),
  status VARCHAR(16) NOT NULL DEFAULT 'shadow' CHECK (status = 'shadow'),
  evidence_basis VARCHAR(32) NOT NULL CHECK (
    evidence_basis IN ('exact_effective_plate','human_same','mixed')
  ),
  representative_derivative_id BIGINT NOT NULL CHECK (representative_derivative_id > 0),
  member_count INTEGER NOT NULL CHECK (member_count >= 2),
  anchor_plates JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    JSONB_TYPEOF(anchor_plates) = 'array'
  ),
  camera_names JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    JSONB_TYPEOF(camera_names) = 'array'
  ),
  overview_contexts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    JSONB_TYPEOF(overview_contexts) = 'array'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, candidate_key)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_reid_v2_profile_candidates_run
  ON public.vehicle_reid_v2_profile_candidates (run_id, member_count DESC, id);

CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_profile_candidate_members (
  run_id BIGINT NOT NULL
    REFERENCES public.vehicle_reid_v2_profile_candidate_runs(id) ON DELETE RESTRICT,
  profile_candidate_id BIGINT NOT NULL
    REFERENCES public.vehicle_reid_v2_profile_candidates(id) ON DELETE RESTRICT,
  derivative_id BIGINT NOT NULL CHECK (derivative_id > 0),
  embedding_id BIGINT NOT NULL CHECK (embedding_id > 0),
  source_sha256 CHAR(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_basis VARCHAR(32) NOT NULL CHECK (
    evidence_basis IN ('exact_effective_plate','human_same','mixed')
  ),
  effective_plates JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    JSONB_TYPEOF(effective_plates) = 'array'
  ),
  read_id INTEGER NOT NULL CHECK (read_id > 0),
  camera_name VARCHAR(120),
  overview_context VARCHAR(12) CHECK (overview_context IN ('street','entry')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_candidate_id, derivative_id),
  UNIQUE (run_id, derivative_id)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_reid_v2_profile_candidate_members_derivative
  ON public.vehicle_reid_v2_profile_candidate_members (derivative_id, run_id DESC);

CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_profile_candidate_conflicts (
  run_id BIGINT NOT NULL
    REFERENCES public.vehicle_reid_v2_profile_candidate_runs(id) ON DELETE RESTRICT,
  conflict_key CHAR(64) NOT NULL CHECK (conflict_key ~ '^[0-9a-f]{64}$'),
  reason VARCHAR(40) NOT NULL CHECK (
    reason IN ('human_different','dissimilar_effective_plates','mixed')
  ),
  derivative_ids JSONB NOT NULL CHECK (JSONB_TYPEOF(derivative_ids) = 'array'),
  effective_plates JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    JSONB_TYPEOF(effective_plates) = 'array'
  ),
  review_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, conflict_key)
);

CREATE OR REPLACE FUNCTION public.prevent_vehicle_reid_v2_profile_candidate_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME <> 'vehicle_reid_v2_profile_candidate_runs' AND EXISTS (
      SELECT 1
      FROM public.vehicle_reid_v2_profile_candidate_runs runs
      WHERE runs.id = NEW.run_id
        AND runs.xmin::text = pg_current_xact_id()::text
    ) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'ReID v2 profile candidate snapshots are immutable';
END;
$$;

DROP TRIGGER IF EXISTS vehicle_reid_v2_profile_candidate_runs_immutable
  ON public.vehicle_reid_v2_profile_candidate_runs;
CREATE TRIGGER vehicle_reid_v2_profile_candidate_runs_immutable
BEFORE UPDATE OR DELETE ON public.vehicle_reid_v2_profile_candidate_runs
FOR EACH ROW EXECUTE FUNCTION public.prevent_vehicle_reid_v2_profile_candidate_mutation();

DROP TRIGGER IF EXISTS vehicle_reid_v2_profile_candidates_immutable
  ON public.vehicle_reid_v2_profile_candidates;
CREATE TRIGGER vehicle_reid_v2_profile_candidates_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.vehicle_reid_v2_profile_candidates
FOR EACH ROW EXECUTE FUNCTION public.prevent_vehicle_reid_v2_profile_candidate_mutation();

DROP TRIGGER IF EXISTS vehicle_reid_v2_profile_candidate_members_immutable
  ON public.vehicle_reid_v2_profile_candidate_members;
CREATE TRIGGER vehicle_reid_v2_profile_candidate_members_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.vehicle_reid_v2_profile_candidate_members
FOR EACH ROW EXECUTE FUNCTION public.prevent_vehicle_reid_v2_profile_candidate_mutation();

DROP TRIGGER IF EXISTS vehicle_reid_v2_profile_candidate_conflicts_immutable
  ON public.vehicle_reid_v2_profile_candidate_conflicts;
CREATE TRIGGER vehicle_reid_v2_profile_candidate_conflicts_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.vehicle_reid_v2_profile_candidate_conflicts
FOR EACH ROW EXECUTE FUNCTION public.prevent_vehicle_reid_v2_profile_candidate_mutation();

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081602_vehicle_reid_v2_profile_candidates','Add immutable evidence-backed ReID v2 shadow profile candidate snapshots using exact effective plates and audited Same labels, with conflicts retained separately and no threshold, cluster, or assignment write.')
ON CONFLICT(version) DO NOTHING;
