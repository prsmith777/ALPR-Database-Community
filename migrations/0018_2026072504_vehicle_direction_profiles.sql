-- migration: 2026072504_vehicle_direction_profiles
-- Recover a reconciliation run that failed before automatic retry scheduling
-- was available. Future failures set this bounded retry directly at runtime.
UPDATE public.maintenance_job_state
SET next_run_at = LEAST(
        COALESCE(next_run_at, CURRENT_TIMESTAMP + INTERVAL '1 minute'),
        CURRENT_TIMESTAMP + INTERVAL '1 minute'
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE job_name = 'storage-reconciliation'
  AND status = 'failed';

-- Camera direction is administrator-defined rather than inferred from a
-- camera name. Human front/rear labels calibrate the existing local Vehicle
-- ReID descriptor for each camera; low-confidence results remain unknown.
CREATE TABLE IF NOT EXISTS public.camera_direction_profiles (
    camera_key VARCHAR(100) PRIMARY KEY,
    camera_name VARCHAR(100) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    front_direction_label VARCHAR(80) NOT NULL,
    rear_direction_label VARCHAR(80) NOT NULL,
    minimum_confidence REAL NOT NULL DEFAULT 0.68
        CHECK (minimum_confidence BETWEEN 0.5 AND 0.95),
    profile_version INTEGER NOT NULL DEFAULT 1 CHECK (profile_version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT camera_direction_labels_differ CHECK (
        LOWER(BTRIM(front_direction_label)) <> LOWER(BTRIM(rear_direction_label))
    )
);

CREATE TABLE IF NOT EXISTS public.vehicle_orientation_labels (
    id BIGSERIAL PRIMARY KEY,
    read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    camera_key VARCHAR(100) NOT NULL,
    embedding_model VARCHAR(80) NOT NULL,
    orientation VARCHAR(10) NOT NULL CHECK (orientation IN ('front', 'rear')),
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_username VARCHAR(64) NOT NULL,
    actor_display_name VARCHAR(120) NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (read_id, embedding_model)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_orientation_labels_camera
    ON public.vehicle_orientation_labels (camera_key, embedding_model, orientation, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.vehicle_direction_observations (
    read_id INTEGER PRIMARY KEY REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    camera_key VARCHAR(100) NOT NULL,
    embedding_model VARCHAR(80) NOT NULL,
    classifier_version VARCHAR(80) NOT NULL,
    profile_version INTEGER NOT NULL CHECK (profile_version > 0),
    status VARCHAR(20) NOT NULL CHECK (status IN ('collecting', 'ready', 'unknown')),
    orientation VARCHAR(10) NOT NULL CHECK (orientation IN ('front', 'rear', 'unknown')),
    orientation_confidence REAL CHECK (orientation_confidence BETWEEN 0 AND 1),
    direction_label VARCHAR(80),
    sample_counts JSONB NOT NULL DEFAULT '{"front":0,"rear":0}'::JSONB,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT vehicle_direction_ready_state CHECK (
        (status = 'ready' AND orientation IN ('front', 'rear') AND
         orientation_confidence IS NOT NULL AND direction_label IS NOT NULL) OR
        (status <> 'ready' AND orientation = 'unknown' AND direction_label IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_direction_observations_camera
    ON public.vehicle_direction_observations (camera_key, status, direction_label, evaluated_at DESC);

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072504_vehicle_direction_profiles',
    'Add configurable per-camera direction meanings and audited ReID-assisted front/rear calibration.'
)
ON CONFLICT (version) DO NOTHING;
