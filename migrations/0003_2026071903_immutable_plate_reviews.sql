-- migration: 2026071903_immutable_plate_reviews
-- Immutable plate observations, append-only review history, and reviewed aliases
ALTER TABLE public.plate_reads
    ADD COLUMN IF NOT EXISTS observed_plate VARCHAR(10),
    ADD COLUMN IF NOT EXISTS review_status VARCHAR(24) NOT NULL DEFAULT 'unreviewed',
    ADD COLUMN IF NOT EXISTS review_revision INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_reviewed_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL;

UPDATE public.plate_reads
SET observed_plate = plate_number
WHERE observed_plate IS NULL;

UPDATE public.plate_reads
SET review_status = CASE WHEN validated THEN 'confirmed' ELSE 'unreviewed' END
WHERE review_revision = 0
  AND review_status = 'unreviewed';

ALTER TABLE public.plate_reads
    ALTER COLUMN observed_plate SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'plate_reads_review_status_check'
    ) THEN
        ALTER TABLE public.plate_reads
            ADD CONSTRAINT plate_reads_review_status_check
            CHECK (review_status IN (
                'unreviewed', 'confirmed', 'corrected', 'rejected', 'alias_resolved'
            ));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'plate_reads_review_revision_check'
    ) THEN
        ALTER TABLE public.plate_reads
            ADD CONSTRAINT plate_reads_review_revision_check
            CHECK (review_revision >= 0);
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.plate_aliases (
    id BIGSERIAL PRIMARY KEY,
    source_plate VARCHAR(10) NOT NULL,
    target_plate VARCHAR(10) NOT NULL,
    camera_name VARCHAR(30),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    reason VARCHAR(120) NOT NULL,
    created_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_by_username VARCHAR(64) NOT NULL,
    created_by_display_name VARCHAR(120) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    disabled_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    disabled_at TIMESTAMPTZ,
    use_count BIGINT NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    CONSTRAINT plate_aliases_different_values CHECK (source_plate <> target_plate),
    CONSTRAINT plate_aliases_use_count_check CHECK (use_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plate_aliases_enabled_scope
    ON public.plate_aliases (
        source_plate,
        COALESCE(LOWER(camera_name), '')
    )
    WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_plate_aliases_target
    ON public.plate_aliases (target_plate, enabled);

ALTER TABLE public.plate_reads
    ADD COLUMN IF NOT EXISTS applied_alias_id BIGINT
        REFERENCES public.plate_aliases(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.plate_review_batches (
    id BIGSERIAL PRIMARY KEY,
    source_plate VARCHAR(10) NOT NULL,
    target_plate VARCHAR(10) NOT NULL,
    criteria JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (jsonb_typeof(criteria) = 'object'),
    matched_count INTEGER NOT NULL CHECK (matched_count > 0),
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_username VARCHAR(64) NOT NULL,
    actor_display_name VARCHAR(120) NOT NULL,
    reason VARCHAR(120) NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.plate_read_reviews (
    id BIGSERIAL PRIMARY KEY,
    read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE RESTRICT,
    read_event_identity VARCHAR(80),
    action VARCHAR(24) NOT NULL
        CHECK (action IN (
            'confirm', 'correct', 'reject', 'reopen', 'reverse', 'alias_applied'
        )),
    previous_plate VARCHAR(10) NOT NULL,
    new_plate VARCHAR(10) NOT NULL,
    previous_status VARCHAR(24) NOT NULL
        CHECK (previous_status IN (
            'unreviewed', 'confirmed', 'corrected', 'rejected', 'alias_resolved'
        )),
    new_status VARCHAR(24) NOT NULL
        CHECK (new_status IN (
            'unreviewed', 'confirmed', 'corrected', 'rejected', 'alias_resolved'
        )),
    reason VARCHAR(120),
    notes TEXT,
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_username VARCHAR(64) NOT NULL,
    actor_display_name VARCHAR(120) NOT NULL,
    alias_id BIGINT REFERENCES public.plate_aliases(id) ON DELETE SET NULL,
    batch_id BIGINT REFERENCES public.plate_review_batches(id) ON DELETE SET NULL,
    reverses_review_id BIGINT REFERENCES public.plate_read_reviews(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_plate_read_reviews_read
    ON public.plate_read_reviews (read_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_plate_read_reviews_actor
    ON public.plate_read_reviews (actor_user_id, created_at DESC)
    WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plate_read_reviews_batch
    ON public.plate_read_reviews (batch_id)
    WHERE batch_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.preserve_observed_plate()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.observed_plate IS NULL THEN
        NEW.observed_plate = NEW.plate_number;
    ELSIF TG_OP = 'UPDATE'
          AND OLD.observed_plate IS DISTINCT FROM NEW.observed_plate THEN
        RAISE EXCEPTION 'plate_reads.observed_plate is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plate_reads_preserve_observed ON public.plate_reads;
CREATE TRIGGER plate_reads_preserve_observed
BEFORE INSERT OR UPDATE ON public.plate_reads
FOR EACH ROW EXECUTE FUNCTION public.preserve_observed_plate();

CREATE OR REPLACE FUNCTION public.prevent_plate_review_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'plate_read_reviews is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plate_read_reviews_append_only ON public.plate_read_reviews;
CREATE TRIGGER plate_read_reviews_append_only
BEFORE UPDATE OR DELETE ON public.plate_read_reviews
FOR EACH ROW EXECUTE FUNCTION public.prevent_plate_review_mutation();

CREATE OR REPLACE FUNCTION public.prevent_plate_alias_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'plate aliases must be disabled, not deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plate_aliases_no_delete ON public.plate_aliases;
CREATE TRIGGER plate_aliases_no_delete
BEFORE DELETE ON public.plate_aliases
FOR EACH ROW EXECUTE FUNCTION public.prevent_plate_alias_delete();

INSERT INTO public.permissions (permission_key, description)
VALUES
    ('plate.review.batch', 'Preview and apply reviewed bulk plate corrections.'),
    ('plate.alias.manage', 'Create and disable recurring plate misread aliases.')
ON CONFLICT (permission_key) DO UPDATE
SET description = EXCLUDED.description;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM public.roles AS role
CROSS JOIN public.permissions AS permission
WHERE role.name = 'administrator'
  AND permission.permission_key IN ('plate.review.batch', 'plate.alias.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026071903_immutable_plate_reviews',
    'Preserve observed plates, append plate review history, and add reviewed recurring aliases.'
)
ON CONFLICT (version) DO NOTHING;
