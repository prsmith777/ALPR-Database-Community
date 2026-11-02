-- migration: 2026072206_disabled_rule_editor
-- Disabled unified rules may intentionally expand beyond legacy behavior.
-- Evidence remains append-only and version/fingerprint bound; a regression
-- (legacy match lost by unified logic) can never use this approval mode.
ALTER TABLE public.notification_rule_shadow_reviews
    ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(30) NOT NULL DEFAULT 'parity';
ALTER TABLE public.notification_rule_shadow_reviews
    ADD COLUMN IF NOT EXISTS expansion_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.notification_rule_shadow_reviews
    ADD COLUMN IF NOT EXISTS regression_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.notification_rule_shadow_reviews
    DROP CONSTRAINT IF EXISTS notification_rule_shadow_reviews_agreement_count_check;
ALTER TABLE public.notification_rule_shadow_reviews
    DROP CONSTRAINT IF EXISTS notification_rule_shadow_reviews_mismatch_count_check;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'notification_shadow_reviews_counts_valid'
          AND conrelid = 'public.notification_rule_shadow_reviews'::regclass
    ) THEN
        ALTER TABLE public.notification_rule_shadow_reviews
            ADD CONSTRAINT notification_shadow_reviews_counts_valid CHECK (
                agreement_count >= 0
                AND mismatch_count >= 0
                AND agreement_count + mismatch_count = sample_count
                AND expansion_count >= 0
                AND regression_count >= 0
                AND expansion_count + regression_count = mismatch_count
            );
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'notification_shadow_reviews_mode_valid'
          AND conrelid = 'public.notification_rule_shadow_reviews'::regclass
    ) THEN
        ALTER TABLE public.notification_rule_shadow_reviews
            ADD CONSTRAINT notification_shadow_reviews_mode_valid CHECK (
                approval_mode IN ('parity', 'intentional_expansion')
                AND (
                    (approval_mode = 'parity' AND mismatch_count = 0)
                    OR
                    (approval_mode = 'intentional_expansion'
                     AND expansion_count > 0
                     AND regression_count = 0)
                )
            );
    END IF;
END $$;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072206_disabled_rule_editor',
    'Allow version-bound approval of intentional disabled-rule expansions without enabling delivery.'
)
ON CONFLICT (version) DO NOTHING;
