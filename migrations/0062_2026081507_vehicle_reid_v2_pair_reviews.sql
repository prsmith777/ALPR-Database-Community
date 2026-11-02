-- migration: 2026081507_vehicle_reid_v2_pair_reviews
-- Human ReID v2 labels belong to an immutable canonical crop pair and exact
-- embedding contract. They are calibration evidence only: this migration
-- creates no profile, cluster, assignment, threshold, queue, or provider call.
CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_pair_reviews (
  id BIGSERIAL PRIMARY KEY,
  derivative_id_low BIGINT NOT NULL
    REFERENCES public.vehicle_image_derivatives(id) ON DELETE RESTRICT,
  derivative_id_high BIGINT NOT NULL
    REFERENCES public.vehicle_image_derivatives(id) ON DELETE RESTRICT,
  source_sha256_low CHAR(64) NOT NULL CHECK (
    source_sha256_low ~ '^[0-9a-f]{64}$'
  ),
  source_sha256_high CHAR(64) NOT NULL CHECK (
    source_sha256_high ~ '^[0-9a-f]{64}$'
  ),
  embedding_id_low BIGINT NOT NULL
    REFERENCES public.vehicle_asset_embeddings(id) ON DELETE RESTRICT,
  embedding_id_high BIGINT NOT NULL
    REFERENCES public.vehicle_asset_embeddings(id) ON DELETE RESTRICT,
  embedding_model VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(embedding_model), '') IS NOT NULL
  ),
  algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(algorithm_version), '') IS NOT NULL
  ),
  similarity_score DOUBLE PRECISION NOT NULL CHECK (
    similarity_score >= -1 AND similarity_score <= 1
  ),
  label VARCHAR(24) NOT NULL CHECK (
    label IN ('same_vehicle','different_vehicle','unsure')
  ),
  evidence_read_id_low INTEGER NOT NULL CHECK (evidence_read_id_low > 0),
  evidence_read_id_high INTEGER NOT NULL CHECK (evidence_read_id_high > 0),
  evidence_plate_low TEXT,
  evidence_plate_high TEXT,
  evidence_camera_low VARCHAR(120),
  evidence_camera_high VARCHAR(120),
  evidence_context_low VARCHAR(12) NOT NULL CHECK (
    evidence_context_low IN ('street','entry')
  ),
  evidence_context_high VARCHAR(12) NOT NULL CHECK (
    evidence_context_high IN ('street','entry')
  ),
  actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  actor_username VARCHAR(64) NOT NULL CHECK (
    NULLIF(BTRIM(actor_username), '') IS NOT NULL
  ),
  actor_display_name VARCHAR(120) NOT NULL CHECK (
    NULLIF(BTRIM(actor_display_name), '') IS NOT NULL
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (derivative_id_low < derivative_id_high),
  CHECK (embedding_id_low <> embedding_id_high),
  CHECK (evidence_plate_low IS NULL OR NULLIF(BTRIM(evidence_plate_low), '') IS NOT NULL),
  CHECK (evidence_plate_high IS NULL OR NULLIF(BTRIM(evidence_plate_high), '') IS NOT NULL),
  UNIQUE (derivative_id_low, derivative_id_high, embedding_model, algorithm_version)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_reid_v2_pair_reviews_contract_label
  ON public.vehicle_reid_v2_pair_reviews (
    embedding_model, algorithm_version, label, updated_at DESC, id DESC
  );
CREATE INDEX IF NOT EXISTS idx_vehicle_reid_v2_pair_reviews_high
  ON public.vehicle_reid_v2_pair_reviews (
    derivative_id_high, embedding_model, algorithm_version
  );

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081507_vehicle_reid_v2_pair_reviews','Add audited crop-owned ReID v2 Same, Different, and Unsure pair labels for human calibration without changing profiles or assignments.')
ON CONFLICT(version) DO NOTHING;
