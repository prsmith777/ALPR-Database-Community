-- migration: 2026072204_notification_shadow_review
-- Append-only administrator evidence for a specific disabled rule version and
-- exact shadow-test sample. Recording a review cannot enable or change a rule.
CREATE TABLE IF NOT EXISTS public.notification_rule_shadow_reviews (
    id BIGSERIAL PRIMARY KEY,
    rule_id BIGINT NOT NULL
        REFERENCES public.notification_rules(id) ON DELETE RESTRICT,
    rule_version INTEGER NOT NULL CHECK (rule_version > 0),
    reviewer_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    sample_count INTEGER NOT NULL CHECK (sample_count > 0),
    agreement_count INTEGER NOT NULL CHECK (agreement_count = sample_count),
    mismatch_count INTEGER NOT NULL DEFAULT 0 CHECK (mismatch_count = 0),
    report_fingerprint CHAR(64) NOT NULL
        CHECK (report_fingerprint ~ '^[0-9a-f]{64}$'),
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (rule_id, rule_version, report_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_notification_rule_shadow_reviews_activity
    ON public.notification_rule_shadow_reviews (rule_id, reviewed_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.prevent_notification_shadow_review_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'notification_rule_shadow_reviews is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_rule_shadow_reviews_append_only
    ON public.notification_rule_shadow_reviews;
CREATE TRIGGER notification_rule_shadow_reviews_append_only
BEFORE UPDATE OR DELETE ON public.notification_rule_shadow_reviews
FOR EACH ROW EXECUTE FUNCTION public.prevent_notification_shadow_review_mutation();

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072204_notification_shadow_review',
    'Add append-only approval evidence for safe disabled unified-rule shadow comparisons.'
)
ON CONFLICT (version) DO NOTHING;
