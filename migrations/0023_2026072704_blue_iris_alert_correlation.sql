-- migration: 2026072704_blue_iris_alert_correlation
-- Preserve the Blue Iris alert pointer received with new plate reads. This is
-- metadata only: the continuous BVR recording remains managed by Blue Iris.
-- Historical reads can be correlated through the read-only alertlist API.
ALTER TABLE IF EXISTS public.plate_reads
    ADD COLUMN IF NOT EXISTS bi_alert_clip TEXT,
    ADD COLUMN IF NOT EXISTS bi_alert_path TEXT,
    ADD COLUMN IF NOT EXISTS bi_alert_offset_ms BIGINT;

CREATE INDEX IF NOT EXISTS idx_plate_reads_bi_alert_clip
    ON public.plate_reads (bi_alert_clip)
    WHERE bi_alert_clip IS NOT NULL;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072704_blue_iris_alert_correlation',
    'Preserve Blue Iris alert clip and offset metadata for read-only continuous-recording correlation.'
)
ON CONFLICT (version) DO NOTHING;
