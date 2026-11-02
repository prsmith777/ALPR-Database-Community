-- migration: 2026081601_vehicle_reid_v2_diverse_review_campaign
-- One operator-started campaign can collect a bounded, diversity-aware human
-- sample without recycling the vehicles used by earlier pair reviews. The
-- campaign is only a review-workload boundary; it never applies a ReID
-- threshold or changes a vehicle assignment.
CREATE TABLE IF NOT EXISTS public.vehicle_reid_v2_review_campaigns (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (
    status IN ('active','completed','cancelled')
  ),
  target_human_reviews INTEGER NOT NULL DEFAULT 500 CHECK (
    target_human_reviews BETWEEN 1 AND 500
  ),
  frozen_max_derivative_id BIGINT NOT NULL CHECK (
    frozen_max_derivative_id > 0
  ),
  embedding_model VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(embedding_model), '') IS NOT NULL
  ),
  algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(algorithm_version), '') IS NOT NULL
  ),
  actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  actor_username VARCHAR(64) NOT NULL CHECK (
    NULLIF(BTRIM(actor_username), '') IS NOT NULL
  ),
  actor_display_name VARCHAR(120) NOT NULL CHECK (
    NULLIF(BTRIM(actor_display_name), '') IS NOT NULL
  ),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'active' AND completed_at IS NULL AND cancelled_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_reid_v2_review_campaign_one_active
  ON public.vehicle_reid_v2_review_campaigns ((TRUE))
  WHERE status = 'active';

ALTER TABLE public.vehicle_reid_v2_pair_reviews
  ADD COLUMN IF NOT EXISTS campaign_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vehicle_reid_v2_pair_reviews_campaign_id_fkey'
  ) THEN
    ALTER TABLE public.vehicle_reid_v2_pair_reviews
      ADD CONSTRAINT vehicle_reid_v2_pair_reviews_campaign_id_fkey
      FOREIGN KEY (campaign_id)
      REFERENCES public.vehicle_reid_v2_review_campaigns(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vehicle_reid_v2_pair_reviews_campaign
  ON public.vehicle_reid_v2_pair_reviews (campaign_id, updated_at DESC, id DESC)
  WHERE campaign_id IS NOT NULL;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081601_vehicle_reid_v2_diverse_review_campaign','Add one explicit 500-review ReID v2 diversity campaign with frozen inventory and campaign-bound human labels; automatic plate evidence remains visibly separate and no identity threshold or assignment is applied.')
ON CONFLICT(version) DO NOTHING;
