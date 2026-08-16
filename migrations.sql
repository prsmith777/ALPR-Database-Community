CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;

-- Modify plate_notifications
ALTER TABLE IF EXISTS public.plate_notifications 
    ADD COLUMN IF NOT EXISTS priority integer DEFAULT 1;

-- Modify plate_reads
ALTER TABLE IF EXISTS public.plate_reads 
    ADD COLUMN IF NOT EXISTS camera_name character varying(25),
    ADD COLUMN IF NOT EXISTS image_path varchar(255),
    ADD COLUMN IF NOT EXISTS thumbnail_path varchar(255),
    ADD COLUMN IF NOT EXISTS bi_path varchar(100),
    ADD COLUMN IF NOT EXISTS plate_annotation varchar(255),
    ADD COLUMN IF NOT EXISTS crop_coordinates int[],
    ADD COLUMN IF NOT EXISTS ocr_annotation jsonb,
    ADD COLUMN IF NOT EXISTS confidence decimal,
    ADD COLUMN IF NOT EXISTS bi_zone varchar(30),
    ADD COLUMN IF NOT EXISTS validated boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS event_identity varchar(80);

-- Exact Blue Iris resubmissions are identified by plate, event time, and
-- camera. The camera column keeps simultaneous observations independent.
CREATE INDEX IF NOT EXISTS idx_plate_reads_event_identity
    ON public.plate_reads (plate_number, timestamp, camera_name);

-- New reads carry a stable event identity. The partial unique index lets
-- historical rows remain nullable while atomically suppressing concurrent
-- resubmissions of the same Blue Iris event.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plate_reads_event_identity
    ON public.plate_reads (event_identity)
    WHERE event_identity IS NOT NULL;


-- Please for the love of god work...
-- Fix in reference to #57 and ipct reports about db config on new installs
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'plates_pkey' 
        AND conrelid = 'public.plates'::regclass
    ) THEN
        ALTER TABLE public.plates ADD CONSTRAINT plates_pkey PRIMARY KEY (plate_number);
    END IF;
END $$;

-- Modify known_plates
ALTER TABLE IF EXISTS public.known_plates 
    ADD COLUMN IF NOT EXISTS ignore BOOLEAN DEFAULT FALSE;

-- Modify plates
ALTER TABLE IF EXISTS public.plates 
    ADD COLUMN IF NOT EXISTS occurrence_count INTEGER NOT NULL DEFAULT 0;

-- Create index if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_plates_occurrence_count') THEN
        CREATE INDEX idx_plates_occurrence_count ON plates(occurrence_count);
    END IF;
END $$;

-- Count incrementing function
CREATE OR REPLACE FUNCTION update_plate_occurrence_count()
RETURNS TRIGGER AS $$
BEGIN
    -- Handle INSERT operation
    IF TG_OP = 'INSERT' THEN
        INSERT INTO plates (plate_number, occurrence_count)
        VALUES (NEW.plate_number, 1)
        ON CONFLICT (plate_number)
        DO UPDATE SET occurrence_count = plates.occurrence_count + 1;
    
    -- Handle UPDATE operation (plate number correction)
    ELSIF TG_OP = 'UPDATE' AND OLD.plate_number != NEW.plate_number THEN
        -- Increment the new plate number count (or create if not exists)
        INSERT INTO plates (plate_number, occurrence_count)
        VALUES (NEW.plate_number, 1)
        ON CONFLICT (plate_number)
        DO UPDATE SET occurrence_count = plates.occurrence_count + 1;
        
        -- Only decrement the old plate if it still exists
        UPDATE plates 
        SET occurrence_count = occurrence_count - 1
        WHERE plate_number = OLD.plate_number;
        
        -- Clean up if occurrence count reaches zero
        DELETE FROM plates
        WHERE plate_number = OLD.plate_number
        AND occurrence_count <= 0;
    
    -- Handle DELETE operation
    ELSIF TG_OP = 'DELETE' THEN
        -- Only attempt to decrement if the plate still exists
        UPDATE plates 
        SET occurrence_count = occurrence_count - 1
        WHERE plate_number = OLD.plate_number;
        
        -- Clean up if occurrence count reaches zero
        DELETE FROM plates
        WHERE plate_number = OLD.plate_number
        AND occurrence_count <= 0;
    END IF;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Update trigger to also handle UPDATE operations
DO $$ 
BEGIN
    -- Drop the existing trigger if it exists
    DROP TRIGGER IF EXISTS plate_reads_count_trigger ON plate_reads;
    
    -- Create the updated trigger
    CREATE TRIGGER plate_reads_count_trigger
    AFTER INSERT OR UPDATE OR DELETE ON plate_reads
    FOR EACH ROW
    EXECUTE FUNCTION update_plate_occurrence_count();
END $$;

-- Clerical stuff
CREATE TABLE IF NOT EXISTS devmgmt (
    id SERIAL PRIMARY KEY,
    update1 BOOLEAN DEFAULT FALSE
);
INSERT INTO devmgmt (id, update1)
SELECT 1, false
WHERE NOT EXISTS (SELECT 1 FROM devmgmt);

ALTER TABLE IF EXISTS public.devmgmt
    ADD COLUMN IF NOT EXISTS training_last_record INTEGER DEFAULT 0;


CREATE TABLE IF NOT EXISTS mqttbrokers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    broker VARCHAR(255),
    port INTEGER DEFAULT 1883,
    topic VARCHAR(255),
    username VARCHAR(255),
    password VARCHAR(255),
    use_tls BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS mqttnotifications (
    id SERIAL PRIMARY KEY,
    plate_number VARCHAR(50),
    name VARCHAR(255),
    enabled BOOLEAN DEFAULT TRUE,
    brokerid INTEGER REFERENCES mqttbrokers(id) ON DELETE CASCADE,
    message TEXT,
    includeKnownPlateInfo BOOLEAN DEFAULT TRUE
);

-- MQTT integration v2 -------------------------------------------------------
-- Keep the legacy topic column and mqttnotifications table intact so this
-- migration is non-destructive. The new application no longer uses them.
ALTER TABLE IF EXISTS public.mqttbrokers
    ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS client_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS public.mqtt_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    base_topic VARCHAR(512) NOT NULL DEFAULT 'Blue Iris/ALPR',
    camera_topic_template VARCHAR(512) NOT NULL DEFAULT '{base_topic}/{camera_key}',
    default_qos SMALLINT NOT NULL DEFAULT 1 CHECK (default_qos BETWEEN 0 AND 2),
    retain_messages BOOLEAN NOT NULL DEFAULT FALSE,
    payload_profile VARCHAR(50) NOT NULL DEFAULT 'generic_json'
        CHECK (payload_profile IN ('generic_json', 'homeseer', 'home_assistant')),
    local_timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
    hour_format SMALLINT NOT NULL DEFAULT 12 CHECK (hour_format IN (12, 24)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.mqtt_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.mqtt_cameras (
    id SERIAL PRIMARY KEY,
    camera_name VARCHAR(255) NOT NULL,
    camera_key VARCHAR(100) NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    topic_override VARCHAR(65535),
    first_seen_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT mqtt_cameras_camera_key_format
        CHECK (camera_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS mqtt_cameras_camera_name_lower_key
    ON public.mqtt_cameras (LOWER(camera_name));

CREATE TABLE IF NOT EXISTS public.mqtt_rules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    match_type VARCHAR(50) NOT NULL
        CHECK (match_type IN (
            'any_plate',
            'exact_plate',
            'any_known_plate',
            'known_name',
            'tag'
        )),
    match_value TEXT,
    plate_match_mode VARCHAR(20) NOT NULL DEFAULT 'off'
        CHECK (plate_match_mode IN ('off', 'strict', 'balanced', 'broad')),
    fuzzy_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    fuzzy_max_distance SMALLINT NOT NULL DEFAULT 1
        CHECK (fuzzy_max_distance BETWEEN 0 AND 2),
    fuzzy_min_length SMALLINT NOT NULL DEFAULT 5
        CHECK (fuzzy_min_length BETWEEN 1 AND 20),
    fuzzy_require_unique BOOLEAN NOT NULL DEFAULT TRUE,
    fuzzy_ocr_aware BOOLEAN NOT NULL DEFAULT TRUE,
    broker_id INTEGER NOT NULL REFERENCES public.mqttbrokers(id) ON DELETE RESTRICT,
    destination_mode VARCHAR(50) NOT NULL DEFAULT 'per_camera'
        CHECK (destination_mode IN ('per_camera', 'fixed_topic')),
    fixed_topic VARCHAR(65535),
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT mqtt_rules_match_value_required CHECK (
        match_type IN ('any_plate', 'any_known_plate')
        OR NULLIF(BTRIM(match_value), '') IS NOT NULL
    ),
    CONSTRAINT mqtt_rules_fixed_topic_required CHECK (
        destination_mode = 'per_camera'
        OR NULLIF(BTRIM(fixed_topic), '') IS NOT NULL
    )
);

ALTER TABLE public.mqtt_rules
    ADD COLUMN IF NOT EXISTS plate_match_mode VARCHAR(20);

UPDATE public.mqtt_rules
SET plate_match_mode = CASE
    WHEN fuzzy_enabled THEN 'balanced'
    ELSE 'off'
END
WHERE plate_match_mode IS NULL;

ALTER TABLE public.mqtt_rules
    ALTER COLUMN plate_match_mode SET DEFAULT 'off',
    ALTER COLUMN plate_match_mode SET NOT NULL;

ALTER TABLE public.mqtt_rules
    DROP CONSTRAINT IF EXISTS mqtt_rules_plate_match_mode_check;

ALTER TABLE public.mqtt_rules
    ADD CONSTRAINT mqtt_rules_plate_match_mode_check
    CHECK (plate_match_mode IN ('off', 'strict', 'balanced', 'broad'));

CREATE TABLE IF NOT EXISTS public.mqtt_rule_cameras (
    rule_id INTEGER NOT NULL REFERENCES public.mqtt_rules(id) ON DELETE CASCADE,
    camera_id INTEGER NOT NULL REFERENCES public.mqtt_cameras(id) ON DELETE CASCADE,
    PRIMARY KEY (rule_id, camera_id)
);

CREATE INDEX IF NOT EXISTS idx_mqtt_rules_enabled
    ON public.mqtt_rules (enabled) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_mqtt_rules_broker_id
    ON public.mqtt_rules (broker_id);
CREATE INDEX IF NOT EXISTS idx_mqtt_rule_cameras_camera_id
    ON public.mqtt_rule_cameras (camera_id);
CREATE INDEX IF NOT EXISTS idx_mqtt_cameras_enabled
    ON public.mqtt_cameras (enabled) WHERE enabled = TRUE;

CREATE OR REPLACE FUNCTION public.mqtt_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mqttbrokers_set_updated_at ON public.mqttbrokers;
CREATE TRIGGER mqttbrokers_set_updated_at
BEFORE UPDATE ON public.mqttbrokers
FOR EACH ROW EXECUTE FUNCTION public.mqtt_set_updated_at();

DROP TRIGGER IF EXISTS mqtt_settings_set_updated_at ON public.mqtt_settings;
CREATE TRIGGER mqtt_settings_set_updated_at
BEFORE UPDATE ON public.mqtt_settings
FOR EACH ROW EXECUTE FUNCTION public.mqtt_set_updated_at();

DROP TRIGGER IF EXISTS mqtt_cameras_set_updated_at ON public.mqtt_cameras;
CREATE TRIGGER mqtt_cameras_set_updated_at
BEFORE UPDATE ON public.mqtt_cameras
FOR EACH ROW EXECUTE FUNCTION public.mqtt_set_updated_at();

DROP TRIGGER IF EXISTS mqtt_rules_set_updated_at ON public.mqtt_rules;
CREATE TRIGGER mqtt_rules_set_updated_at
BEFORE UPDATE ON public.mqtt_rules
FOR EACH ROW EXECUTE FUNCTION public.mqtt_set_updated_at();

-- Durable MQTT delivery outbox and activity history -------------------------
-- A queue row represents one camera observation going to one broker/topic.
-- The unique dedupe key suppresses only an exact resubmission of that same
-- camera event and destination; different cameras remain independent.
CREATE TABLE IF NOT EXISTS public.mqtt_deliveries (
    id BIGSERIAL PRIMARY KEY,
    dedupe_key VARCHAR(80) NOT NULL UNIQUE,
    event_id VARCHAR(255) NOT NULL,
    read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
    camera_id INTEGER REFERENCES public.mqtt_cameras(id) ON DELETE SET NULL,
    camera_key VARCHAR(100) NOT NULL,
    camera_name VARCHAR(255) NOT NULL,
    broker_id INTEGER NOT NULL REFERENCES public.mqttbrokers(id) ON DELETE RESTRICT,
    topic VARCHAR(65535) NOT NULL,
    payload JSONB NOT NULL,
    qos SMALLINT NOT NULL DEFAULT 1 CHECK (qos BETWEEN 0 AND 2),
    retain BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'retry', 'succeeded', 'dead')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(255),
    last_error TEXT,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT mqtt_deliveries_camera_key_format
        CHECK (camera_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT mqtt_deliveries_payload_object
        CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT mqtt_deliveries_lock_state CHECK (
        (
            status = 'processing'
            AND locked_at IS NOT NULL
            AND NULLIF(BTRIM(locked_by), '') IS NOT NULL
        )
        OR
        (
            status <> 'processing'
            AND locked_at IS NULL
            AND locked_by IS NULL
        )
    ),
    CONSTRAINT mqtt_deliveries_published_state CHECK (
        (status = 'succeeded' AND published_at IS NOT NULL)
        OR
        (status <> 'succeeded' AND published_at IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS public.mqtt_delivery_attempts (
    id BIGSERIAL PRIMARY KEY,
    delivery_id BIGINT NOT NULL
        REFERENCES public.mqtt_deliveries(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    outcome VARCHAR(20) NOT NULL
        CHECK (outcome IN ('succeeded', 'retry', 'dead')),
    worker_id VARCHAR(255),
    error_code VARCHAR(100),
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_mqtt_deliveries_due
    ON public.mqtt_deliveries (next_attempt_at, id)
    WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS idx_mqtt_deliveries_created_at
    ON public.mqtt_deliveries (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mqtt_deliveries_read_id
    ON public.mqtt_deliveries (read_id);
CREATE INDEX IF NOT EXISTS idx_mqtt_deliveries_broker_id
    ON public.mqtt_deliveries (broker_id);
CREATE INDEX IF NOT EXISTS idx_mqtt_delivery_attempts_delivery_id
    ON public.mqtt_delivery_attempts (delivery_id, attempt_number DESC);

DROP TRIGGER IF EXISTS mqtt_deliveries_set_updated_at ON public.mqtt_deliveries;
CREATE TRIGGER mqtt_deliveries_set_updated_at
BEFORE UPDATE ON public.mqtt_deliveries
FOR EACH ROW EXECUTE FUNCTION public.mqtt_set_updated_at();

-- Identity, roles, and audit foundation --------------------------------------
-- This first slice is deliberately non-disruptive: it creates the durable
-- identity model without changing the existing password-only login. A later
-- migration will bootstrap the first named owner and cut sessions over only
-- after the compatibility path has been tested.
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(64) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    password_hash TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT users_username_normalized
        CHECK (
            username = LOWER(username)
            AND username ~ '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$'
        ),
    CONSTRAINT users_display_name_present
        CHECK (NULLIF(BTRIM(display_name), '') IS NOT NULL),
    CONSTRAINT users_password_hash_present
        CHECK (NULLIF(BTRIM(password_hash), '') IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key
    ON public.users (LOWER(username));

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.roles (
    id SMALLSERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(80) NOT NULL,
    description TEXT NOT NULL,
    system_role BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT roles_name_format
        CHECK (name ~ '^[a-z][a-z0-9_]{2,49}$')
);

CREATE TABLE IF NOT EXISTS public.permissions (
    id SMALLSERIAL PRIMARY KEY,
    permission_key VARCHAR(100) NOT NULL UNIQUE,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT permissions_key_format
        CHECK (permission_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
    role_id SMALLINT NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
    permission_id SMALLINT NOT NULL
        REFERENCES public.permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role_id SMALLINT NOT NULL REFERENCES public.roles(id) ON DELETE RESTRICT,
    granted_by_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS public.user_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    user_agent VARCHAR(255) NOT NULL DEFAULT 'Unknown Device',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoke_reason VARCHAR(100),
    CONSTRAINT user_sessions_token_hash_format
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT user_sessions_expiration_order
        CHECK (expires_at > created_at),
    CONSTRAINT user_sessions_revocation_pair
        CHECK (
            (revoked_at IS NULL AND revoke_reason IS NULL)
            OR
            (revoked_at IS NOT NULL AND NULLIF(BTRIM(revoke_reason), '') IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_active
    ON public.user_sessions (user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.login_attempt_limits (
    subject_hash CHAR(64) PRIMARY KEY,
    failed_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (failed_attempts >= 0),
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    blocked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT login_attempt_limits_subject_hash_format
        CHECK (subject_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_login_attempt_limits_updated_at
    ON public.login_attempt_limits (updated_at);

CREATE TABLE IF NOT EXISTS public.api_credentials (
    id BIGSERIAL PRIMARY KEY,
    owner_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    name VARCHAR(120) NOT NULL,
    key_prefix VARCHAR(16) NOT NULL UNIQUE,
    secret_hash CHAR(64) NOT NULL UNIQUE,
    scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT api_credentials_name_present
        CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
    CONSTRAINT api_credentials_prefix_format
        CHECK (key_prefix ~ '^[0-9a-f]{8,16}$'),
    CONSTRAINT api_credentials_secret_hash_format
        CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT api_credentials_scope_values_present
        CHECK (array_position(scopes, NULL) IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_api_credentials_owner
    ON public.api_credentials (owner_user_id, status);

CREATE TABLE IF NOT EXISTS public.audit_events (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    actor_api_credential_id BIGINT
        REFERENCES public.api_credentials(id) ON DELETE RESTRICT,
    source VARCHAR(20) NOT NULL
        CHECK (source IN ('browser', 'api', 'system')),
    event_type VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100),
    resource_id VARCHAR(255),
    outcome VARCHAR(20) NOT NULL
        CHECK (outcome IN ('succeeded', 'denied', 'failed')),
    reason TEXT,
    request_id VARCHAR(100),
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (jsonb_typeof(metadata) = 'object'),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT audit_events_single_actor
        CHECK (num_nonnulls(actor_user_id, actor_api_credential_id) <= 1),
    CONSTRAINT audit_events_type_present
        CHECK (NULLIF(BTRIM(event_type), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_audit_events_occurred_at
    ON public.audit_events (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_user
    ON public.audit_events (actor_user_id, occurred_at DESC)
    WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_resource
    ON public.audit_events (resource_type, resource_id, occurred_at DESC)
    WHERE resource_type IS NOT NULL;

CREATE OR REPLACE FUNCTION public.identity_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_updated_at ON public.users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.identity_set_updated_at();

DROP TRIGGER IF EXISTS roles_set_updated_at ON public.roles;
CREATE TRIGGER roles_set_updated_at
BEFORE UPDATE ON public.roles
FOR EACH ROW EXECUTE FUNCTION public.identity_set_updated_at();

CREATE OR REPLACE FUNCTION public.prevent_audit_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_append_only ON public.audit_events;
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_event_mutation();

INSERT INTO public.roles (name, display_name, description)
VALUES
    ('administrator', 'Administrator', 'Full application and security administration.'),
    ('operator', 'Operator', 'Day-to-day plate review, automation, and data management.'),
    ('viewer', 'Viewer', 'Read-only access to plate data and approved exports.'),
    ('auditor', 'Auditor', 'Read-only investigations with audit-history access.')
ON CONFLICT (name) DO UPDATE
SET display_name = EXCLUDED.display_name,
    description = EXCLUDED.description;

INSERT INTO public.permissions (permission_key, description)
VALUES
    ('system.manage_users', 'Create, disable, delete, and assign roles to users.'),
    ('system.manage_settings', 'Change application and integration settings.'),
    ('system.view_audit', 'View append-only audit history.'),
    ('assistant.use', 'Use configured AI assistants for ALPR queries.'),
    ('plate.read', 'View plate reads, images, and known-plate details.'),
    ('plate.review', 'Confirm, correct, or reject plate reads.'),
    ('plate.delete', 'Delete plate reads and plate records.'),
    ('known_plate.manage', 'Manage known plates and their notes.'),
    ('tag.manage', 'Create, edit, assign, and remove tags.'),
    ('notification.manage', 'Manage notification rules and delivery state.'),
    ('mqtt.manage', 'Manage MQTT brokers, cameras, rules, and activity.'),
    ('export.create', 'Create and download approved exports.'),
    ('maintenance.manage', 'Run approved storage and database maintenance.')
ON CONFLICT (permission_key) DO UPDATE
SET description = EXCLUDED.description;

-- Keep the durable database grants synchronized with the application role
-- matrix when an existing installation receives a least-privilege correction.
DELETE FROM public.role_permissions AS role_permission
USING public.roles AS role
WHERE role_permission.role_id = role.id
  AND role.name IN ('administrator', 'operator', 'viewer', 'auditor');

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM public.roles AS role
CROSS JOIN public.permissions AS permission
WHERE
    role.name = 'administrator'
    OR (
        role.name = 'operator'
        AND permission.permission_key IN (
            'plate.read',
            'plate.review',
            'known_plate.manage',
            'tag.manage'
        )
    )
    OR (
        role.name = 'viewer'
        AND permission.permission_key IN (
            'plate.read'
        )
    )
    OR (
        role.name = 'auditor'
        AND permission.permission_key IN (
            'plate.read',
            'system.view_audit',
            'export.create'
        )
    )
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026071901_identity_audit_foundation',
    'Create users, roles, permissions, database sessions, scoped credentials, and append-only audit events.'
)
ON CONFLICT (version) DO NOTHING;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026071902_assistant_authorization',
    'Restrict AI Assistant access to explicitly authorized administrators.'
)
ON CONFLICT (version) DO NOTHING;


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

-- Reconcile stored plate occurrence counts after bulk imports.
DO $$
DECLARE
    mismatch_count BIGINT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.schema_migrations
        WHERE version = '2026072101_repair_plate_occurrence_counts'
    ) THEN
        WITH actual_counts AS (
            SELECT plate_number, COUNT(*)::INTEGER AS read_count
            FROM public.plate_reads
            GROUP BY plate_number
        )
        UPDATE public.plates AS plate
        SET occurrence_count = actual.read_count
        FROM actual_counts AS actual
        WHERE actual.plate_number = plate.plate_number
          AND plate.occurrence_count IS DISTINCT FROM actual.read_count;

        UPDATE public.plates AS plate
        SET occurrence_count = 0
        WHERE plate.occurrence_count <> 0
          AND NOT EXISTS (
              SELECT 1
              FROM public.plate_reads AS read
              WHERE read.plate_number = plate.plate_number
          );

        SELECT COUNT(*)
        INTO mismatch_count
        FROM (
            SELECT
                COALESCE(plate.plate_number, actual.plate_number) AS plate_number,
                plate.occurrence_count,
                COALESCE(actual.read_count, 0) AS read_count
            FROM public.plates AS plate
            FULL OUTER JOIN (
                SELECT plate_number, COUNT(*)::INTEGER AS read_count
                FROM public.plate_reads
                GROUP BY plate_number
            ) AS actual
                ON actual.plate_number = plate.plate_number
            WHERE plate.plate_number IS NULL
               OR plate.occurrence_count IS DISTINCT FROM COALESCE(actual.read_count, 0)
        ) AS mismatches;

        IF mismatch_count <> 0 THEN
            RAISE EXCEPTION
                'Plate occurrence reconciliation left % mismatched plate rows',
                mismatch_count;
        END IF;

        INSERT INTO public.schema_migrations (version, description)
        VALUES (
            '2026072101_repair_plate_occurrence_counts',
            'Reconcile stored plate occurrence counts with imported plate reads.'
        );
    END IF;
END $$;


-- Channel-neutral notification rule foundation -----------------------------
-- This schema is intentionally inert until existing Pushover and MQTT paths
-- are migrated in a later release. New rules default disabled, and this
-- migration neither copies nor changes any existing notification behavior.
CREATE TABLE IF NOT EXISTS public.notification_rules (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    event_type VARCHAR(50) NOT NULL DEFAULT 'plate_read.accepted'
        CHECK (event_type IN ('plate_read.accepted', 'camera.activity_check')),
    cooldown_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (cooldown_seconds BETWEEN 0 AND 2678400),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_rules_name_present
        CHECK (NULLIF(BTRIM(name), '') IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.notification_condition_groups (
    id BIGSERIAL PRIMARY KEY,
    rule_id BIGINT NOT NULL REFERENCES public.notification_rules(id) ON DELETE CASCADE,
    parent_group_id BIGINT,
    combinator VARCHAR(10) NOT NULL DEFAULT 'all'
        CHECK (combinator IN ('all', 'any', 'not')),
    negated BOOLEAN NOT NULL DEFAULT FALSE,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    UNIQUE (id, rule_id),
    CONSTRAINT notification_condition_groups_parent_same_rule
        FOREIGN KEY (parent_group_id, rule_id)
        REFERENCES public.notification_condition_groups(id, rule_id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_condition_groups_root
    ON public.notification_condition_groups (rule_id)
    WHERE parent_group_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_condition_groups_parent
    ON public.notification_condition_groups (parent_group_id, position);

CREATE TABLE IF NOT EXISTS public.notification_conditions (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL
        REFERENCES public.notification_condition_groups(id) ON DELETE CASCADE,
    condition_type VARCHAR(50) NOT NULL
        CHECK (condition_type IN (
            'always',
            'event_type',
            'plate_match',
            'camera',
            'known_plate',
            'known_name',
            'tag',
            'watchlist',
            'confidence',
            'read_count',
            'local_time_window'
        )),
    operator VARCHAR(30) NOT NULL,
    operand JSONB NOT NULL DEFAULT '{}'::JSONB,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    CONSTRAINT notification_conditions_operand_object
        CHECK (jsonb_typeof(operand) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_notification_conditions_group
    ON public.notification_conditions (group_id, position, id);

CREATE TABLE IF NOT EXISTS public.notification_channels (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    channel_type VARCHAR(30) NOT NULL
        CHECK (channel_type IN ('pushover', 'mqtt', 'email', 'webhook')),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    credential_reference VARCHAR(255),
    configuration JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_channels_name_present
        CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
    CONSTRAINT notification_channels_configuration_object
        CHECK (jsonb_typeof(configuration) = 'object')
);

COMMENT ON COLUMN public.notification_channels.credential_reference IS
    'Reference to separately protected credentials; never store a secret in this field.';

CREATE TABLE IF NOT EXISTS public.notification_actions (
    id BIGSERIAL PRIMARY KEY,
    rule_id BIGINT NOT NULL REFERENCES public.notification_rules(id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES public.notification_channels(id) ON DELETE RESTRICT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    configuration JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (rule_id, position),
    CONSTRAINT notification_actions_configuration_object
        CHECK (jsonb_typeof(configuration) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_notification_actions_channel
    ON public.notification_actions (channel_id);

CREATE TABLE IF NOT EXISTS public.notification_executions (
    id BIGSERIAL PRIMARY KEY,
    execution_key VARCHAR(100) NOT NULL UNIQUE,
    event_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
    rule_id BIGINT NOT NULL REFERENCES public.notification_rules(id) ON DELETE RESTRICT,
    rule_version INTEGER NOT NULL CHECK (rule_version > 0),
    outcome VARCHAR(30) NOT NULL
        CHECK (outcome IN (
            'matched', 'not_matched', 'suppressed', 'disabled',
            'event_filtered', 'invalid', 'error'
        )),
    reason VARCHAR(100) NOT NULL,
    decision JSONB NOT NULL DEFAULT '{}'::JSONB,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_executions_decision_object
        CHECK (jsonb_typeof(decision) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_notification_executions_rule_activity
    ON public.notification_executions (rule_id, evaluated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notification_executions_event
    ON public.notification_executions (event_id, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
    id BIGSERIAL PRIMARY KEY,
    dedupe_key VARCHAR(100) NOT NULL UNIQUE,
    execution_id BIGINT NOT NULL
        REFERENCES public.notification_executions(id) ON DELETE CASCADE,
    action_id BIGINT NOT NULL REFERENCES public.notification_actions(id) ON DELETE RESTRICT,
    channel_id BIGINT NOT NULL REFERENCES public.notification_channels(id) ON DELETE RESTRICT,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'retry', 'succeeded', 'dead', 'cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(255),
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_deliveries_payload_object
        CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT notification_deliveries_lock_state CHECK (
        (status = 'processing' AND locked_at IS NOT NULL AND NULLIF(BTRIM(locked_by), '') IS NOT NULL)
        OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
    ),
    CONSTRAINT notification_deliveries_delivered_state CHECK (
        (status = 'succeeded' AND delivered_at IS NOT NULL)
        OR (status <> 'succeeded' AND delivered_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
    ON public.notification_deliveries (next_attempt_at, id)
    WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_activity
    ON public.notification_deliveries (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.notification_delivery_attempts (
    id BIGSERIAL PRIMARY KEY,
    delivery_id BIGINT NOT NULL
        REFERENCES public.notification_deliveries(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    response JSONB NOT NULL DEFAULT '{}'::JSONB,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (delivery_id, attempt_number),
    CONSTRAINT notification_delivery_attempts_response_object
        CHECK (jsonb_typeof(response) = 'object')
);

CREATE OR REPLACE FUNCTION public.notification_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_rules_set_updated_at ON public.notification_rules;
CREATE TRIGGER notification_rules_set_updated_at
BEFORE UPDATE ON public.notification_rules
FOR EACH ROW EXECUTE FUNCTION public.notification_set_updated_at();

DROP TRIGGER IF EXISTS notification_channels_set_updated_at ON public.notification_channels;
CREATE TRIGGER notification_channels_set_updated_at
BEFORE UPDATE ON public.notification_channels
FOR EACH ROW EXECUTE FUNCTION public.notification_set_updated_at();

DROP TRIGGER IF EXISTS notification_actions_set_updated_at ON public.notification_actions;
CREATE TRIGGER notification_actions_set_updated_at
BEFORE UPDATE ON public.notification_actions
FOR EACH ROW EXECUTE FUNCTION public.notification_set_updated_at();

DROP TRIGGER IF EXISTS notification_deliveries_set_updated_at ON public.notification_deliveries;
CREATE TRIGGER notification_deliveries_set_updated_at
BEFORE UPDATE ON public.notification_deliveries
FOR EACH ROW EXECUTE FUNCTION public.notification_set_updated_at();

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072201_unified_notification_foundation',
    'Add inert channel-neutral rules, nested conditions, actions, executions, deliveries, and attempts.'
)
ON CONFLICT (version) DO NOTHING;

-- Extend the inert shared evaluator vocabulary for legacy known-name rules.
-- This still copies no rules and changes no active delivery path.
ALTER TABLE IF EXISTS public.notification_conditions
    DROP CONSTRAINT IF EXISTS notification_conditions_condition_type_check;
ALTER TABLE IF EXISTS public.notification_conditions
    ADD CONSTRAINT notification_conditions_condition_type_check
    CHECK (condition_type IN (
        'always',
        'event_type',
        'plate_match',
        'camera',
        'known_plate',
        'known_name',
        'tag',
        'watchlist',
        'confidence',
        'read_count',
        'local_time_window'
    ));

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072202_notification_migration_preview',
    'Add known-name rule vocabulary for the read-only legacy notification migration preview.'
)
ON CONFLICT (version) DO NOTHING;

-- Record each legacy rule copied into the inert unified model. The unique source
-- identity makes the application migration safe to retry, while the restricted
-- target reference preserves provenance for later review and cutover.
CREATE TABLE IF NOT EXISTS public.notification_rule_migrations (
    id BIGSERIAL PRIMARY KEY,
    source_type VARCHAR(20) NOT NULL
        CHECK (source_type IN ('pushover', 'mqtt')),
    source_id BIGINT NOT NULL CHECK (source_id > 0),
    target_rule_id BIGINT NOT NULL UNIQUE
        REFERENCES public.notification_rules(id) ON DELETE RESTRICT,
    applied_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_rule_migrations_created_at
    ON public.notification_rule_migrations (created_at DESC, id DESC);

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072203_disabled_notification_rule_migration',
    'Track idempotent disabled-only copies of legacy Pushover and MQTT rules.'
)
ON CONFLICT (version) DO NOTHING;

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

-- Append-only history for explicit per-rule cutovers and rollbacks. The live
-- source/target enabled flags remain the source of truth; these rows preserve
-- who changed them, which reviewed version was involved, and why.
CREATE TABLE IF NOT EXISTS public.notification_rule_cutover_events (
    id BIGSERIAL PRIMARY KEY,
    migration_id BIGINT NOT NULL
        REFERENCES public.notification_rule_migrations(id) ON DELETE RESTRICT,
    direction VARCHAR(20) NOT NULL
        CHECK (direction IN ('cutover', 'rollback')),
    rule_version INTEGER NOT NULL CHECK (rule_version > 0),
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_rule_cutover_events_metadata_object
        CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_notification_rule_cutover_events_activity
    ON public.notification_rule_cutover_events (migration_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.prevent_notification_cutover_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'notification_rule_cutover_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_rule_cutover_events_append_only
    ON public.notification_rule_cutover_events;
CREATE TRIGGER notification_rule_cutover_events_append_only
BEFORE UPDATE OR DELETE ON public.notification_rule_cutover_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_notification_cutover_event_mutation();

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072205_guarded_notification_cutover',
    'Add append-only evidence for guarded per-rule unified notification cutover and rollback.'
)
ON CONFLICT (version) DO NOTHING;

-- Preserve the legacy flagged boolean for evaluator compatibility while adding
-- user-facing monitoring context. Existing monitored plates receive a stable
-- timestamp and the normal priority; original reads and plate identities are
-- unchanged.
ALTER TABLE public.plates
    ADD COLUMN IF NOT EXISTS monitor_reason TEXT,
    ADD COLUMN IF NOT EXISTS monitor_priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    ADD COLUMN IF NOT EXISTS monitored_at TIMESTAMPTZ;

ALTER TABLE public.plates
    DROP CONSTRAINT IF EXISTS plates_monitor_priority_check;
ALTER TABLE public.plates
    ADD CONSTRAINT plates_monitor_priority_check
    CHECK (monitor_priority IN ('low', 'normal', 'high', 'critical'));

UPDATE public.plates
SET monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
WHERE flagged = TRUE AND monitored_at IS NULL;

-- A removed legacy source can leave a safely disabled unified copy behind.
-- Retiring the mapping keeps the target disabled and preserves all rows and
-- evidence while removing it from active migration workflows.
ALTER TABLE public.notification_rule_migrations
    ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retired_by_user_id BIGINT
        REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS retirement_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_notification_rule_migrations_active
    ON public.notification_rule_migrations (source_type, source_id)
    WHERE retired_at IS NULL;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072401_monitored_plates_and_orphan_retirement',
    'Add monitored-plate context and audited retirement for safely disabled orphaned notification migrations.'
)
ON CONFLICT (version) DO NOTHING;

-- Finalization is the deliberate end of a legacy notification rule runtime. Preserve
-- an immutable, credential-free copy of each source rule before deleting it,
-- then remove the mapping from active migration/cutover workflows. Unified
-- rule delivery and its append-only cutover evidence remain authoritative.
ALTER TABLE public.notification_rule_migrations
    ADD COLUMN IF NOT EXISTS legacy_snapshot JSONB,
    ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finalized_by_user_id BIGINT
        REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS finalization_reason TEXT;

ALTER TABLE public.notification_rule_migrations
    DROP CONSTRAINT IF EXISTS notification_rule_migrations_legacy_snapshot_object;
ALTER TABLE public.notification_rule_migrations
    ADD CONSTRAINT notification_rule_migrations_legacy_snapshot_object
    CHECK (legacy_snapshot IS NULL OR jsonb_typeof(legacy_snapshot) = 'object');

ALTER TABLE public.notification_rule_migrations
    DROP CONSTRAINT IF EXISTS notification_rule_migrations_finalization_complete;
ALTER TABLE public.notification_rule_migrations
    ADD CONSTRAINT notification_rule_migrations_finalization_complete
    CHECK (
        (finalized_at IS NULL AND legacy_snapshot IS NULL AND finalization_reason IS NULL)
        OR
        (finalized_at IS NOT NULL AND legacy_snapshot IS NOT NULL
         AND NULLIF(BTRIM(finalization_reason), '') IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_notification_rule_migrations_unfinalized
    ON public.notification_rule_migrations (source_type, source_id)
    WHERE retired_at IS NULL AND finalized_at IS NULL;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072403_finalize_legacy_mqtt_rules',
    'Archive verified cutover MQTT source rules and remove their legacy runtime rows.'
)
ON CONFLICT (version) DO NOTHING;

-- The same verified-delivery boundary now retires legacy exact-plate Pushover
-- rows. No credentials are copied into the immutable source snapshot.
INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072404_finalize_legacy_pushover_rules',
    'Extend verified legacy finalization and immutable snapshots to migrated Pushover rules.'
)
ON CONFLICT (version) DO NOTHING;

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

-- Local-only visual search foundation. Derived vehicle-region crops and
-- explainable exact/perceptual hashes are separate from immutable source
-- captures. No historical work is queued automatically by this migration.
CREATE TABLE IF NOT EXISTS public.capture_assets (
    id BIGSERIAL PRIMARY KEY,
    read_id INTEGER NOT NULL
        REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    asset_type VARCHAR(30) NOT NULL DEFAULT 'vehicle_crop'
        CHECK (asset_type IN ('vehicle_crop')),
    algorithm_version VARCHAR(40) NOT NULL,
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('ready', 'failed')),
    source_image_path VARCHAR(255) NOT NULL,
    derived_path VARCHAR(255),
    source_sha256 CHAR(64)
        CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
    perceptual_hash CHAR(16)
        CHECK (perceptual_hash IS NULL OR perceptual_hash ~ '^[0-9a-f]{16}$'),
    crop_box JSONB,
    image_width INTEGER CHECK (image_width IS NULL OR image_width > 0),
    image_height INTEGER CHECK (image_height IS NULL OR image_height > 0),
    crop_width INTEGER CHECK (crop_width IS NULL OR crop_width > 0),
    crop_height INTEGER CHECK (crop_height IS NULL OR crop_height > 0),
    attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
    error_code VARCHAR(80),
    indexed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (read_id, asset_type, algorithm_version),
    CONSTRAINT capture_assets_ready_state CHECK (
        (status = 'ready'
         AND derived_path IS NOT NULL
         AND source_sha256 IS NOT NULL
         AND perceptual_hash IS NOT NULL
         AND crop_box IS NOT NULL
         AND indexed_at IS NOT NULL
         AND error_code IS NULL)
        OR
        (status = 'failed'
         AND derived_path IS NULL
         AND source_sha256 IS NULL
         AND perceptual_hash IS NULL
         AND indexed_at IS NULL
         AND error_code IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_capture_assets_ready_hash
    ON public.capture_assets (perceptual_hash, read_id)
    WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_capture_assets_status
    ON public.capture_assets (status, updated_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.capture_asset_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS capture_assets_set_updated_at ON public.capture_assets;
CREATE TRIGGER capture_assets_set_updated_at
BEFORE UPDATE ON public.capture_assets
FOR EACH ROW EXECUTE FUNCTION public.capture_asset_set_updated_at();

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072207_image_similarity_foundation',
    'Add inert local derived capture assets for resumable exact and perceptual image search.'
)
ON CONFLICT (version) DO NOTHING;

-- Camera-scoped crop profiles allow tight LPR and wide overview cameras to
-- derive appropriately framed search assets without modifying source images.
CREATE TABLE IF NOT EXISTS public.camera_visual_profiles (
    camera_key VARCHAR(100) PRIMARY KEY,
    camera_name VARCHAR(100) NOT NULL,
    crop_mode VARCHAR(20) NOT NULL DEFAULT 'auto'
        CHECK (crop_mode IN ('auto', 'custom', 'full_frame')),
    context_percent INTEGER NOT NULL DEFAULT 90
        CHECK (context_percent BETWEEN 40 AND 100),
    vertical_offset_percent INTEGER NOT NULL DEFAULT 0
        CHECK (vertical_offset_percent BETWEEN -25 AND 25),
    profile_version INTEGER NOT NULL DEFAULT 1 CHECK (profile_version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.capture_assets
    ADD COLUMN IF NOT EXISTS crop_profile_version INTEGER NOT NULL DEFAULT 1
        CHECK (crop_profile_version > 0);

CREATE OR REPLACE FUNCTION public.camera_visual_profile_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS camera_visual_profiles_set_updated_at ON public.camera_visual_profiles;
CREATE TRIGGER camera_visual_profiles_set_updated_at
BEFORE UPDATE ON public.camera_visual_profiles
FOR EACH ROW EXECUTE FUNCTION public.camera_visual_profile_set_updated_at();

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072208_camera_visual_profiles',
    'Add versioned camera-specific crop setup for derived visual-search assets.'
)
ON CONFLICT (version) DO NOTHING;

-- A compact color-distribution signal complements structural dHash ranking.
-- Existing assets remain valid and fall back safely until background indexing
-- persists their color signature; searches may derive it transiently meanwhile.
ALTER TABLE public.capture_assets
    ADD COLUMN IF NOT EXISTS color_signature CHAR(40)
        CHECK (color_signature IS NULL OR color_signature ~ '^[0-9a-f]{40}$');

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072301_visual_color_signatures',
    'Add a backward-compatible compact color signal for explainable multi-signal visual ranking.'
)
ON CONFLICT (version) DO NOTHING;

-- Version the color signal so the improved vehicle-focused histogram can be
-- derived lazily for existing assets without mixing incompatible signatures.
ALTER TABLE public.capture_assets
    ADD COLUMN IF NOT EXISTS color_signature_version SMALLINT
        CHECK (color_signature_version IS NULL OR color_signature_version > 0);

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072302_vehicle_focus_ranking',
    'Version vehicle-focused color signatures for conservative visual ranking and lazy compatibility.'
)
ON CONFLICT (version) DO NOTHING;

-- Learned vehicle re-identification descriptors replace heuristic plate,
-- structure, and color ranking. Embeddings are fixed-size normalized float32
-- vectors; plate text remains display metadata and is never a ranking input.
ALTER TABLE public.capture_assets
    ADD COLUMN IF NOT EXISTS vehicle_embedding BYTEA
        CHECK (vehicle_embedding IS NULL OR octet_length(vehicle_embedding) = 2048),
    ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(80),
    ADD COLUMN IF NOT EXISTS detector_model VARCHAR(80),
    ADD COLUMN IF NOT EXISTS detection_confidence REAL
        CHECK (detection_confidence IS NULL OR detection_confidence BETWEEN 0 AND 1);

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072303_vehicle_reid_embeddings',
    'Add plate-independent OpenVINO vehicle ReID embeddings and detector provenance.'
)
ON CONFLICT (version) DO NOTHING;

-- Vehicle detection now scans the complete source image before any fallback is
-- considered. Preserve explicit operator choices while giving unconfigured
-- cameras a safe full-image fallback and a new profile revision.
ALTER TABLE public.camera_visual_profiles
    ALTER COLUMN crop_mode SET DEFAULT 'full_frame',
    ALTER COLUMN context_percent SET DEFAULT 100;

INSERT INTO public.camera_visual_profiles (
    camera_key, camera_name, crop_mode, context_percent,
    vertical_offset_percent, profile_version
)
SELECT camera_key, camera_name, 'full_frame', 100, 0, 2
FROM (
    SELECT DISTINCT ON (LOWER(BTRIM(camera_name)))
        LOWER(BTRIM(camera_name)) AS camera_key,
        camera_name
    FROM public.plate_reads
    WHERE camera_name IS NOT NULL AND BTRIM(camera_name) <> ''
    ORDER BY LOWER(BTRIM(camera_name)), "timestamp" DESC
) cameras
ON CONFLICT (camera_key) DO NOTHING;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072304_vehicle_detector_fallbacks',
    'Default unconfigured cameras to full-image detector fallback while preserving explicit profiles.'
)
ON CONFLICT (version) DO NOTHING;

-- Human calibration labels are stored against a canonical pair of immutable
-- capture reads and the exact embedding model that produced the score. The
-- row holds the current label while append-only audit_events preserve every
-- label change and its previous value.
CREATE TABLE IF NOT EXISTS public.vehicle_match_feedback (
    id BIGSERIAL PRIMARY KEY,
    read_id_low INTEGER NOT NULL
        REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    read_id_high INTEGER NOT NULL
        REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    embedding_model VARCHAR(80) NOT NULL,
    similarity_score REAL NOT NULL
        CHECK (similarity_score BETWEEN -1 AND 1),
    label VARCHAR(30) NOT NULL
        CHECK (label IN ('same_vehicle', 'different_vehicle')),
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_username VARCHAR(64) NOT NULL,
    actor_display_name VARCHAR(120) NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT vehicle_match_feedback_distinct_pair
        CHECK (read_id_low < read_id_high),
    UNIQUE (read_id_low, read_id_high, embedding_model)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_match_feedback_model_label
    ON public.vehicle_match_feedback (embedding_model, label, updated_at DESC);

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072401_vehicle_match_feedback',
    'Add audited human same/different vehicle labels for local Vehicle ReID calibration.'
)
ON CONFLICT (version) DO NOTHING;

-- Notification operations adds an explicit rule clock, optional quiet hours,
-- and lease-safe scheduled evaluation for camera activity rules. Existing
-- accepted-read rules retain their behavior and remain unscheduled.
ALTER TABLE public.notification_rules
    ADD COLUMN IF NOT EXISTS time_zone VARCHAR(100) NOT NULL DEFAULT 'UTC',
    ADD COLUMN IF NOT EXISTS quiet_hours JSONB NOT NULL DEFAULT '{"enabled":false}'::JSONB,
    ADD COLUMN IF NOT EXISTS evaluation_interval_seconds INTEGER,
    ADD COLUMN IF NOT EXISTS next_evaluation_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS evaluation_locked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS evaluation_locked_by VARCHAR(255);

ALTER TABLE public.notification_rules
    DROP CONSTRAINT IF EXISTS notification_rules_quiet_hours_object;
ALTER TABLE public.notification_rules
    ADD CONSTRAINT notification_rules_quiet_hours_object
        CHECK (jsonb_typeof(quiet_hours) = 'object');
ALTER TABLE public.notification_rules
    DROP CONSTRAINT IF EXISTS notification_rules_evaluation_interval;
ALTER TABLE public.notification_rules
    ADD CONSTRAINT notification_rules_evaluation_interval
        CHECK (evaluation_interval_seconds IS NULL OR
               evaluation_interval_seconds BETWEEN 60 AND 86400);
ALTER TABLE public.notification_rules
    DROP CONSTRAINT IF EXISTS notification_rules_evaluation_lock_state;
ALTER TABLE public.notification_rules
    ADD CONSTRAINT notification_rules_evaluation_lock_state CHECK (
        (evaluation_locked_at IS NULL AND evaluation_locked_by IS NULL) OR
        (evaluation_locked_at IS NOT NULL AND NULLIF(BTRIM(evaluation_locked_by), '') IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_notification_rules_activity_due
    ON public.notification_rules (next_evaluation_at, id)
    WHERE enabled = TRUE AND event_type = 'camera.activity_check';

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072402_notification_operations',
    'Add explicit rule time zones, quiet hours, and lease-safe scheduled camera activity evaluation.'
)
ON CONFLICT (version) DO NOTHING;

-- Administrators can remove disabled rules from the active workspace without
-- breaking immutable execution, delivery, migration, or audit references.
ALTER TABLE public.notification_rules
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by_user_id BIGINT
        REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(100);

ALTER TABLE public.notification_rules
    DROP CONSTRAINT IF EXISTS notification_rules_deleted_state;
ALTER TABLE public.notification_rules
    ADD CONSTRAINT notification_rules_deleted_state CHECK (
        (deleted_at IS NULL AND deletion_reason IS NULL) OR
        (deleted_at IS NOT NULL AND enabled = FALSE AND
         NULLIF(BTRIM(deletion_reason), '') IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_notification_rules_visible
    ON public.notification_rules (enabled DESC, updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;

-- Legacy copies predate explicit rule clocks and inherited the old UTC schema
-- default. Only those tracked migration targets receive the configured local
-- timezone; independently created rules that intentionally use UTC are kept.
UPDATE public.notification_rules rule
SET time_zone = COALESCE(NULLIF(BTRIM(settings.local_timezone), ''), 'America/Denver'),
    quiet_hours = CASE
        WHEN COALESCE(rule.quiet_hours->>'timeZone', rule.quiet_hours->>'time_zone') = 'UTC'
        THEN (rule.quiet_hours - 'time_zone') || jsonb_build_object(
            'timeZone', COALESCE(NULLIF(BTRIM(settings.local_timezone), ''), 'America/Denver')
        )
        ELSE rule.quiet_hours
    END,
    version = rule.version + 1,
    updated_at = CURRENT_TIMESTAMP
FROM public.mqtt_settings settings
WHERE settings.id = 1
  AND rule.time_zone = 'UTC'
  AND EXISTS (
      SELECT 1 FROM public.notification_rule_migrations migration
      WHERE migration.target_rule_id = rule.id
  );

UPDATE public.notification_conditions condition
SET operand = (condition.operand - 'time_zone') || jsonb_build_object(
    'timeZone', COALESCE(NULLIF(BTRIM(settings.local_timezone), ''), 'America/Denver')
)
FROM public.notification_condition_groups condition_group,
     public.notification_rule_migrations migration,
     public.mqtt_settings settings
WHERE settings.id = 1
  AND condition.group_id = condition_group.id
  AND migration.target_rule_id = condition_group.rule_id
  AND condition.condition_type = 'local_time_window'
  AND COALESCE(condition.operand->>'timeZone', condition.operand->>'time_zone') = 'UTC';

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072501_notification_rule_soft_delete',
    'Allow guarded deletion of disabled notification rules and repair inherited UTC defaults on legacy-migrated rules.'
)
ON CONFLICT (version) DO NOTHING;

-- Retention planning now runs outside ingestion. The initial maintenance job
-- is deliberately dry-run only: it records bounded database candidate counts
-- and never deletes rows or files.
CREATE TABLE IF NOT EXISTS public.maintenance_job_state (
    job_name VARCHAR(100) PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    mode VARCHAR(20) NOT NULL DEFAULT 'dry-run',
    status VARCHAR(20) NOT NULL DEFAULT 'idle',
    interval_seconds INTEGER NOT NULL DEFAULT 86400,
    next_run_at TIMESTAMPTZ,
    last_started_at TIMESTAMPTZ,
    last_completed_at TIMESTAMPTZ,
    last_result JSONB,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT maintenance_job_mode CHECK (mode = 'dry-run'),
    CONSTRAINT maintenance_job_status CHECK (status IN ('idle', 'running', 'failed')),
    CONSTRAINT maintenance_job_interval CHECK (interval_seconds BETWEEN 3600 AND 604800),
    CONSTRAINT maintenance_job_result_object CHECK (
        last_result IS NULL OR jsonb_typeof(last_result) = 'object'
    )
);

CREATE INDEX IF NOT EXISTS idx_maintenance_job_due
    ON public.maintenance_job_state (next_run_at, job_name)
    WHERE enabled = TRUE;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072502_retention_maintenance_preview',
    'Move retention planning out of ingestion into a scheduled, single-flight, dry-run-only maintenance worker.'
)
ON CONFLICT (version) DO NOTHING;

-- Read-only storage reconciliation persists resumable traversal state and an
-- exact finding inventory. These tables do not provide any deletion action.
CREATE TABLE IF NOT EXISTS public.storage_reconciliation_runs (
    id BIGSERIAL PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    phase VARCHAR(30) NOT NULL DEFAULT 'filesystem',
    scan_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    max_plate_read_id BIGINT NOT NULL DEFAULT 0,
    max_capture_asset_id BIGINT NOT NULL DEFAULT 0,
    plate_read_cursor BIGINT NOT NULL DEFAULT 0,
    capture_asset_cursor BIGINT NOT NULL DEFAULT 0,
    files_scanned BIGINT NOT NULL DEFAULT 0,
    bytes_scanned BIGINT NOT NULL DEFAULT 0,
    references_checked BIGINT NOT NULL DEFAULT 0,
    recent_files_skipped BIGINT NOT NULL DEFAULT 0,
    skipped_entries BIGINT NOT NULL DEFAULT 0,
    error_count BIGINT NOT NULL DEFAULT 0,
    orphan_files BIGINT NOT NULL DEFAULT 0,
    orphan_bytes BIGINT NOT NULL DEFAULT 0,
    missing_reference_paths BIGINT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT storage_reconciliation_status CHECK (status IN ('running', 'completed', 'failed')),
    CONSTRAINT storage_reconciliation_phase CHECK (
        phase IN ('filesystem', 'plate-reads', 'capture-assets', 'completed')
    ),
    CONSTRAINT storage_reconciliation_counts CHECK (
        max_plate_read_id >= 0 AND max_capture_asset_id >= 0 AND
        plate_read_cursor >= 0 AND capture_asset_cursor >= 0 AND
        files_scanned >= 0 AND bytes_scanned >= 0 AND references_checked >= 0 AND
        recent_files_skipped >= 0 AND skipped_entries >= 0 AND error_count >= 0 AND
        orphan_files >= 0 AND orphan_bytes >= 0 AND missing_reference_paths >= 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_reconciliation_running
    ON public.storage_reconciliation_runs (status)
    WHERE status = 'running';

CREATE TABLE IF NOT EXISTS public.storage_reconciliation_directories (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES public.storage_reconciliation_runs(id) ON DELETE CASCADE,
    relative_path VARCHAR(2048) NOT NULL,
    cursor_name VARCHAR(255),
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (run_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_storage_reconciliation_directories_due
    ON public.storage_reconciliation_directories (run_id, completed, relative_path);

CREATE TABLE IF NOT EXISTS public.storage_reconciliation_items (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES public.storage_reconciliation_runs(id) ON DELETE CASCADE,
    finding_type VARCHAR(30) NOT NULL,
    relative_path VARCHAR(2048) NOT NULL,
    size_bytes BIGINT,
    modified_at TIMESTAMPTZ,
    reference_type VARCHAR(80),
    owner_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT storage_reconciliation_finding_type CHECK (
        finding_type IN ('orphan-file', 'missing-reference')
    ),
    CONSTRAINT storage_reconciliation_item_size CHECK (size_bytes IS NULL OR size_bytes >= 0),
    UNIQUE (run_id, finding_type, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_storage_reconciliation_items_review
    ON public.storage_reconciliation_items (run_id, finding_type, relative_path);

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072503_storage_reconciliation',
    'Add bounded resumable read-only storage reconciliation runs and durable orphan/missing-reference inventory.'
)
ON CONFLICT (version) DO NOTHING;

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

-- Vehicle attributes are immutable per-read model observations. A better
-- future capture adds evidence; it never rewrites an older capture's result.
CREATE TABLE IF NOT EXISTS public.vehicle_attribute_observations (
    id BIGSERIAL PRIMARY KEY,
    read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    attribute_key VARCHAR(40) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('ready', 'unknown', 'failed')),
    attribute_value VARCHAR(120),
    confidence REAL CHECK (confidence BETWEEN 0 AND 1),
    provider VARCHAR(80) NOT NULL,
    model_version VARCHAR(80) NOT NULL,
    raw_result JSONB NOT NULL DEFAULT '{}'::JSONB,
    error_code VARCHAR(80),
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT vehicle_attribute_observation_state CHECK (
        (status = 'ready' AND attribute_value IS NOT NULL AND confidence IS NOT NULL AND error_code IS NULL) OR
        (status = 'unknown' AND attribute_value IS NULL AND error_code IS NULL) OR
        (status = 'failed' AND attribute_value IS NULL AND error_code IS NOT NULL)
    ),
    UNIQUE (read_id, attribute_key, provider, model_version)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_attribute_observations_lookup
    ON public.vehicle_attribute_observations (attribute_key, attribute_value, status, confidence DESC);

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072505_vehicle_attribute_observations',
    'Add per-read vehicle attribute evidence with confidence and provider/model provenance.'
)
ON CONFLICT (version) DO NOTHING;

-- Shadow clusters are candidate groupings, never plate ownership claims.
-- Plate text is retained for review but is not an input to assignment.
CREATE TABLE IF NOT EXISTS public.vehicle_clusters (
    id BIGSERIAL PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'shadow'
        CHECK (status IN ('shadow', 'confirmed', 'retired')),
    representative_read_id INTEGER NOT NULL UNIQUE
        REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    embedding_model VARCHAR(80) NOT NULL,
    algorithm_version VARCHAR(80) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.vehicle_cluster_assignments (
    read_id INTEGER PRIMARY KEY REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    cluster_id BIGINT NOT NULL REFERENCES public.vehicle_clusters(id) ON DELETE CASCADE,
    assignment_status VARCHAR(20) NOT NULL
        CHECK (assignment_status IN ('seed', 'suggested', 'confirmed')),
    similarity REAL CHECK (similarity BETWEEN -1 AND 1),
    similarity_margin REAL CHECK (similarity_margin BETWEEN -2 AND 2),
    embedding_model VARCHAR(80) NOT NULL,
    algorithm_version VARCHAR(80) NOT NULL,
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_username VARCHAR(64),
    actor_display_name VARCHAR(120),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT vehicle_cluster_assignment_evidence CHECK (
        (assignment_status = 'seed' AND similarity IS NULL) OR
        (assignment_status IN ('suggested', 'confirmed') AND similarity IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_cluster_assignments_cluster
    ON public.vehicle_cluster_assignments (cluster_id, assignment_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_cluster_assignments_review
    ON public.vehicle_cluster_assignments (assignment_status, similarity DESC, updated_at DESC)
    WHERE assignment_status = 'suggested';

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072506_vehicle_shadow_clusters',
    'Add reviewable descriptor-only shadow vehicle clusters without plate ownership or mismatch alerts.'
)
ON CONFLICT (version) DO NOTHING;

-- Direction classification is emitted after Vehicle ReID completes, so it has
-- a distinct event type and can be filtered using camera-configured labels.
ALTER TABLE IF EXISTS public.notification_rules
    DROP CONSTRAINT IF EXISTS notification_rules_event_type_check;
ALTER TABLE IF EXISTS public.notification_rules
    ADD CONSTRAINT notification_rules_event_type_check
    CHECK (event_type IN (
        'plate_read.accepted',
        'vehicle.direction_classified',
        'camera.activity_check'
    ));

ALTER TABLE IF EXISTS public.notification_conditions
    DROP CONSTRAINT IF EXISTS notification_conditions_condition_type_check;
ALTER TABLE IF EXISTS public.notification_conditions
    ADD CONSTRAINT notification_conditions_condition_type_check
    CHECK (condition_type IN (
        'always',
        'event_type',
        'plate_match',
        'camera',
        'direction',
        'known_plate',
        'known_name',
        'tag',
        'watchlist',
        'confidence',
        'read_count',
        'local_time_window'
    ));

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072601_vehicle_direction_notifications',
    'Add direction-classified notification events and camera-configured direction conditions.'
)
ON CONFLICT (version) DO NOTHING;

-- A human front/rear review is authoritative even while a camera is still
-- collecting enough samples to classify unlabeled captures. Repair any
-- reviewed rows that an earlier release left in the Unknown state.
WITH orientation_counts AS (
    SELECT camera_key, embedding_model,
           COUNT(*) FILTER (WHERE orientation = 'front') AS front_count,
           COUNT(*) FILTER (WHERE orientation = 'rear') AS rear_count
    FROM public.vehicle_orientation_labels
    GROUP BY camera_key, embedding_model
)
INSERT INTO public.vehicle_direction_observations (
    read_id, camera_key, embedding_model, classifier_version,
    profile_version, status, orientation, orientation_confidence,
    direction_label, sample_counts, evaluated_at
)
SELECT labels.read_id,
       labels.camera_key,
       labels.embedding_model,
       'vehicle-reid-orientation-knn-v1',
       profiles.profile_version,
       'ready',
       labels.orientation,
       1,
       CASE labels.orientation
           WHEN 'front' THEN profiles.front_direction_label
           ELSE profiles.rear_direction_label
       END,
       jsonb_build_object(
           'front', counts.front_count,
           'rear', counts.rear_count
       ),
       CURRENT_TIMESTAMP
FROM public.vehicle_orientation_labels labels
JOIN public.camera_direction_profiles profiles
  ON profiles.camera_key = labels.camera_key
JOIN orientation_counts counts
  ON counts.camera_key = labels.camera_key
 AND counts.embedding_model = labels.embedding_model
WHERE profiles.enabled = TRUE
ON CONFLICT (read_id) DO UPDATE SET
    camera_key = EXCLUDED.camera_key,
    embedding_model = EXCLUDED.embedding_model,
    classifier_version = EXCLUDED.classifier_version,
    profile_version = EXCLUDED.profile_version,
    status = EXCLUDED.status,
    orientation = EXCLUDED.orientation,
    orientation_confidence = EXCLUDED.orientation_confidence,
    direction_label = EXCLUDED.direction_label,
    sample_counts = EXCLUDED.sample_counts,
    evaluated_at = EXCLUDED.evaluated_at;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072602_reviewed_vehicle_direction_truth',
    'Make human-reviewed front/rear labels immediately authoritative and repair older reviewed observations.'
)
ON CONFLICT (version) DO NOTHING;

-- Historical direction work is derived from durable capture assets and is
-- naturally resumable: current observations are skipped, while repeat
-- failures are retained for review instead of blocking the remaining corpus.
CREATE TABLE IF NOT EXISTS public.vehicle_direction_backfill_failures (
    read_id INTEGER PRIMARY KEY REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    embedding_model VARCHAR(80) NOT NULL,
    classifier_version VARCHAR(80) NOT NULL,
    profile_version INTEGER NOT NULL CHECK (profile_version > 0),
    attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
    error_code VARCHAR(80) NOT NULL,
    error_message VARCHAR(500) NOT NULL,
    first_failed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_failed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vehicle_direction_backfill_failures_retry
    ON public.vehicle_direction_backfill_failures (
        embedding_model, classifier_version, profile_version, attempt_count, last_failed_at
    );

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072603_vehicle_direction_backfill',
    'Add paced resumable historical direction backfill with bounded failure tracking.'
)
ON CONFLICT (version) DO NOTHING;

-- Historical re-evaluation is queued separately from ordinary live direction
-- work. Existing observations remain visible until their replacement is ready,
-- and an administrator can pause only the historical queue without delaying
-- newly ingested reads.
CREATE TABLE IF NOT EXISTS public.vehicle_direction_reevaluation_queue (
    read_id INTEGER PRIMARY KEY REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    camera_key VARCHAR(120) NOT NULL,
    requested_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vehicle_direction_reevaluation_queue_order
    ON public.vehicle_direction_reevaluation_queue (requested_at, read_id);

CREATE TABLE IF NOT EXISTS public.vehicle_direction_reevaluation_control (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
    paused BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.vehicle_direction_reevaluation_control (singleton, paused)
VALUES (TRUE, FALSE)
ON CONFLICT (singleton) DO NOTHING;

-- Carry an in-progress re-evaluation from the previous release into the new
-- durable queue. The earlier implementation represented queued work by
-- deleting machine observations, so current missing/outdated rows are the only
-- safe evidence available during this one-time upgrade.
INSERT INTO public.vehicle_direction_reevaluation_queue (read_id, camera_key)
SELECT ca.read_id, LOWER(BTRIM(reads.camera_name))
FROM public.capture_assets ca
JOIN public.plate_reads reads ON reads.id = ca.read_id
LEFT JOIN public.camera_visual_profiles cvp
  ON cvp.camera_key = LOWER(BTRIM(reads.camera_name))
JOIN public.camera_direction_profiles profiles
  ON profiles.camera_key = LOWER(BTRIM(reads.camera_name))
LEFT JOIN public.vehicle_direction_observations observations
  ON observations.read_id = ca.read_id
LEFT JOIN public.vehicle_orientation_labels labels
  ON labels.read_id = ca.read_id
 AND labels.embedding_model = 'vehicle-reid-0001-ir-fp16-v1'
WHERE ca.asset_type = 'vehicle_crop'
  AND ca.algorithm_version = 'vehicle_reid_0001_v1'
  AND ca.status = 'ready'
  AND ca.crop_profile_version = COALESCE(cvp.profile_version, 1)
  AND ca.embedding_model = 'vehicle-reid-0001-ir-fp16-v1'
  AND ca.vehicle_embedding IS NOT NULL
  AND labels.read_id IS NULL
  AND (
    observations.read_id IS NULL OR
    observations.embedding_model IS DISTINCT FROM 'vehicle-reid-0001-ir-fp16-v1' OR
    observations.classifier_version IS DISTINCT FROM 'vehicle-reid-orientation-knn-v1' OR
    observations.profile_version IS DISTINCT FROM profiles.profile_version
  )
ON CONFLICT (read_id) DO NOTHING;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072701_vehicle_direction_reevaluation_queue',
    'Preserve current directions during re-evaluation and add durable pause/resume controls.'
)
ON CONFLICT (version) DO NOTHING;

-- A confirmed shadow-cluster assignment is evidence that a capture belongs to
-- a vehicle, but it is not by itself permission to claim that the vehicle is
-- associated with the capture's effective plate. Keep that second review
-- decision explicit and independently auditable so later mismatch detection
-- can rely only on confirmed baselines.
CREATE TABLE IF NOT EXISTS public.vehicle_plate_associations (
    id BIGSERIAL PRIMARY KEY,
    cluster_id BIGINT NOT NULL REFERENCES public.vehicle_clusters(id) ON DELETE CASCADE,
    plate_number VARCHAR(10) NOT NULL REFERENCES public.plates(plate_number) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'suggested'
        CHECK (status IN ('suggested', 'confirmed', 'rejected')),
    evidence_count INTEGER NOT NULL DEFAULT 1 CHECK (evidence_count > 0),
    confidence REAL CHECK (confidence BETWEEN -1 AND 1),
    first_seen_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_username VARCHAR(64),
    actor_display_name VARCHAR(120),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (cluster_id, plate_number)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_plate_associations_review
    ON public.vehicle_plate_associations (status, updated_at DESC)
    WHERE status = 'suggested';
CREATE INDEX IF NOT EXISTS idx_vehicle_plate_associations_plate
    ON public.vehicle_plate_associations (plate_number, status, updated_at DESC);

-- Preserve earlier human cluster reviews as plate-association suggestions.
-- Effective plate text is review evidence only and never participates in ReID
-- clustering or becomes authoritative without a separate confirmation.
INSERT INTO public.vehicle_plate_associations (
    cluster_id, plate_number, status, evidence_count, confidence,
    first_seen_at, last_seen_at
)
SELECT assignments.cluster_id,
       reads.plate_number,
       'suggested',
       COUNT(*)::INTEGER,
       AVG(assignments.similarity)::REAL,
       MIN(reads."timestamp"),
       MAX(reads."timestamp")
FROM public.vehicle_cluster_assignments assignments
JOIN public.plate_reads reads ON reads.id = assignments.read_id
WHERE assignments.assignment_status = 'confirmed'
GROUP BY assignments.cluster_id, reads.plate_number
ON CONFLICT (cluster_id, plate_number) DO UPDATE SET
    evidence_count = EXCLUDED.evidence_count,
    confidence = EXCLUDED.confidence,
    first_seen_at = EXCLUDED.first_seen_at,
    last_seen_at = EXCLUDED.last_seen_at,
    updated_at = CURRENT_TIMESTAMP;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072702_vehicle_plate_associations',
    'Add explicitly reviewed effective-plate associations as the safe vehicle-profile baseline.'
)
ON CONFLICT (version) DO NOTHING;

-- Editing a disabled notification rule must not erase the action identity
-- retained by delivery history. Keep prior versions as inert historical rows
-- and reserve each position only within the current, non-retired action set.
ALTER TABLE IF EXISTS public.notification_actions
    ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retired_by_user_id BIGINT
        REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.notification_actions
    DROP CONSTRAINT IF EXISTS notification_actions_rule_id_position_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_actions_active_position
    ON public.notification_actions (rule_id, position)
    WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notification_actions_retired
    ON public.notification_actions (rule_id, retired_at, id);

COMMENT ON COLUMN public.notification_actions.retired_at IS
    'Set when an edited rule replaces this action; delivery history continues to reference the retired row.';

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072703_notification_action_history',
    'Preserve delivered notification action identities when disabled rules are edited.'
)
ON CONFLICT (version) DO NOTHING;

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

-- Keep at most one derived Blue Iris vehicle-overview frame per plate read.
-- The source BVR remains in Blue Iris; only the best bounded sample is retained.
ALTER TABLE IF EXISTS public.plate_reads
    ADD COLUMN IF NOT EXISTS vehicle_image_status VARCHAR(20),
    ADD COLUMN IF NOT EXISTS vehicle_image_path TEXT,
    ADD COLUMN IF NOT EXISTS vehicle_image_timestamp TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS vehicle_image_score REAL,
    ADD COLUMN IF NOT EXISTS vehicle_image_detection_confidence REAL,
    ADD COLUMN IF NOT EXISTS vehicle_image_detection_box JSONB,
    ADD COLUMN IF NOT EXISTS vehicle_image_width INTEGER,
    ADD COLUMN IF NOT EXISTS vehicle_image_height INTEGER,
    ADD COLUMN IF NOT EXISTS vehicle_image_sampled_count SMALLINT,
    ADD COLUMN IF NOT EXISTS vehicle_image_error_code VARCHAR(80),
    ADD COLUMN IF NOT EXISTS vehicle_image_retryable BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS vehicle_image_updated_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS public.plate_reads
    DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_status_check;
ALTER TABLE IF EXISTS public.plate_reads
    ADD CONSTRAINT plate_reads_vehicle_image_status_check
    CHECK (vehicle_image_status IS NULL OR vehicle_image_status IN ('pending', 'processing', 'ready', 'unavailable', 'failed'));

CREATE INDEX IF NOT EXISTS idx_plate_reads_vehicle_image_work
    ON public.plate_reads (vehicle_image_status, vehicle_image_retryable, vehicle_image_updated_at, id)
    WHERE vehicle_image_status IS NOT NULL AND vehicle_image_status <> 'ready';

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072801_blue_iris_vehicle_frames',
    'Retain one best derived Blue Iris vehicle-overview frame per ALPR read with terminal retention-aware states.'
)
ON CONFLICT (version) DO NOTHING;

-- New accepted reads are processed automatically while historical work is
-- explicitly queued and can be paused independently. A short processing lease
-- lets work recover safely after an application restart.
ALTER TABLE IF EXISTS public.plate_reads
    ADD COLUMN IF NOT EXISTS vehicle_image_queue_kind VARCHAR(20),
    ADD COLUMN IF NOT EXISTS vehicle_image_attempt_count SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS public.plate_reads
    DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_status_check;
ALTER TABLE IF EXISTS public.plate_reads
    ADD CONSTRAINT plate_reads_vehicle_image_status_check
    CHECK (vehicle_image_status IS NULL OR vehicle_image_status IN ('pending', 'processing', 'ready', 'unavailable', 'failed'));

ALTER TABLE IF EXISTS public.plate_reads
    DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_queue_kind_check;
ALTER TABLE IF EXISTS public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_queue_kind_check
  CHECK (vehicle_image_queue_kind IS NULL OR vehicle_image_queue_kind IN ('live', 'historical', 'manual', 'overview', 'overview_backfill', 'overview_repair'));

CREATE TABLE IF NOT EXISTS public.vehicle_frame_processing_control (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    historical_paused BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.vehicle_frame_processing_control (singleton, historical_paused)
VALUES (TRUE, TRUE)
ON CONFLICT (singleton) DO NOTHING;

DROP INDEX IF EXISTS public.idx_plate_reads_vehicle_image_work;
CREATE INDEX IF NOT EXISTS idx_plate_reads_vehicle_image_work
    ON public.plate_reads (
        vehicle_image_status, vehicle_image_queue_kind,
        vehicle_image_retryable, vehicle_image_updated_at, id
    )
    WHERE vehicle_image_path IS NULL;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072802_blue_iris_vehicle_frame_queue',
    'Automatically process live Blue Iris vehicle frames with durable retries and controlled historical backfill.'
)
ON CONFLICT (version) DO NOTHING;

-- Explain why the quality-aware multiframe selector chose a particular
-- vehicle view without retaining the other sampled images or Blue Iris video.
ALTER TABLE IF EXISTS public.plate_reads
    ADD COLUMN IF NOT EXISTS vehicle_image_selection_metadata JSONB;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072803_blue_iris_vehicle_frame_quality',
    'Record bounded quality, tracking, and timing diagnostics for the selected Blue Iris vehicle frame.'
)
ON CONFLICT (version) DO NOTHING;

-- Phase 1 storage monitoring and guarded maintenance. Automatic cleanup is
-- deliberately disabled and has no approved categories. The only destructive
-- operation represented by this schema is a one-time, confirmed manual run
-- over a frozen preview of reconciliation-confirmed derived-file orphans.
CREATE TABLE IF NOT EXISTS public.storage_maintenance_config (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    warning_percent NUMERIC(5,2) NOT NULL DEFAULT 80,
    critical_percent NUMERIC(5,2) NOT NULL DEFAULT 90,
    check_interval_seconds INTEGER NOT NULL DEFAULT 3600,
    stale_after_seconds INTEGER NOT NULL DEFAULT 10800,
    alert_cooldown_seconds INTEGER NOT NULL DEFAULT 21600,
    email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    email_recipients JSONB NOT NULL DEFAULT '[]'::JSONB,
    webhook_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    webhook_url TEXT,
    cleanup_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    cleanup_interval_seconds INTEGER NOT NULL DEFAULT 86400,
    automatic_categories JSONB NOT NULL DEFAULT '[]'::JSONB,
    orphan_grace_seconds INTEGER NOT NULL DEFAULT 604800,
    updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT storage_maintenance_thresholds CHECK (
        warning_percent >= 1 AND critical_percent <= 99.9 AND warning_percent < critical_percent
    ),
    CONSTRAINT storage_maintenance_intervals CHECK (
        check_interval_seconds BETWEEN 60 AND 86400 AND
        stale_after_seconds BETWEEN 120 AND 604800 AND
        alert_cooldown_seconds BETWEEN 300 AND 2592000 AND
        cleanup_interval_seconds BETWEEN 3600 AND 604800 AND
        orphan_grace_seconds BETWEEN 86400 AND 31536000
    ),
    CONSTRAINT storage_maintenance_email_recipients_array CHECK (
        jsonb_typeof(email_recipients) = 'array'
    ),
    CONSTRAINT storage_maintenance_automatic_categories_empty CHECK (
        automatic_categories = '[]'::JSONB
    )
);

INSERT INTO public.storage_maintenance_config (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.maintenance_runtime_state (
    runtime_name VARCHAR(100) PRIMARY KEY,
    worker_id VARCHAR(255),
    started_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.maintenance_runs (
    id BIGSERIAL PRIMARY KEY,
    job_name VARCHAR(100) NOT NULL,
    trigger_type VARCHAR(20) NOT NULL CHECK (trigger_type IN ('scheduled', 'manual')),
    mode VARCHAR(20) NOT NULL CHECK (mode IN ('preview', 'execute', 'measure')),
    status VARCHAR(20) NOT NULL CHECK (
        status IN ('previewed', 'queued', 'running', 'completed', 'failed', 'cancelled')
    ),
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    preview_run_id BIGINT REFERENCES public.maintenance_runs(id) ON DELETE RESTRICT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
    candidate_count BIGINT NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    candidate_bytes BIGINT NOT NULL DEFAULT 0 CHECK (candidate_bytes >= 0),
    reclaimed_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reclaimed_bytes >= 0),
    failure_count BIGINT NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    last_error TEXT,
    configuration JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(configuration) = 'object'),
    result JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(result) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_maintenance_runs_job_activity
    ON public.maintenance_runs (job_name, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.maintenance_cleanup_items (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES public.maintenance_runs(id) ON DELETE CASCADE,
    relative_path VARCHAR(2048) NOT NULL,
    category VARCHAR(30) NOT NULL CHECK (category = 'derived'),
    observed_size_bytes BIGINT NOT NULL CHECK (observed_size_bytes >= 0),
    observed_modified_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'candidate' CHECK (
        status IN (
            'candidate', 'deleted', 'skipped-missing', 'skipped-changed',
            'skipped-referenced', 'skipped-unsafe', 'failed'
        )
    ),
    reclaimed_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reclaimed_bytes >= 0),
    error TEXT,
    completed_at TIMESTAMPTZ,
    UNIQUE (run_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_cleanup_items_run
    ON public.maintenance_cleanup_items (run_id, status, id);

CREATE TABLE IF NOT EXISTS public.maintenance_cleanup_tokens (
    token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    preview_run_id BIGINT NOT NULL UNIQUE REFERENCES public.maintenance_runs(id) ON DELETE CASCADE,
    confirmation_phrase VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT maintenance_cleanup_token_lifecycle CHECK (
        consumed_at IS NULL OR consumed_at >= created_at
    )
);

CREATE TABLE IF NOT EXISTS public.storage_measurements (
    id BIGSERIAL PRIMARY KEY,
    measured_at TIMESTAMPTZ NOT NULL,
    filesystem_total_bytes BIGINT,
    filesystem_used_bytes BIGINT,
    filesystem_available_bytes BIGINT,
    filesystem_used_percent NUMERIC(5,2),
    source_image_bytes BIGINT,
    source_image_count BIGINT,
    thumbnail_bytes BIGINT,
    thumbnail_count BIGINT,
    derived_vehicle_image_bytes BIGINT,
    derived_vehicle_image_count BIGINT,
    database_bytes BIGINT,
    docker_bytes BIGINT,
    backup_bytes BIGINT,
    host_snapshot_measured_at TIMESTAMPTZ,
    errors JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(errors) = 'array'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT storage_measurements_nonnegative CHECK (
        COALESCE(filesystem_total_bytes, 0) >= 0 AND
        COALESCE(filesystem_used_bytes, 0) >= 0 AND
        COALESCE(filesystem_available_bytes, 0) >= 0 AND
        COALESCE(source_image_bytes, 0) >= 0 AND COALESCE(source_image_count, 0) >= 0 AND
        COALESCE(thumbnail_bytes, 0) >= 0 AND COALESCE(thumbnail_count, 0) >= 0 AND
        COALESCE(derived_vehicle_image_bytes, 0) >= 0 AND COALESCE(derived_vehicle_image_count, 0) >= 0 AND
        COALESCE(database_bytes, 0) >= 0 AND COALESCE(docker_bytes, 0) >= 0 AND
        COALESCE(backup_bytes, 0) >= 0
    )
);

CREATE INDEX IF NOT EXISTS idx_storage_measurements_recent
    ON public.storage_measurements (measured_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.maintenance_alert_state (
    event_key VARCHAR(255) PRIMARY KEY,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('ok', 'warning', 'critical')),
    fingerprint CHAR(64),
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_notified_at TIMESTAMPTZ,
    next_eligible_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    occurrence_count BIGINT NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
    suppressed_count BIGINT NOT NULL DEFAULT 0 CHECK (suppressed_count >= 0),
    details JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(details) = 'object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.maintenance_alert_deliveries (
    id BIGSERIAL PRIMARY KEY,
    dedupe_key CHAR(64) NOT NULL UNIQUE CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
    event_key VARCHAR(255) NOT NULL REFERENCES public.maintenance_alert_state(event_key) ON DELETE CASCADE,
    channel_type VARCHAR(20) NOT NULL CHECK (channel_type IN ('email', 'webhook')),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(payload) = 'object'),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'retry', 'succeeded', 'dead')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(255),
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT maintenance_alert_delivery_lock CHECK (
        (status = 'processing' AND locked_at IS NOT NULL AND NULLIF(BTRIM(locked_by), '') IS NOT NULL)
        OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_maintenance_alert_deliveries_due
    ON public.maintenance_alert_deliveries (next_attempt_at, id)
    WHERE status IN ('pending', 'retry');

-- Maintenance webhook destination URLs can contain bearer credentials. Keep
-- them only in storage_maintenance_config; workers resolve the current value
-- immediately before delivery. This idempotently removes legacy queue copies
-- and destination-bearing error details without changing delivery status.
UPDATE public.maintenance_alert_deliveries
SET payload = payload - 'url',
    last_error = CASE WHEN last_error IS NULL THEN NULL
        ELSE 'Maintenance webhook delivery error details were redacted' END,
    updated_at = CURRENT_TIMESTAMP
WHERE channel_type = 'webhook'
  AND (payload ? 'url' OR last_error IS NOT NULL);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_attribute column_record
          ON column_record.attrelid = constraint_record.conrelid
         AND column_record.attnum = ANY (constraint_record.conkey)
        WHERE constraint_record.contype = 'f'
          AND constraint_record.conrelid = 'public.storage_maintenance_config'::regclass
          AND column_record.attname = 'updated_by_user_id'
    ) THEN
        ALTER TABLE public.storage_maintenance_config
            ADD CONSTRAINT storage_maintenance_config_updated_by_fkey
            FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_attribute column_record
          ON column_record.attrelid = constraint_record.conrelid
         AND column_record.attnum = ANY (constraint_record.conkey)
        WHERE constraint_record.contype = 'f'
          AND constraint_record.conrelid = 'public.maintenance_runs'::regclass
          AND column_record.attname = 'actor_user_id'
    ) THEN
        ALTER TABLE public.maintenance_runs
            ADD CONSTRAINT maintenance_runs_actor_user_fkey
            FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END;
$$;

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072901_storage_monitoring_maintenance',
    'Add persisted storage thresholds, runtime liveness, exact category measurements, rate-limited maintenance alerts, and token-guarded manual derived-orphan cleanup.'
)
ON CONFLICT (version) DO NOTHING;

-- Phase 2A: separately approved, bounded automatic cleanup for derived
-- orphans only. Approval history is append-only and defaults to no rows/off.
INSERT INTO public.permissions (permission_key, description)
VALUES (
    'maintenance.automatic_cleanup.approve',
    'Approve, suspend, or acknowledge automatic derived-orphan cleanup.'
)
ON CONFLICT (permission_key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM public.roles AS role
CROSS JOIN public.permissions AS permission
WHERE role.name = 'administrator'
  AND permission.permission_key = 'maintenance.automatic_cleanup.approve'
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.storage_cleanup_automatic_approvals (
    id BIGSERIAL PRIMARY KEY,
    category VARCHAR(40) NOT NULL CHECK (category = 'derived-orphans'),
    revision BIGINT NOT NULL CHECK (revision > 0),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    interval_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (interval_seconds BETWEEN 86400 AND 604800),
    grace_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (grace_seconds BETWEEN 604800 AND 31536000),
    actor_user_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (category, revision),
    CONSTRAINT storage_cleanup_approval_actor_fkey
        FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.storage_cleanup_automatic_state (
    category VARCHAR(40) PRIMARY KEY CHECK (category = 'derived-orphans'),
    next_run_at TIMESTAMPTZ,
    last_run_id BIGINT REFERENCES public.maintenance_runs(id) ON DELETE SET NULL,
    source_reconciliation_run_id BIGINT,
    circuit_breaker_open BOOLEAN NOT NULL DEFAULT FALSE,
    circuit_breaker_opened_at TIMESTAMPTZ,
    circuit_breaker_reason TEXT,
    circuit_breaker_run_id BIGINT REFERENCES public.maintenance_runs(id) ON DELETE SET NULL,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by_user_id BIGINT,
    acknowledged_run_id BIGINT,
    acknowledgement_reconciliation_run_id BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT storage_cleanup_state_ack_actor_fkey
        FOREIGN KEY (acknowledged_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT storage_cleanup_breaker_state CHECK (
        (circuit_breaker_open AND circuit_breaker_opened_at IS NOT NULL AND circuit_breaker_reason IS NOT NULL)
        OR (NOT circuit_breaker_open)
    ),
    CONSTRAINT storage_cleanup_ack_evidence CHECK (
        (acknowledged_at IS NULL AND acknowledged_run_id IS NULL AND acknowledgement_reconciliation_run_id IS NULL)
        OR (acknowledged_at IS NOT NULL AND acknowledged_run_id IS NOT NULL AND acknowledgement_reconciliation_run_id IS NOT NULL)
    )
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_approval_actor_fkey'
          AND conrelid = 'public.storage_cleanup_automatic_approvals'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_approvals
            ADD CONSTRAINT storage_cleanup_approval_actor_fkey
            FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_state_ack_actor_fkey'
          AND conrelid = 'public.storage_cleanup_automatic_state'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_state
            ADD CONSTRAINT storage_cleanup_state_ack_actor_fkey
            FOREIGN KEY (acknowledged_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END;
$$;

ALTER TABLE public.maintenance_runs
    ADD COLUMN IF NOT EXISTS source_reconciliation_run_id BIGINT;
ALTER TABLE public.storage_cleanup_automatic_state
    ADD COLUMN IF NOT EXISTS acknowledged_run_id BIGINT;
ALTER TABLE public.storage_cleanup_automatic_state
    ADD COLUMN IF NOT EXISTS acknowledgement_reconciliation_run_id BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_ack_evidence'
          AND conrelid = 'public.storage_cleanup_automatic_state'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_state
            ADD CONSTRAINT storage_cleanup_ack_evidence CHECK (
                (acknowledged_at IS NULL AND acknowledged_run_id IS NULL AND acknowledgement_reconciliation_run_id IS NULL)
                OR (acknowledged_at IS NOT NULL AND acknowledged_run_id IS NOT NULL AND acknowledgement_reconciliation_run_id IS NOT NULL)
            );
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'maintenance_runs_source_reconciliation_fkey'
          AND conrelid = 'public.maintenance_runs'::regclass
    ) THEN
        ALTER TABLE public.maintenance_runs
            ADD CONSTRAINT maintenance_runs_source_reconciliation_fkey
            FOREIGN KEY (source_reconciliation_run_id)
            REFERENCES public.storage_reconciliation_runs(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_state_source_reconciliation_fkey'
          AND conrelid = 'public.storage_cleanup_automatic_state'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_state
            ADD CONSTRAINT storage_cleanup_state_source_reconciliation_fkey
            FOREIGN KEY (source_reconciliation_run_id)
            REFERENCES public.storage_reconciliation_runs(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_state_acknowledged_run_fkey'
          AND conrelid = 'public.storage_cleanup_automatic_state'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_state
            ADD CONSTRAINT storage_cleanup_state_acknowledged_run_fkey
            FOREIGN KEY (acknowledged_run_id)
            REFERENCES public.maintenance_runs(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'storage_cleanup_state_ack_reconciliation_fkey'
          AND conrelid = 'public.storage_cleanup_automatic_state'::regclass
    ) THEN
        ALTER TABLE public.storage_cleanup_automatic_state
            ADD CONSTRAINT storage_cleanup_state_ack_reconciliation_fkey
            FOREIGN KEY (acknowledgement_reconciliation_run_id)
            REFERENCES public.storage_reconciliation_runs(id) ON DELETE RESTRICT;
    END IF;
END;
$$;

ALTER TABLE public.maintenance_cleanup_items
    DROP CONSTRAINT IF EXISTS maintenance_cleanup_items_status_check;
ALTER TABLE public.maintenance_cleanup_items
    ADD CONSTRAINT maintenance_cleanup_items_status_check CHECK (
        status IN (
            'candidate', 'deleted', 'skipped-missing', 'skipped-changed',
            'skipped-referenced', 'skipped-unsafe', 'skipped-limit', 'failed'
        )
    );

INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072902_automatic_derived_orphan_cleanup',
    'Add Administrator-only, revisioned and default-off automatic derived-orphan cleanup approval and circuit-breaker state.'
)
ON CONFLICT (version) DO NOTHING;

-- Phase 3 is a fail-closed database control plane. Only the separately installed
-- fixed host worker can inspect or remove host artifacts.
CREATE TABLE IF NOT EXISTS public.host_maintenance_config (
    category VARCHAR(40) PRIMARY KEY CHECK (category IN ('docker-build-cache', 'unused-alpr-images', 'rollout-backups')),
    automation_supported BOOLEAN NOT NULL DEFAULT TRUE,
    scheduled_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    interval_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (interval_seconds BETWEEN 86400 AND 2592000),
    retained_verified_count INTEGER NOT NULL DEFAULT 5 CHECK (retained_verified_count BETWEEN 5 AND 50),
    minimum_age_days INTEGER NOT NULL DEFAULT 30 CHECK (minimum_age_days BETWEEN 1 AND 365),
    next_run_at TIMESTAMPTZ,
    activation_revision BIGINT NOT NULL DEFAULT 0 CHECK (activation_revision >= 0),
    activated_at TIMESTAMPTZ, activated_by_user_id BIGINT,
    circuit_breaker_open BOOLEAN NOT NULL DEFAULT FALSE,
    circuit_breaker_opened_at TIMESTAMPTZ, circuit_breaker_reason TEXT,
    circuit_breaker_generation BIGINT NOT NULL DEFAULT 0 CHECK (circuit_breaker_generation >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO public.host_maintenance_config (category, automation_supported, minimum_age_days) VALUES
 ('docker-build-cache', TRUE, 7), ('unused-alpr-images', FALSE, 7), ('rollout-backups', TRUE, 30)
ON CONFLICT (category) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.host_maintenance_environment_identity (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), environment_id VARCHAR(200) NOT NULL,
 database_identity VARCHAR(200) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(environment_id,database_identity)
);

CREATE TABLE IF NOT EXISTS public.host_maintenance_intents (
 id BIGSERIAL PRIMARY KEY, intent_type VARCHAR(20) NOT NULL CHECK (intent_type IN ('preview','execute','scheduled')),
 category VARCHAR(40) NOT NULL CHECK (category IN ('docker-build-cache','unused-alpr-images','rollout-backups')),
 environment_id VARCHAR(200) NOT NULL,
 database_identity VARCHAR(200) NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','cancelled')),
 actor_user_id BIGINT, preview_intent_id BIGINT REFERENCES public.host_maintenance_intents(id) ON DELETE RESTRICT,
 run_id BIGINT REFERENCES public.maintenance_runs(id) ON DELETE SET NULL, locked_at TIMESTAMPTZ, locked_by VARCHAR(255),
 requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
 inventory_revision VARCHAR(200), inventory_measured_at TIMESTAMPTZ,
 candidate_count BIGINT NOT NULL DEFAULT 0 CHECK(candidate_count>=0), candidate_bytes BIGINT NOT NULL DEFAULT 0 CHECK(candidate_bytes>=0),
 reclaimed_bytes BIGINT NOT NULL DEFAULT 0 CHECK(reclaimed_bytes>=0), last_error TEXT,
 receipt JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(receipt)='object'), updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(id,category), UNIQUE(id,category,actor_user_id), UNIQUE(id,category,environment_id,database_identity)
);
CREATE INDEX IF NOT EXISTS idx_host_maintenance_intents_due ON public.host_maintenance_intents(status,requested_at,id);

CREATE TABLE IF NOT EXISTS public.host_maintenance_approvals (
 id BIGSERIAL PRIMARY KEY, category VARCHAR(40) NOT NULL REFERENCES public.host_maintenance_config(category) ON DELETE RESTRICT,
 revision BIGINT NOT NULL CHECK(revision>0), enabled BOOLEAN NOT NULL, interval_seconds INTEGER NOT NULL,
 retained_verified_count INTEGER NOT NULL, minimum_age_days INTEGER NOT NULL, actor_user_id BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(category,revision)
);
CREATE TABLE IF NOT EXISTS public.host_maintenance_previews (
 id BIGSERIAL PRIMARY KEY, intent_id BIGINT NOT NULL UNIQUE REFERENCES public.host_maintenance_intents(id) ON DELETE RESTRICT,
 category VARCHAR(40) NOT NULL REFERENCES public.host_maintenance_config(category) ON DELETE RESTRICT, actor_user_id BIGINT NOT NULL,
 token_hash CHAR(64) NOT NULL UNIQUE CHECK(token_hash~'^[0-9a-f]{64}$'), environment_id VARCHAR(200) NOT NULL,
 database_identity VARCHAR(200) NOT NULL,
 policy_revision BIGINT NOT NULL, worker_generation VARCHAR(200) NOT NULL, inventory_revision VARCHAR(200) NOT NULL,
 candidate_set_hash CHAR(64) NOT NULL CHECK(candidate_set_hash~'^[0-9a-f]{64}$'), inventory_measured_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, candidate_count BIGINT NOT NULL CHECK(candidate_count>=0), candidate_bytes BIGINT NOT NULL CHECK(candidate_bytes>=0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT host_maintenance_preview_intent_binding_fkey FOREIGN KEY(intent_id,category,actor_user_id)
  REFERENCES public.host_maintenance_intents(id,category,actor_user_id) ON DELETE RESTRICT,
 CONSTRAINT host_maintenance_preview_environment_binding_fkey FOREIGN KEY(intent_id,category,environment_id,database_identity)
  REFERENCES public.host_maintenance_intents(id,category,environment_id,database_identity) ON DELETE RESTRICT
);
-- Plaintext tokens are ephemeral here and atomically DELETE ... RETURNING once; previews remain fully immutable.
CREATE TABLE IF NOT EXISTS public.host_maintenance_preview_deliveries (
 preview_id BIGINT PRIMARY KEY REFERENCES public.host_maintenance_previews(id) ON DELETE CASCADE,
 opaque_token VARCHAR(128) NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS public.host_maintenance_preview_items (
 id BIGSERIAL PRIMARY KEY, preview_id BIGINT NOT NULL REFERENCES public.host_maintenance_previews(id) ON DELETE RESTRICT,
 artifact_kind VARCHAR(40) NOT NULL CHECK(artifact_kind IN ('docker-build-cache','rollout-backup','unused-alpr-image')),
 opaque_id VARCHAR(200) NOT NULL, identity VARCHAR(200) NOT NULL, bytes BIGINT NOT NULL CHECK(bytes>=0),
 evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(evidence)='object'), UNIQUE(preview_id,artifact_kind,opaque_id)
);
CREATE TABLE IF NOT EXISTS public.host_maintenance_preview_consumptions (
 preview_id BIGINT PRIMARY KEY REFERENCES public.host_maintenance_previews(id) ON DELETE RESTRICT,
 execution_intent_id BIGINT NOT NULL UNIQUE REFERENCES public.host_maintenance_intents(id) ON DELETE RESTRICT,
 actor_user_id BIGINT NOT NULL, consumed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS public.host_maintenance_receipts (
 id BIGSERIAL PRIMARY KEY, intent_id BIGINT NOT NULL UNIQUE REFERENCES public.host_maintenance_intents(id) ON DELETE RESTRICT,
 category VARCHAR(40) NOT NULL REFERENCES public.host_maintenance_config(category) ON DELETE RESTRICT,
 environment_id VARCHAR(200) NOT NULL, database_identity VARCHAR(200) NOT NULL, worker_generation VARCHAR(200) NOT NULL, inventory_revision VARCHAR(200) NOT NULL,
 candidate_set_hash CHAR(64) NOT NULL CHECK(candidate_set_hash~'^[0-9a-f]{64}$'), success BOOLEAN NOT NULL,
 reclaimed_bytes BIGINT NOT NULL DEFAULT 0 CHECK(reclaimed_bytes>=0), result JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(result)='object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT host_maintenance_receipt_intent_binding_fkey FOREIGN KEY(intent_id,category,environment_id,database_identity)
  REFERENCES public.host_maintenance_intents(id,category,environment_id,database_identity) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS public.host_maintenance_receipt_items (
 id BIGSERIAL PRIMARY KEY, receipt_id BIGINT NOT NULL REFERENCES public.host_maintenance_receipts(id) ON DELETE RESTRICT,
 artifact_kind VARCHAR(40) NOT NULL CHECK(artifact_kind IN ('docker-build-cache','rollout-backup','unused-alpr-image')),
 opaque_id VARCHAR(200) NOT NULL, identity VARCHAR(200) NOT NULL, status VARCHAR(20) NOT NULL CHECK(status IN ('deleted','quarantined','skipped','failed')),
 reclaimed_bytes BIGINT NOT NULL DEFAULT 0 CHECK(reclaimed_bytes>=0), error TEXT, UNIQUE(receipt_id,artifact_kind,opaque_id)
);
CREATE TABLE IF NOT EXISTS public.host_maintenance_acknowledgements (
 id BIGSERIAL PRIMARY KEY, category VARCHAR(40) NOT NULL REFERENCES public.host_maintenance_config(category) ON DELETE RESTRICT,
 breaker_generation BIGINT NOT NULL CHECK(breaker_generation>0), failed_intent_id BIGINT NOT NULL REFERENCES public.host_maintenance_intents(id) ON DELETE RESTRICT,
 actor_user_id BIGINT NOT NULL, evidence JSONB NOT NULL CHECK(jsonb_typeof(evidence)='object'), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(category,breaker_generation)
);
CREATE TABLE IF NOT EXISTS public.host_maintenance_worker_state (
 environment_id VARCHAR(200) PRIMARY KEY, database_identity VARCHAR(200) NOT NULL, worker_generation VARCHAR(200) NOT NULL, worker_id VARCHAR(255) NOT NULL,
 heartbeat_at TIMESTAMPTZ NOT NULL, inventory_revision VARCHAR(200) NOT NULL, inventory_measured_at TIMESTAMPTZ NOT NULL,
 last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION public.reject_host_maintenance_evidence_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'host maintenance evidence is append-only'; END; $$;
CREATE OR REPLACE FUNCTION public.validate_host_maintenance_evidence_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE bound_category TEXT; BEGIN
 IF TG_TABLE_NAME='host_maintenance_preview_items' THEN SELECT category INTO bound_category FROM public.host_maintenance_previews WHERE id=NEW.preview_id;
 ELSIF TG_TABLE_NAME='host_maintenance_receipt_items' THEN SELECT category INTO bound_category FROM public.host_maintenance_receipts WHERE id=NEW.receipt_id;
 ELSIF TG_TABLE_NAME='host_maintenance_acknowledgements' THEN SELECT category INTO bound_category FROM public.host_maintenance_intents WHERE id=NEW.failed_intent_id;
  IF bound_category IS DISTINCT FROM NEW.category THEN RAISE EXCEPTION 'host acknowledgement category mismatch'; END IF; RETURN NEW;
 ELSE PERFORM 1 FROM public.host_maintenance_previews p JOIN public.host_maintenance_intents i ON i.id=NEW.execution_intent_id
  WHERE p.id=NEW.preview_id AND p.actor_user_id=NEW.actor_user_id AND i.actor_user_id=NEW.actor_user_id AND i.category=p.category
    AND i.environment_id=p.environment_id AND i.database_identity=p.database_identity;
  IF NOT FOUND THEN RAISE EXCEPTION 'host preview consumption binding mismatch'; END IF; RETURN NEW; END IF;
 IF (bound_category='docker-build-cache' AND NEW.artifact_kind<>'docker-build-cache') OR
    (bound_category='unused-alpr-images' AND NEW.artifact_kind<>'unused-alpr-image') OR
    (bound_category='rollout-backups' AND NEW.artifact_kind<>'rollout-backup') THEN RAISE EXCEPTION 'host artifact category mismatch'; END IF;
 RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS host_maintenance_preview_item_binding ON public.host_maintenance_preview_items;
CREATE TRIGGER host_maintenance_preview_item_binding BEFORE INSERT ON public.host_maintenance_preview_items FOR EACH ROW EXECUTE FUNCTION public.validate_host_maintenance_evidence_binding();
DROP TRIGGER IF EXISTS host_maintenance_consumption_binding ON public.host_maintenance_preview_consumptions;
CREATE TRIGGER host_maintenance_consumption_binding BEFORE INSERT ON public.host_maintenance_preview_consumptions FOR EACH ROW EXECUTE FUNCTION public.validate_host_maintenance_evidence_binding();
DROP TRIGGER IF EXISTS host_maintenance_receipt_item_binding ON public.host_maintenance_receipt_items;
CREATE TRIGGER host_maintenance_receipt_item_binding BEFORE INSERT ON public.host_maintenance_receipt_items FOR EACH ROW EXECUTE FUNCTION public.validate_host_maintenance_evidence_binding();
DROP TRIGGER IF EXISTS host_maintenance_ack_binding ON public.host_maintenance_acknowledgements;
CREATE TRIGGER host_maintenance_ack_binding BEFORE INSERT ON public.host_maintenance_acknowledgements FOR EACH ROW EXECUTE FUNCTION public.validate_host_maintenance_evidence_binding();
DO $$ DECLARE table_name TEXT; BEGIN
 FOREACH table_name IN ARRAY ARRAY['host_maintenance_environment_identity','host_maintenance_approvals','host_maintenance_previews','host_maintenance_preview_items',
  'host_maintenance_preview_consumptions','host_maintenance_receipts','host_maintenance_receipt_items','host_maintenance_acknowledgements'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS host_maintenance_append_only ON public.%I',table_name);
  EXECUTE format('CREATE TRIGGER host_maintenance_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_host_maintenance_evidence_mutation()',table_name);
 END LOOP;
END $$;

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='host_maintenance_config_actor_fkey' AND conrelid='public.host_maintenance_config'::regclass) THEN ALTER TABLE public.host_maintenance_config ADD CONSTRAINT host_maintenance_config_actor_fkey FOREIGN KEY(activated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='host_maintenance_intent_actor_fkey' AND conrelid='public.host_maintenance_intents'::regclass) THEN ALTER TABLE public.host_maintenance_intents ADD CONSTRAINT host_maintenance_intent_actor_fkey FOREIGN KEY(actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='host_maintenance_approval_actor_fkey' AND conrelid='public.host_maintenance_approvals'::regclass) THEN ALTER TABLE public.host_maintenance_approvals ADD CONSTRAINT host_maintenance_approval_actor_fkey FOREIGN KEY(actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='host_maintenance_preview_actor_fkey' AND conrelid='public.host_maintenance_previews'::regclass) THEN ALTER TABLE public.host_maintenance_previews ADD CONSTRAINT host_maintenance_preview_actor_fkey FOREIGN KEY(actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='host_maintenance_consumption_actor_fkey' AND conrelid='public.host_maintenance_preview_consumptions'::regclass) THEN ALTER TABLE public.host_maintenance_preview_consumptions ADD CONSTRAINT host_maintenance_consumption_actor_fkey FOREIGN KEY(actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='host_maintenance_ack_actor_fkey' AND conrelid='public.host_maintenance_acknowledgements'::regclass) THEN ALTER TABLE public.host_maintenance_acknowledgements ADD CONSTRAINT host_maintenance_ack_actor_fkey FOREIGN KEY(actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT; END IF;
END $$;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026072903_host_retention_intents','Add three-boundary, default-off host-maintenance intent/immutable preview/receipt control plane.')
ON CONFLICT(version) DO NOTHING;

-- Manual database backup is deliberately separate from retention intents: it
-- accepts no path, command, schedule, or restore input from the application.
ALTER TABLE public.host_maintenance_worker_state
  ADD COLUMN IF NOT EXISTS database_backup_capability VARCHAR(80)
  CHECK(database_backup_capability IS NULL OR database_backup_capability='database-backup-create-v1');
ALTER TABLE public.host_maintenance_worker_state
  ADD COLUMN IF NOT EXISTS database_backup_capability_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.host_database_backup_requests (
 id BIGSERIAL PRIMARY KEY,
 environment_id VARCHAR(200) NOT NULL,
 database_identity VARCHAR(200) NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
 actor_user_id BIGINT,
 requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 started_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ,
 locked_at TIMESTAMPTZ,
 locked_by VARCHAR(255),
 worker_generation VARCHAR(200),
 replay_count INTEGER NOT NULL DEFAULT 0 CHECK(replay_count BETWEEN 0 AND 2),
 filename VARCHAR(255) CHECK(filename IS NULL OR filename~'^alpr-postgres-[0-9]{8}T[0-9]{6}Z-[0-9]+[.]dump$'),
 size_bytes BIGINT CHECK(size_bytes IS NULL OR size_bytes>0),
 checksum_sha256 CHAR(64) CHECK(checksum_sha256 IS NULL OR checksum_sha256~'^[0-9a-f]{64}$'),
 verified BOOLEAN NOT NULL DEFAULT FALSE,
 last_error TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$
BEGIN
 IF NOT EXISTS (
  SELECT 1
  FROM pg_constraint
  WHERE conname = 'host_database_backup_requests_actor_user_id_fkey'
    AND conrelid = 'public.host_database_backup_requests'::regclass
 ) THEN
  ALTER TABLE public.host_database_backup_requests
   ADD CONSTRAINT host_database_backup_requests_actor_user_id_fkey
   FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
 END IF;
END $$;
ALTER TABLE public.host_database_backup_requests
 ADD COLUMN IF NOT EXISTS replay_count INTEGER NOT NULL DEFAULT 0 CHECK(replay_count BETWEEN 0 AND 2);
CREATE INDEX IF NOT EXISTS idx_host_database_backup_requests_due
 ON public.host_database_backup_requests(status,requested_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_database_backup_requests_one_active
 ON public.host_database_backup_requests(environment_id,database_identity)
 WHERE status IN ('pending','processing');

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026073001_manual_database_backup','Add a fixed no-input manual database-backup request and status control plane.')
ON CONFLICT(version) DO NOTHING;

-- Image retirement remains manual-only, but its post-retirement recovery
-- window is administrator-configurable from one to 365 days. Seven days stays
-- the default. The fixed worker revalidates the same persisted value.
ALTER TABLE public.host_maintenance_config
 DROP CONSTRAINT IF EXISTS host_maintenance_config_minimum_age_days_check;
ALTER TABLE public.host_maintenance_config
 ADD CONSTRAINT host_maintenance_config_minimum_age_days_check
 CHECK (minimum_age_days BETWEEN 1 AND 365);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080301_configurable_image_retirement_grace','Allow an audited 1-365 day manual image-retirement grace while retaining a seven-day default.')
ON CONFLICT(version) DO NOTHING;

-- Persist the worker's validated, path-free rollback-backup inventory as
-- append-only read-only evidence. Rollback-backup execution and scheduling are
-- explicitly disabled until a later migration adds catalog-bound approval.
UPDATE public.host_maintenance_config
 SET automation_supported=FALSE,scheduled_enabled=FALSE,next_run_at=NULL,updated_at=CURRENT_TIMESTAMP
 WHERE category='rollout-backups';

CREATE TABLE IF NOT EXISTS public.host_backup_catalog_snapshots (
 id BIGSERIAL PRIMARY KEY,
 catalog_version VARCHAR(80) NOT NULL CHECK(catalog_version='host-backup-catalog-v1'),
 environment_id VARCHAR(200) NOT NULL,database_identity VARCHAR(200) NOT NULL,worker_generation VARCHAR(200) NOT NULL,
 inventory_revision VARCHAR(200) NOT NULL,catalog_revision CHAR(64) NOT NULL CHECK(catalog_revision~'^[0-9a-f]{64}$'),
 inventory_measured_at TIMESTAMPTZ NOT NULL,catalog_complete BOOLEAN NOT NULL,release_ledger_complete BOOLEAN NOT NULL,
 authoritative_current_release_count INTEGER NOT NULL CHECK(authoritative_current_release_count>=0),
 backup_restore_lease BOOLEAN NOT NULL,build_lease BOOLEAN NOT NULL,deploy_lease BOOLEAN NOT NULL,rollback_lease BOOLEAN NOT NULL,
 backup_count BIGINT NOT NULL CHECK(backup_count>=0),backup_bytes BIGINT NOT NULL CHECK(backup_bytes>=0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(environment_id,database_identity,inventory_revision,catalog_revision),
 CONSTRAINT host_backup_catalog_environment_fkey FOREIGN KEY(environment_id,database_identity)
  REFERENCES public.host_maintenance_environment_identity(environment_id,database_identity) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.host_backup_catalog_entries (
 id BIGSERIAL PRIMARY KEY,snapshot_id BIGINT NOT NULL REFERENCES public.host_backup_catalog_snapshots(id) ON DELETE RESTRICT,
 opaque_id VARCHAR(200) NOT NULL,identity VARCHAR(200) NOT NULL,bytes BIGINT NOT NULL CHECK(bytes>=0),backup_created_at TIMESTAMPTZ NOT NULL,
 checksum_verified BOOLEAN NOT NULL,checksum_sha256 CHAR(64) CHECK(checksum_sha256 IS NULL OR checksum_sha256~'^[0-9a-f]{64}$'),
 explicitly_protected BOOLEAN NOT NULL,current_release BOOLEAN NOT NULL,rollback_chain BOOLEAN NOT NULL,
 image_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(image_ids)='array'),
 backup_environment_id VARCHAR(200) NOT NULL,backup_database_identity VARCHAR(200) NOT NULL,release_id VARCHAR(200) NOT NULL,
 schema_version VARCHAR(200) NOT NULL,postgres_format VARCHAR(200) NOT NULL,device VARCHAR(200) NOT NULL,inode VARCHAR(200) NOT NULL,
 modified_at TIMESTAMPTZ NOT NULL,partial BOOLEAN NOT NULL,symlink BOOLEAN NOT NULL,hardlink_count INTEGER NOT NULL CHECK(hardlink_count>0),
 UNIQUE(snapshot_id,opaque_id)
);
CREATE INDEX IF NOT EXISTS idx_host_backup_catalog_snapshots_current
 ON public.host_backup_catalog_snapshots(environment_id,database_identity,id DESC);

DO $$ DECLARE table_name TEXT; BEGIN
 FOREACH table_name IN ARRAY ARRAY['host_backup_catalog_snapshots','host_backup_catalog_entries'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS host_backup_catalog_append_only ON public.%I',table_name);
  EXECUTE format('CREATE TRIGGER host_backup_catalog_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_host_maintenance_evidence_mutation()',table_name);
  EXECUTE format('DROP TRIGGER IF EXISTS host_backup_catalog_no_truncate ON public.%I',table_name);
  EXECUTE format('CREATE TRIGGER host_backup_catalog_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_host_maintenance_evidence_mutation()',table_name);
 END LOOP;
END $$;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080501_read_only_backup_catalog','Persist immutable worker-validated rollback-backup catalog snapshots while keeping destructive retention disabled.')
ON CONFLICT(version) DO NOTHING;

-- Blue Iris can include the ordered zone crossing which caused an alert in
-- its &TYPE macro. Keep this as independent shadow evidence until daylight
-- validation proves the camera-specific mapping in both directions.
ALTER TABLE public.camera_direction_profiles
  ADD COLUMN IF NOT EXISTS blue_iris_motion_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS blue_iris_front_trigger_type VARCHAR(80),
  ADD COLUMN IF NOT EXISTS blue_iris_rear_trigger_type VARCHAR(80),
  ADD COLUMN IF NOT EXISTS blue_iris_motion_profile_version INTEGER NOT NULL DEFAULT 1
    CHECK (blue_iris_motion_profile_version > 0);

ALTER TABLE public.camera_direction_profiles
  DROP CONSTRAINT IF EXISTS camera_direction_blue_iris_trigger_shape;
ALTER TABLE public.camera_direction_profiles
  ADD CONSTRAINT camera_direction_blue_iris_trigger_shape CHECK (
    blue_iris_motion_enabled = FALSE OR (
      blue_iris_front_trigger_type ~ '^MOTION_[A-H]>[A-H]$' AND
      blue_iris_rear_trigger_type ~ '^MOTION_[A-H]>[A-H]$' AND
      SUBSTRING(blue_iris_front_trigger_type FROM 8 FOR 1) <>
        SUBSTRING(blue_iris_front_trigger_type FROM 10 FOR 1) AND
      blue_iris_rear_trigger_type =
        'MOTION_' || SUBSTRING(blue_iris_front_trigger_type FROM 10 FOR 1) ||
        '>' || SUBSTRING(blue_iris_front_trigger_type FROM 8 FOR 1)
    )
  );

ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS bi_trigger_type VARCHAR(80),
  ADD COLUMN IF NOT EXISTS bi_trigger_direction_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS bi_trigger_direction_label VARCHAR(80),
  ADD COLUMN IF NOT EXISTS bi_trigger_direction_profile_version INTEGER,
  ADD COLUMN IF NOT EXISTS bi_trigger_direction_algorithm VARCHAR(80),
  ADD COLUMN IF NOT EXISTS bi_trigger_direction_error_code VARCHAR(80);

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_bi_trigger_type_shape;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_bi_trigger_type_shape CHECK (
    bi_trigger_type IS NULL OR bi_trigger_type ~ '^[A-Z0-9_!>,+\-]{1,80}$'
  );
ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_bi_trigger_direction_state;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_bi_trigger_direction_state CHECK (
    (bi_trigger_direction_status IS NULL AND
      bi_trigger_direction_label IS NULL AND
      bi_trigger_direction_profile_version IS NULL AND
      bi_trigger_direction_algorithm IS NULL AND
      bi_trigger_direction_error_code IS NULL) OR
    (bi_trigger_direction_status = 'ready' AND
      bi_trigger_direction_label IS NOT NULL AND
      bi_trigger_direction_profile_version IS NOT NULL AND
      bi_trigger_direction_algorithm IS NOT NULL AND
      bi_trigger_direction_error_code IS NULL) OR
    (bi_trigger_direction_status = 'unknown' AND
      bi_trigger_direction_label IS NULL AND
      bi_trigger_direction_algorithm IS NOT NULL AND
      bi_trigger_direction_error_code IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_plate_reads_bi_trigger_direction
  ON public.plate_reads (camera_name, bi_trigger_direction_status, timestamp DESC)
  WHERE bi_trigger_direction_status IS NOT NULL;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080702_blue_iris_trigger_direction_shadow','Store and map ordered Blue Iris &TYPE zone crossings as camera-specific shadow direction evidence.')
ON CONFLICT(version) DO NOTHING;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080703_blue_iris_trigger_direction_hardening','Separate Blue Iris mapping revisions from ReID, enforce exact reverse crossings, and scope diagnostics by camera.')
ON CONFLICT(version) DO NOTHING;

-- Phase 2 overview Vehicle Views. Motion alerts from an overview-capable Blue
-- Iris camera are screened and sampled independently from plate ingestion.
-- Direction-aware, camera-pair timing profiles associate one retained daytime
-- frame only after both LPR reads have had time to arrive. Nighttime candidates
-- and nighttime plate reads are terminal and never enter the processing queue.
CREATE TABLE IF NOT EXISTS public.vehicle_overview_pair_profiles (
  id BIGSERIAL PRIMARY KEY,
  source_camera_name VARCHAR(120) NOT NULL CHECK (BTRIM(source_camera_name) <> ''),
  plate_camera_name VARCHAR(120) NOT NULL CHECK (BTRIM(plate_camera_name) <> ''),
  direction_label VARCHAR(80) NOT NULL CHECK (BTRIM(direction_label) <> ''),
  source_role VARCHAR(16) NOT NULL DEFAULT 'primary'
    CHECK (source_role IN ('primary','fallback')),
  expected_delta_ms INTEGER NOT NULL DEFAULT 0
    CHECK (expected_delta_ms BETWEEN -30000 AND 30000),
  tolerance_ms INTEGER NOT NULL DEFAULT 1500
    CHECK (tolerance_ms BETWEEN 250 AND 10000),
  priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_camera_name, plate_camera_name, direction_label)
);

CREATE TABLE IF NOT EXISTS public.vehicle_overview_candidates (
  id BIGSERIAL PRIMARY KEY,
  event_identity CHAR(64) NOT NULL UNIQUE CHECK (event_identity ~ '^[0-9a-f]{64}$'),
  source_camera_name VARCHAR(120) NOT NULL CHECK (BTRIM(source_camera_name) <> ''),
  event_timestamp TIMESTAMPTZ NOT NULL,
  bi_alert_clip TEXT,
  bi_alert_path TEXT,
  bi_alert_offset_ms BIGINT,
  bi_trigger_type VARCHAR(80),
  daylight_status VARCHAR(16) NOT NULL
    CHECK (daylight_status IN ('daytime','nighttime')),
  monochrome_ratio REAL CHECK (monochrome_ratio IS NULL OR monochrome_ratio BETWEEN 0 AND 1),
  status VARCHAR(20) NOT NULL
    CHECK (status IN ('pending','processing','ready','matching','associated','ambiguous','unavailable','failed')),
  frame_path TEXT,
  frame_timestamp TIMESTAMPTZ,
  frame_score REAL,
  detection_confidence REAL,
  detection_box JSONB,
  image_width INTEGER,
  image_height INTEGER,
  sampled_count SMALLINT,
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  match_attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (match_attempt_count BETWEEN 0 AND 20),
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  error_code VARCHAR(80),
  selection_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vehicle_overview_candidates_work
  ON public.vehicle_overview_candidates (status, updated_at, event_timestamp, id)
  WHERE status IN ('pending','processing','ready','matching','failed');

CREATE INDEX IF NOT EXISTS idx_vehicle_overview_pair_profiles_lookup
  ON public.vehicle_overview_pair_profiles (
    LOWER(BTRIM(source_camera_name)), LOWER(BTRIM(plate_camera_name)),
    LOWER(BTRIM(direction_label))
  ) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS public.vehicle_overview_associations (
  id BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES public.vehicle_overview_candidates(id) ON DELETE RESTRICT,
  read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE RESTRICT,
  pair_profile_id BIGINT NOT NULL REFERENCES public.vehicle_overview_pair_profiles(id) ON DELETE RESTRICT,
  algorithm VARCHAR(80) NOT NULL,
  association_score REAL NOT NULL,
  actual_delta_ms INTEGER NOT NULL,
  timing_error_ms INTEGER NOT NULL CHECK (timing_error_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (candidate_id, read_id),
  UNIQUE (read_id)
);

ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS vehicle_image_source_kind VARCHAR(24),
  ADD COLUMN IF NOT EXISTS vehicle_overview_candidate_id BIGINT;

ALTER TABLE public.plate_reads
  ALTER COLUMN vehicle_image_source_kind TYPE VARCHAR(40);

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_source_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_source_kind_check CHECK (
    vehicle_image_source_kind IS NULL OR
    vehicle_image_source_kind IN (
      'legacy_plate_camera','overview_primary','entry_overview_primary',
      'overview_fallback','overview_pair_share','entry_lpr_fallback',
      'entry_overview_route_fallback','entry_overview_history'
    )
  ) NOT VALID;

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_queue_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_queue_kind_check
  CHECK (vehicle_image_queue_kind IS NULL OR vehicle_image_queue_kind IN ('live', 'historical', 'manual', 'overview', 'overview_backfill', 'overview_repair'));

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plate_reads_vehicle_overview_candidate_fkey'
      AND conrelid = 'public.plate_reads'::regclass
  ) THEN
    ALTER TABLE public.plate_reads
      ADD CONSTRAINT plate_reads_vehicle_overview_candidate_fkey
      FOREIGN KEY (vehicle_overview_candidate_id)
      REFERENCES public.vehicle_overview_candidates(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_plate_reads_overview_waiting
  ON public.plate_reads (vehicle_image_queue_kind, timestamp DESC, id DESC)
  WHERE vehicle_image_queue_kind = 'overview' AND vehicle_image_path IS NULL;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080801_daytime_overview_vehicle_views','Ingest daytime Blue Iris overview candidates and conservatively associate primary or driveway-fallback Vehicle Views by camera timing and direction.')
ON CONFLICT(version) DO NOTHING;

-- Primary Street Overview retrieval is read-owned and may outlive the worker
-- process which originally claimed it. A per-claim token prevents a reclaimed
-- worker from overwriting a newer result, while next_attempt_at supports one
-- short, bounded retry when a fresh Blue Iris recording is still finalizing.
ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS vehicle_image_claim_token UUID,
  ADD COLUMN IF NOT EXISTS vehicle_image_next_attempt_at TIMESTAMPTZ;

ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT IF EXISTS vehicle_overview_primary_tolerance_ms_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_primary_tolerance_ms_check CHECK (
    source_role <> 'primary' OR tolerance_ms <= 3000
  ) NOT VALID;

ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT IF EXISTS vehicle_overview_distinct_camera_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_distinct_camera_check CHECK (
    LOWER(BTRIM(source_camera_name)) <> LOWER(BTRIM(plate_camera_name))
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_plate_reads_overview_retry_ready
  ON public.plate_reads (vehicle_image_next_attempt_at, timestamp DESC, id DESC)
  WHERE vehicle_image_queue_kind = 'overview'
    AND vehicle_image_status = 'failed'
    AND vehicle_image_retryable = TRUE;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080901_overview_primary_claim_safety','Add token-guarded profile-aware Street Overview claims, bounded recording-finalization retries, and a primary timing tolerance compatible with the six-second sample window.')
ON CONFLICT(version) DO NOTHING;

-- Timeline exports replace sixty-one sequential Blue Iris /time requests for
-- primary Street Overview work. The export ledger owns only API-generated
-- temporary files. Blue Iris owns Clipboard retention; ALPR never requests
-- deletion of remote exports and removes only its downloaded local workspace.
ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS vehicle_image_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vehicle_image_processing_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vehicle_image_hard_deadline_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.blue_iris_timeline_exports (
  id BIGSERIAL PRIMARY KEY,
  export_token UUID NOT NULL UNIQUE,
  read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE CASCADE,
  claim_token UUID NOT NULL,
  source_camera_name VARCHAR(120) NOT NULL CHECK (BTRIM(source_camera_name) <> ''),
  requested_start_at TIMESTAMPTZ NOT NULL,
  requested_duration_ms INTEGER NOT NULL CHECK (requested_duration_ms BETWEEN 1000 AND 60000),
  remote_path TEXT,
  remote_uri TEXT,
  remote_status TEXT,
  remote_utc_ms BIGINT,
  remote_duration_ms INTEGER CHECK (remote_duration_ms IS NULL OR remote_duration_ms > 0),
  status VARCHAR(24) NOT NULL CHECK (
    status IN ('starting','exporting','ready','downloaded','delete_pending','deleting','deleted','failed')
  ),
  progress SMALLINT CHECK (progress IS NULL OR progress BETWEEN 0 AND 100),
  file_size_bytes BIGINT CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  video_width INTEGER CHECK (video_width IS NULL OR video_width > 0),
  video_height INTEGER CHECK (video_height IS NULL OR video_height > 0),
  media_duration_ms INTEGER CHECK (media_duration_ms IS NULL OR media_duration_ms > 0),
  error_code VARCHAR(80),
  error_details JSONB,
  delete_attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (delete_attempt_count BETWEEN 0 AND 20),
  next_delete_attempt_at TIMESTAMPTZ,
  hard_deadline_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '5 minutes'),
  downloaded_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (read_id, claim_token)
);

CREATE INDEX IF NOT EXISTS idx_blue_iris_timeline_exports_cleanup
  ON public.blue_iris_timeline_exports (next_delete_attempt_at, updated_at, id)
  WHERE remote_path IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plate_reads_overview_claim_heartbeat
  ON public.plate_reads (
    vehicle_image_heartbeat_at,
    vehicle_image_processing_deadline_at,
    vehicle_image_hard_deadline_at,
    timestamp,
    id
  )
  WHERE vehicle_image_queue_kind = 'overview' AND vehicle_image_status = 'processing';

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080902_blue_iris_timeline_exports','Track read-owned temporary Blue Iris timeline exports and bound overview processing with heartbeats and deadlines.')
ON CONFLICT(version) DO NOTHING;

-- Retire the earlier remote-delete workflow without removing its additive
-- compatibility columns. Completed downloads become terminal ledger entries;
-- Blue Iris removes Clipboard exports according to its configured retention.
UPDATE public.blue_iris_timeline_exports
SET status = CASE WHEN downloaded_at IS NOT NULL THEN 'downloaded' ELSE 'failed' END,
    error_code = CASE
      WHEN downloaded_at IS NOT NULL AND error_code = 'EXPORT_DELETE_FAILED' THEN NULL
      ELSE error_code
    END,
    error_details = CASE
      WHEN downloaded_at IS NOT NULL AND error_code = 'EXPORT_DELETE_FAILED' THEN NULL
      ELSE error_details
    END,
    next_delete_attempt_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE status IN ('delete_pending', 'deleting');

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080903_blue_iris_clipboard_retention','Stop ALPR remote-delete attempts, leave Blue Iris Clipboard retention authoritative, and normalize earlier delete-pending export rows.')
ON CONFLICT(version) DO NOTHING;

-- Overview processing must not use PostgreSQL timestamps as compare-and-swap
-- revisions because the JavaScript Date representation loses microseconds.
-- Timeline exports also need a stable identity which survives claim renewal,
-- retries, and worker restarts. Existing ledger rows represent an export which
-- was already requested, so they are conservatively marked as dispatched.
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;

ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT IF EXISTS vehicle_overview_pair_profiles_revision_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_pair_profiles_revision_check
  CHECK (revision > 0) NOT VALID;

ALTER TABLE public.blue_iris_timeline_exports
  ADD COLUMN IF NOT EXISTS export_key CHAR(64),
  ADD COLUMN IF NOT EXISTS pair_profile_id BIGINT,
  ADD COLUMN IF NOT EXISTS profile_revision BIGINT,
  ADD COLUMN IF NOT EXISTS algorithm_revision VARCHAR(80),
  ADD COLUMN IF NOT EXISTS automatic_start_count SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS start_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preexisting_remote_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS legacy_imported BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS vehicle_image_recovery_count SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vehicle_image_last_recovered_at TIMESTAMPTZ;

UPDATE public.blue_iris_timeline_exports
SET automatic_start_count = 1,
    legacy_imported = TRUE,
    start_requested_at = COALESCE(start_requested_at, created_at),
    updated_at = CURRENT_TIMESTAMP
WHERE export_key IS NULL AND automatic_start_count = 0;

ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_automatic_start_count_check;
ALTER TABLE public.blue_iris_timeline_exports
  ADD CONSTRAINT blue_iris_timeline_exports_automatic_start_count_check
  CHECK (automatic_start_count BETWEEN 0 AND 1) NOT VALID;

-- pair_profile_id is an immutable historical snapshot, not a live relation.
-- Deleting or editing a profile must not mutate an in-flight export identity.
ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_pair_profile_fkey;
ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_pair_profile_id_fkey;

CREATE UNIQUE INDEX IF NOT EXISTS idx_blue_iris_timeline_exports_stable_key
  ON public.blue_iris_timeline_exports (export_key)
  WHERE export_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_blue_iris_timeline_exports_read_resume
  ON public.blue_iris_timeline_exports (
    read_id, source_camera_name, requested_start_at, requested_duration_ms, id
  );

ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_preexisting_paths_check;
ALTER TABLE public.blue_iris_timeline_exports
  ADD CONSTRAINT blue_iris_timeline_exports_preexisting_paths_check
  CHECK (jsonb_typeof(preexisting_remote_paths) = 'array') NOT VALID;

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_recovery_count_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_recovery_count_check
  CHECK (vehicle_image_recovery_count BETWEEN 0 AND 20) NOT VALID;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081001_overview_export_idempotency','Use integer overview-profile revisions and stable at-most-once Blue Iris timeline-export identities across retries and worker restarts.')
ON CONFLICT(version) DO NOTHING;

-- A validated primary Street Overview frame may be copied to one uniquely
-- matching companion Street LPR read. New installations begin in shadow mode:
-- matches are recorded for review, but no read or file is changed until an
-- administrator explicitly enables active sharing.
ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS vehicle_image_source_read_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plate_reads_vehicle_image_source_read_id_fkey'
  ) THEN
    ALTER TABLE public.plate_reads
      ADD CONSTRAINT plate_reads_vehicle_image_source_read_id_fkey
      FOREIGN KEY (vehicle_image_source_read_id)
      REFERENCES public.plate_reads(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_source_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_source_kind_check CHECK (
    vehicle_image_source_kind IS NULL OR
    vehicle_image_source_kind IN (
      'legacy_plate_camera','overview_primary','entry_overview_primary',
      'overview_fallback','overview_pair_share','entry_lpr_fallback',
      'entry_overview_route_fallback','entry_overview_history'
    )
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS public.vehicle_overview_pair_sharing_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode VARCHAR(12) NOT NULL DEFAULT 'shadow'
    CHECK (mode IN ('off','shadow','active')),
  observation_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.vehicle_overview_pair_sharing_settings (singleton, mode)
VALUES (TRUE, 'shadow')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_overview_read_shares (
  id BIGSERIAL PRIMARY KEY,
  decision_identity CHAR(64) NOT NULL UNIQUE,
  source_read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
  target_read_id INTEGER NOT NULL UNIQUE REFERENCES public.plate_reads(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL CHECK (
    status IN ('proposed','processing','applied','rejected','failed')
  ),
  decision_reason VARCHAR(80) NOT NULL,
  plate_number_snapshot VARCHAR(32),
  direction_label_snapshot VARCHAR(100),
  source_camera_name_snapshot VARCHAR(120),
  target_camera_name_snapshot VARCHAR(120),
  overview_camera_name_snapshot VARCHAR(120),
  source_profile_id BIGINT,
  source_profile_revision BIGINT,
  target_profile_id BIGINT,
  target_profile_revision BIGINT,
  source_image_path_snapshot TEXT,
  source_anchor_at TIMESTAMPTZ,
  target_anchor_at TIMESTAMPTZ,
  anchor_delta_ms INTEGER,
  decision_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  claim_token UUID,
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  target_image_path TEXT,
  error_code VARCHAR(80),
  error_details JSONB,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vehicle_overview_read_shares_claim
  ON public.vehicle_overview_read_shares (status, created_at, id)
  WHERE status IN ('proposed','processing');

CREATE INDEX IF NOT EXISTS idx_vehicle_overview_read_shares_source
  ON public.vehicle_overview_read_shares (source_read_id, status, id)
  WHERE source_read_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_overview_read_shares_unique_live_source
  ON public.vehicle_overview_read_shares (source_read_id)
  WHERE source_read_id IS NOT NULL AND status IN ('proposed','processing','applied');

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081002_street_overview_pair_sharing','Add shadow-first, one-to-one Street LPR companion sharing with independent image files and durable provenance.')
ON CONFLICT(version) DO NOTHING;

-- Live Feed must page the inexpensive read identity set before joining tags,
-- vehicle evidence, and other presentation data. This composite order index
-- supports its default newest-first page without sorting the full read history.
CREATE INDEX IF NOT EXISTS idx_plate_reads_live_feed_timestamp
  ON public.plate_reads ("timestamp" DESC, id DESC);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081003_live_feed_page_first','Page Live Feed read identities before presentation joins and support newest-first lookup with a composite index.')
ON CONFLICT(version) DO NOTHING;

-- Entry LPR fallback is a read-to-read association. It never consumes a Blue
-- Iris alert and never creates a synthetic Street read. New installations start
-- in shadow mode so route matches can be reviewed before copied images are
-- allowed to fill a failed Street Overview result.
ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_source_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_source_kind_check CHECK (
    vehicle_image_source_kind IS NULL OR
    vehicle_image_source_kind IN (
      'legacy_plate_camera','overview_primary','entry_overview_primary','overview_fallback',
      'overview_pair_share','entry_lpr_fallback','entry_overview_route_fallback',
      'entry_overview_history'
    )
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS public.vehicle_entry_fallback_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode VARCHAR(12) NOT NULL DEFAULT 'shadow'
    CHECK (mode IN ('off','shadow','active')),
  observation_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.vehicle_entry_fallback_settings (singleton, mode)
VALUES (TRUE, 'shadow')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_entry_route_profiles (
  id BIGSERIAL PRIMARY KEY,
  route_name VARCHAR(120) NOT NULL,
  target_camera_name VARCHAR(120) NOT NULL,
  target_camera_key VARCHAR(120) GENERATED ALWAYS AS (LOWER(BTRIM(target_camera_name))) STORED,
  target_direction_label VARCHAR(100) NOT NULL,
  target_direction_key VARCHAR(100) GENERATED ALWAYS AS (LOWER(BTRIM(target_direction_label))) STORED,
  source_direction_label VARCHAR(100) NOT NULL,
  source_camera_names TEXT[] NOT NULL,
  expected_delta_ms INTEGER NOT NULL CHECK (expected_delta_ms BETWEEN -30000 AND 30000),
  tolerance_ms INTEGER NOT NULL DEFAULT 3000 CHECK (tolerance_ms BETWEEN 250 AND 15000),
  event_window_ms INTEGER NOT NULL DEFAULT 3000 CHECK (event_window_ms BETWEEN 250 AND 5000),
  minimum_source_count SMALLINT NOT NULL DEFAULT 2 CHECK (minimum_source_count BETWEEN 2 AND 4),
  priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT vehicle_entry_route_profiles_name_check CHECK (BTRIM(route_name) <> ''),
  CONSTRAINT vehicle_entry_route_profiles_target_camera_check CHECK (BTRIM(target_camera_name) <> ''),
  CONSTRAINT vehicle_entry_route_profiles_target_direction_check CHECK (BTRIM(target_direction_label) <> ''),
  CONSTRAINT vehicle_entry_route_profiles_source_direction_check CHECK (BTRIM(source_direction_label) <> ''),
  CONSTRAINT vehicle_entry_route_profiles_source_cameras_check CHECK (
    cardinality(source_camera_names) >= minimum_source_count
  ),
  UNIQUE (target_camera_key, target_direction_key)
);

CREATE TABLE IF NOT EXISTS public.vehicle_entry_fallback_decisions (
  id BIGSERIAL PRIMARY KEY,
  decision_identity CHAR(64) NOT NULL UNIQUE,
  source_event_key CHAR(64),
  route_profile_id BIGINT NOT NULL,
  route_profile_revision BIGINT NOT NULL CHECK (route_profile_revision > 0),
  target_read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE CASCADE,
  source_read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
  corroborating_read_ids INTEGER[] NOT NULL DEFAULT '{}',
  status VARCHAR(16) NOT NULL CHECK (
    status IN ('proposed','processing','applied','rejected','failed')
  ),
  decision_reason VARCHAR(100) NOT NULL,
  route_name_snapshot VARCHAR(120) NOT NULL,
  target_plate_snapshot VARCHAR(32),
  target_camera_name_snapshot VARCHAR(120),
  target_direction_label_snapshot VARCHAR(100),
  source_direction_label_snapshot VARCHAR(100),
  source_camera_names_snapshot TEXT[] NOT NULL DEFAULT '{}',
  source_image_path_snapshot TEXT,
  source_timestamp_snapshot TIMESTAMPTZ,
  source_detection_confidence REAL CHECK (
    source_detection_confidence IS NULL OR source_detection_confidence BETWEEN 0 AND 1
  ),
  source_detection_box JSONB,
  source_image_width INTEGER CHECK (source_image_width IS NULL OR source_image_width > 0),
  source_image_height INTEGER CHECK (source_image_height IS NULL OR source_image_height > 0),
  plate_evidence_class VARCHAR(80),
  expected_delta_ms INTEGER,
  actual_delta_ms INTEGER,
  timing_error_ms INTEGER,
  decision_score REAL,
  decision_margin REAL,
  decision_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  claim_token UUID,
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  target_image_path TEXT,
  error_code VARCHAR(80),
  error_details JSONB,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (target_read_id, route_profile_id, route_profile_revision),
  CONSTRAINT vehicle_entry_fallback_decisions_metadata_check CHECK (
    jsonb_typeof(decision_metadata) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_entry_fallback_decisions_claim
  ON public.vehicle_entry_fallback_decisions (status, created_at, id)
  WHERE status IN ('proposed','processing');

CREATE INDEX IF NOT EXISTS idx_vehicle_entry_fallback_decisions_target
  ON public.vehicle_entry_fallback_decisions (target_read_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_entry_fallback_unique_live_event
  ON public.vehicle_entry_fallback_decisions (source_event_key)
  WHERE source_event_key IS NOT NULL AND status IN ('proposed','processing','applied');

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081004_entry_lpr_route_fallback','Add shadow-first, dual-camera Entry LPR read-to-read fallback for explicitly configured driveway routes.')
ON CONFLICT(version) DO NOTHING;

-- Entry LPR reads may use the same read-owned continuous-recording pipeline as
-- Street LPR reads while retaining distinct provenance. Existing primary
-- profiles remain Street profiles until an administrator explicitly changes
-- their context. Street companion sharing continues to accept only the legacy
-- overview_primary result kind, so Entry Overview results cannot cross into it.
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD COLUMN IF NOT EXISTS overview_context VARCHAR(16) NOT NULL DEFAULT 'street',
  ADD COLUMN IF NOT EXISTS source_camera_short_name VARCHAR(80);

ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT IF EXISTS vehicle_overview_pair_profiles_context_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_pair_profiles_context_check CHECK (
    overview_context IN ('street','entry')
  ) NOT VALID;

ALTER TABLE public.vehicle_overview_pair_profiles
  DROP CONSTRAINT IF EXISTS vehicle_overview_pair_profiles_entry_camera_binding_check;
ALTER TABLE public.vehicle_overview_pair_profiles
  ADD CONSTRAINT vehicle_overview_pair_profiles_entry_camera_binding_check CHECK (
    overview_context <> 'entry'
    OR source_role <> 'primary'
    OR NULLIF(BTRIM(source_camera_short_name), '') IS NOT NULL
  ) NOT VALID;

DO $$
DECLARE
  duplicate_identity RECORD;
BEGIN
  SELECT LOWER(BTRIM(plate_camera_name)) AS plate_camera_key,
         LOWER(BTRIM(direction_label)) AS direction_key,
         COUNT(*) AS profile_count
  INTO duplicate_identity
  FROM public.vehicle_overview_pair_profiles
  WHERE enabled = TRUE AND source_role = 'primary'
  GROUP BY LOWER(BTRIM(plate_camera_name)), LOWER(BTRIM(direction_label))
  HAVING COUNT(*) > 1
  ORDER BY COUNT(*) DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Duplicate enabled primary overview profiles for camera % and direction % (% rows). Disable the duplicate before retrying this migration.',
      duplicate_identity.plate_camera_key,
      duplicate_identity.direction_key,
      duplicate_identity.profile_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_overview_primary_profile_identity
  ON public.vehicle_overview_pair_profiles (
    LOWER(BTRIM(plate_camera_name)), LOWER(BTRIM(direction_label))
  )
  WHERE enabled = TRUE AND source_role = 'primary';

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_source_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_source_kind_check CHECK (
    vehicle_image_source_kind IS NULL OR
    vehicle_image_source_kind IN (
      'legacy_plate_camera','overview_primary','entry_overview_primary',
      'overview_fallback','overview_pair_share','entry_lpr_fallback',
      'entry_overview_route_fallback','entry_overview_history'
    )
  ) NOT VALID;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081005_entry_overview_primary','Add explicit Entry Overview primary profile context and distinct read-owned Vehicle View provenance.')
ON CONFLICT(version) DO NOTHING;

-- Direction-independent Entry Overview history is deliberately separate from
-- the live direction profiles. A run first materializes an immutable preview;
-- confirmation may queue only that exact preview. No migration statement
-- enqueues a read or changes an existing Vehicle View.
CREATE TABLE IF NOT EXISTS public.vehicle_entry_overview_history_profiles (
  id BIGSERIAL PRIMARY KEY,
  profile_key CHAR(64) NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  profile_kind VARCHAR(32) NOT NULL DEFAULT 'entry_history'
    CHECK (profile_kind = 'entry_history'),
  source_kind VARCHAR(32) NOT NULL DEFAULT 'entry_overview_history'
    CHECK (source_kind = 'entry_overview_history'),
  overview_context VARCHAR(16) NOT NULL DEFAULT 'entry'
    CHECK (overview_context = 'entry'),
  source_camera_name VARCHAR(120) NOT NULL
    CHECK (BTRIM(source_camera_name) = 'Entry Overview'),
  source_camera_short_name VARCHAR(80) NOT NULL
    CHECK (BTRIM(source_camera_short_name) = 'Cam143'),
  plate_camera_name VARCHAR(120) NOT NULL CHECK (
    LOWER(BTRIM(plate_camera_name)) IN ('entry lpr 1','entry lpr 2')
  ),
  expected_delta_ms INTEGER NOT NULL CHECK (expected_delta_ms BETWEEN -30000 AND 30000),
  tolerance_ms INTEGER NOT NULL DEFAULT 3000 CHECK (tolerance_ms = 3000),
  algorithm_revision VARCHAR(80) NOT NULL CHECK (BTRIM(algorithm_revision) <> ''),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  supersedes_profile_id BIGINT REFERENCES public.vehicle_entry_overview_history_profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disabled_at TIMESTAMPTZ,
  UNIQUE (profile_key, revision),
  CHECK ((enabled = TRUE AND disabled_at IS NULL)
      OR (enabled = FALSE AND disabled_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_overview_history_profile_enabled
  ON public.vehicle_entry_overview_history_profiles (LOWER(BTRIM(plate_camera_name)))
  WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_entry_overview_history_profile_versions
  ON public.vehicle_entry_overview_history_profiles (profile_key, revision DESC, id DESC);

CREATE OR REPLACE FUNCTION public.guard_entry_overview_history_profile_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.profile_key, NEW.revision, NEW.profile_kind, NEW.source_kind,
    NEW.overview_context, NEW.source_camera_name, NEW.source_camera_short_name,
    NEW.plate_camera_name, NEW.expected_delta_ms, NEW.tolerance_ms,
    NEW.algorithm_revision, NEW.supersedes_profile_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.profile_key, OLD.revision, OLD.profile_kind, OLD.source_kind,
    OLD.overview_context, OLD.source_camera_name, OLD.source_camera_short_name,
    OLD.plate_camera_name, OLD.expected_delta_ms, OLD.tolerance_ms,
    OLD.algorithm_revision, OLD.supersedes_profile_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Entry Overview history profile snapshots are immutable; create a new revision.';
  END IF;
  IF OLD.enabled = FALSE AND (
    NEW.enabled IS DISTINCT FROM OLD.enabled
    OR NEW.disabled_at IS DISTINCT FROM OLD.disabled_at
  ) THEN
    RAISE EXCEPTION 'Disabled Entry Overview history profile snapshots cannot be revived or changed.';
  END IF;
  IF OLD.enabled = TRUE AND NOT (
    (NEW.enabled = TRUE AND NEW.disabled_at IS NULL)
    OR (NEW.enabled = FALSE AND NEW.disabled_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Entry Overview history profile retirement must be one-way and timestamped.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_entry_overview_history_profile_snapshot
  ON public.vehicle_entry_overview_history_profiles;
CREATE TRIGGER trg_guard_entry_overview_history_profile_snapshot
BEFORE UPDATE ON public.vehicle_entry_overview_history_profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_entry_overview_history_profile_snapshot();

ALTER TABLE public.vehicle_entry_overview_history_profiles
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_history_profiles_check;
ALTER TABLE public.vehicle_entry_overview_history_profiles
  ADD CONSTRAINT vehicle_entry_overview_history_profiles_check CHECK (
    (enabled = TRUE AND disabled_at IS NULL)
    OR (enabled = FALSE AND disabled_at IS NOT NULL)
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS public.vehicle_entry_overview_backfill_runs (
  id BIGSERIAL PRIMARY KEY,
  scope_key CHAR(64) NOT NULL,
  preview_fingerprint CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'previewed' CHECK (
    status IN ('previewed','running','paused','completed','cancelled')
  ),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  plate_camera_names JSONB NOT NULL,
  profile_snapshot JSONB NOT NULL,
  daylight_provider VARCHAR(80) NOT NULL,
  daylight_model VARCHAR(80) NOT NULL,
  algorithm_revision VARCHAR(80) NOT NULL,
  batch_size INTEGER NOT NULL CHECK (batch_size BETWEEN 1 AND 500),
  confirmed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (end_at > start_at),
  CHECK (jsonb_typeof(plate_camera_names) = 'array'),
  CHECK (jsonb_typeof(profile_snapshot) = 'array')
);

CREATE TABLE IF NOT EXISTS public.vehicle_entry_overview_backfill_jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.vehicle_entry_overview_backfill_runs(id) ON DELETE RESTRICT,
  read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE RESTRICT,
  semantic_key CHAR(64) NOT NULL,
  profile_id BIGINT NOT NULL REFERENCES public.vehicle_entry_overview_history_profiles(id) ON DELETE RESTRICT,
  profile_key CHAR(64) NOT NULL,
  profile_revision BIGINT NOT NULL CHECK (profile_revision > 0),
  profile_kind VARCHAR(32) NOT NULL DEFAULT 'entry_history' CHECK (profile_kind = 'entry_history'),
  source_kind VARCHAR(32) NOT NULL DEFAULT 'entry_overview_history'
    CHECK (source_kind = 'entry_overview_history'),
  overview_context VARCHAR(16) NOT NULL DEFAULT 'entry' CHECK (overview_context = 'entry'),
  source_camera_name VARCHAR(120) NOT NULL CHECK (BTRIM(source_camera_name) = 'Entry Overview'),
  source_camera_short_name VARCHAR(80) NOT NULL CHECK (BTRIM(source_camera_short_name) = 'Cam143'),
  plate_camera_name VARCHAR(120) NOT NULL,
  read_timestamp TIMESTAMPTZ NOT NULL,
  anchor_at TIMESTAMPTZ NOT NULL,
  expected_delta_ms INTEGER NOT NULL,
  tolerance_ms INTEGER NOT NULL DEFAULT 3000 CHECK (tolerance_ms = 3000),
  algorithm_revision VARCHAR(80) NOT NULL,
  daylight_provider VARCHAR(80) NOT NULL,
  daylight_model VARCHAR(80) NOT NULL,
  daylight_status VARCHAR(24) NOT NULL CHECK (
    daylight_status IN ('eligible','needs_preflight','nighttime','unverified','live_busy','preserved')
  ),
  daylight_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'previewed' CHECK (
    status IN ('previewed','queued','processing','ready','failed','unavailable','cancelled','superseded')
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token UUID,
  heartbeat_at TIMESTAMPTZ,
  processing_deadline_at TIMESTAMPTZ,
  hard_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB,
  operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (operator_retry_count BETWEEN 0 AND 1),
  operator_retry_at TIMESTAMPTZ,
  operator_retry_error_code VARCHAR(80),
  prior_state_fingerprint CHAR(64) NOT NULL,
  prior_image_path TEXT,
  prior_image_status VARCHAR(20),
  prior_queue_kind VARCHAR(24),
  prior_attempt_count SMALLINT,
  prior_retryable BOOLEAN,
  prior_error_code VARCHAR(80),
  prior_source_kind VARCHAR(32),
  prior_overview_candidate_id BIGINT,
  prior_source_read_id INTEGER,
  prior_image_timestamp TIMESTAMPTZ,
  prior_image_score REAL,
  prior_detection_confidence REAL,
  prior_detection_box JSONB,
  prior_image_width INTEGER,
  prior_image_height INTEGER,
  prior_sampled_count SMALLINT,
  prior_selection_metadata JSONB,
  confirmed_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, read_id),
  CHECK (jsonb_typeof(daylight_evidence) = 'object'),
  CHECK (error_details IS NULL OR jsonb_typeof(error_details) = 'object'),
  CHECK (prior_detection_box IS NULL OR jsonb_typeof(prior_detection_box) = 'object'),
  CHECK (prior_selection_metadata IS NULL OR jsonb_typeof(prior_selection_metadata) = 'object')
);

-- Keep migration replay safe if a development snapshot created this new table
-- before the complete provenance snapshot was added.
ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  ADD COLUMN IF NOT EXISTS prior_overview_candidate_id BIGINT,
  ADD COLUMN IF NOT EXISTS prior_source_read_id INTEGER,
  ADD COLUMN IF NOT EXISTS operator_retry_count SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS operator_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operator_retry_error_code VARCHAR(80);

ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_backfill_jobs_operator_retry_count_check;
ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  ADD CONSTRAINT vehicle_entry_overview_backfill_jobs_operator_retry_count_check CHECK (
    operator_retry_count BETWEEN 0 AND 1
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_entry_overview_backfill_jobs_claim
  ON public.vehicle_entry_overview_backfill_jobs (read_timestamp, id)
  WHERE status IN ('queued','processing','failed');

CREATE INDEX IF NOT EXISTS idx_entry_overview_backfill_jobs_run
  ON public.vehicle_entry_overview_backfill_jobs (run_id, status, read_timestamp, id);

ALTER TABLE public.vehicle_entry_overview_backfill_runs
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_backfill_runs_scope_key_key;
ALTER TABLE public.vehicle_entry_overview_backfill_runs
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_backfill_runs_preview_fingerprint_key;
ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_backfill_jobs_semantic_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_overview_backfill_active_scope
  ON public.vehicle_entry_overview_backfill_runs (scope_key)
  WHERE status <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_overview_backfill_active_preview
  ON public.vehicle_entry_overview_backfill_runs (preview_fingerprint)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_entry_overview_backfill_jobs_semantic
  ON public.vehicle_entry_overview_backfill_jobs (semantic_key, id);

ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  DROP CONSTRAINT IF EXISTS vehicle_entry_overview_backfill_jobs_daylight_status_check;
ALTER TABLE public.vehicle_entry_overview_backfill_jobs
  ADD CONSTRAINT vehicle_entry_overview_backfill_jobs_daylight_status_check CHECK (
    daylight_status IN ('eligible','needs_preflight','nighttime','unverified','live_busy','preserved')
  ) NOT VALID;

ALTER TABLE public.plate_reads
  ADD COLUMN IF NOT EXISTS vehicle_image_backfill_job_id BIGINT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plate_reads_vehicle_image_backfill_job_fkey'
      AND conrelid = 'public.plate_reads'::regclass
  ) THEN
    ALTER TABLE public.plate_reads
      ADD CONSTRAINT plate_reads_vehicle_image_backfill_job_fkey
      FOREIGN KEY (vehicle_image_backfill_job_id)
      REFERENCES public.vehicle_entry_overview_backfill_jobs(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.blue_iris_timeline_exports
  ADD COLUMN IF NOT EXISTS profile_kind VARCHAR(32),
  ADD COLUMN IF NOT EXISTS profile_identity CHAR(64);

ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_profile_kind_check;
ALTER TABLE public.blue_iris_timeline_exports
  ADD CONSTRAINT blue_iris_timeline_exports_profile_kind_check CHECK (
    profile_kind IS NULL OR profile_kind IN ('pair','entry_history')
  ) NOT VALID;

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_source_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_source_kind_check CHECK (
    vehicle_image_source_kind IS NULL OR
    vehicle_image_source_kind IN (
      'legacy_plate_camera','overview_primary','entry_overview_primary',
      'overview_fallback','overview_pair_share','entry_lpr_fallback',
      'entry_overview_route_fallback','entry_overview_history'
    )
  ) NOT VALID;

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_queue_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_queue_kind_check CHECK (
    vehicle_image_queue_kind IS NULL OR
    vehicle_image_queue_kind IN ('live','historical','manual','overview','overview_backfill','overview_repair')
  ) NOT VALID;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081006_entry_overview_history_backfill','Add immutable direction-independent Entry Overview history profiles and preview-first, bounded, resumable backfill runs without auto-queueing reads.')
ON CONFLICT(version) DO NOTHING;

-- Route fallback v2 keeps the two Entry LPR reads as immutable identity and
-- timing evidence, but may copy only an already validated Entry Overview
-- (Cam143) result owned by one of those exact reads. The independent payload
-- gate starts in shadow even when the older route matcher was already active.
ALTER TABLE public.vehicle_entry_fallback_settings
  ADD COLUMN IF NOT EXISTS overview_payload_mode VARCHAR(12) NOT NULL DEFAULT 'shadow';

ALTER TABLE public.vehicle_entry_fallback_settings
  DROP CONSTRAINT IF EXISTS vehicle_entry_fallback_settings_overview_payload_mode_check;
ALTER TABLE public.vehicle_entry_fallback_settings
  ADD CONSTRAINT vehicle_entry_fallback_settings_overview_payload_mode_check CHECK (
    overview_payload_mode IN ('off','shadow','active')
  ) NOT VALID;

ALTER TABLE public.vehicle_entry_fallback_decisions
  ADD COLUMN IF NOT EXISTS algorithm_revision VARCHAR(80) NOT NULL DEFAULT 'entry-lpr-route-fallback-v1',
  ADD COLUMN IF NOT EXISTS payload_read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payload_image_path_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS payload_source_kind_snapshot VARCHAR(40),
  ADD COLUMN IF NOT EXISTS payload_timestamp_snapshot TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payload_detection_confidence REAL,
  ADD COLUMN IF NOT EXISTS payload_detection_box JSONB,
  ADD COLUMN IF NOT EXISTS payload_image_width INTEGER,
  ADD COLUMN IF NOT EXISTS payload_image_height INTEGER,
  ADD COLUMN IF NOT EXISTS payload_score REAL,
  ADD COLUMN IF NOT EXISTS payload_sampled_count SMALLINT,
  ADD COLUMN IF NOT EXISTS payload_selection_metadata JSONB;

DO $entry_fallback_old_unique$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.vehicle_entry_fallback_decisions'::regclass
      AND con.contype = 'u'
      AND (
        SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM unnest(con.conkey) WITH ORDINALITY key_column(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = con.conrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['target_read_id','route_profile_id','route_profile_revision']::name[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.vehicle_entry_fallback_decisions DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END
$entry_fallback_old_unique$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_entry_fallback_algorithm_route_target
  ON public.vehicle_entry_fallback_decisions (
    target_read_id, route_profile_id, route_profile_revision, algorithm_revision
  );

ALTER TABLE public.vehicle_entry_fallback_decisions
  DROP CONSTRAINT IF EXISTS vehicle_entry_fallback_payload_confidence_check;
ALTER TABLE public.vehicle_entry_fallback_decisions
  ADD CONSTRAINT vehicle_entry_fallback_payload_confidence_check CHECK (
    payload_detection_confidence IS NULL OR payload_detection_confidence BETWEEN 0 AND 1
  ) NOT VALID;
ALTER TABLE public.vehicle_entry_fallback_decisions
  DROP CONSTRAINT IF EXISTS vehicle_entry_fallback_payload_dimensions_check;
ALTER TABLE public.vehicle_entry_fallback_decisions
  ADD CONSTRAINT vehicle_entry_fallback_payload_dimensions_check CHECK (
    (payload_image_width IS NULL OR payload_image_width > 0)
    AND (payload_image_height IS NULL OR payload_image_height > 0)
    AND (payload_sampled_count IS NULL OR payload_sampled_count > 0)
  ) NOT VALID;
ALTER TABLE public.vehicle_entry_fallback_decisions
  DROP CONSTRAINT IF EXISTS vehicle_entry_fallback_payload_metadata_check;
ALTER TABLE public.vehicle_entry_fallback_decisions
  ADD CONSTRAINT vehicle_entry_fallback_payload_metadata_check CHECK (
    payload_selection_metadata IS NULL OR jsonb_typeof(payload_selection_metadata) = 'object'
  ) NOT VALID;

ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_source_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_source_kind_check CHECK (
    vehicle_image_source_kind IS NULL OR
    vehicle_image_source_kind IN (
      'legacy_plate_camera','overview_primary','entry_overview_primary',
      'overview_fallback','overview_pair_share','entry_lpr_fallback',
      'entry_overview_route_fallback','entry_overview_history'
    )
  ) NOT VALID;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081201_entry_overview_route_payload','Add shadow-gated Cam143 payload snapshots to dual-Entry-read route fallback without enabling or queuing work.')
ON CONFLICT(version) DO NOTHING;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081101_entry_overview_history_retry','Allow one audited, operator-authorized retry cycle for terminal transient Entry Overview history import failures while preserving existing views and export identity.')
ON CONFLICT(version) DO NOTHING;

-- Bounded operational receipts for authenticated integration requests. These
-- rows intentionally contain request shape and outcome metadata only. Plate
-- values, request bodies, images, AI dumps, and Blue Iris paths are excluded.
CREATE TABLE IF NOT EXISTS public.integration_ingress_receipts (
  id BIGSERIAL PRIMARY KEY,
  request_id VARCHAR(128) NOT NULL,
  integration VARCHAR(64) NOT NULL,
  route_name VARCHAR(128) NOT NULL,
  method VARCHAR(12),
  content_type VARCHAR(128),
  body_bytes BIGINT CHECK (body_bytes IS NULL OR body_bytes >= 0),
  body_sha256 CHAR(64) CHECK (
    body_sha256 IS NULL OR body_sha256 ~ '^[0-9a-f]{64}$'
  ),
  payload_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  unknown_payload_key_count INTEGER NOT NULL DEFAULT 0
    CHECK (unknown_payload_key_count >= 0),
  camera_name VARCHAR(100),
  event_timestamp_text VARCHAR(128),
  trigger_field VARCHAR(32),
  trigger_present BOOLEAN NOT NULL DEFAULT FALSE,
  trigger_value_state VARCHAR(16) NOT NULL DEFAULT 'absent'
    CHECK (trigger_value_state IN ('absent','blank','invalid','recorded')),
  trigger_type VARCHAR(128),
  heavy_fields JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(heavy_fields) = 'object'),
  state VARCHAR(16) NOT NULL DEFAULT 'received'
    CHECK (state IN ('received','completed')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  http_status SMALLINT CHECK (
    http_status IS NULL OR http_status BETWEEN 100 AND 599
  ),
  outcome VARCHAR(64),
  error_code VARCHAR(128),
  processed_read_ids BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  ignored_count INTEGER NOT NULL DEFAULT 0 CHECK (ignored_count >= 0),
  overview_work_queued BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (array_position(payload_keys, NULL) IS NULL),
  CHECK (array_position(processed_read_ids, NULL) IS NULL),
  CHECK (
    (state = 'received' AND completed_at IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_integration_ingress_receipts_received
  ON public.integration_ingress_receipts (received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_integration_ingress_receipts_request
  ON public.integration_ingress_receipts (request_id);
CREATE INDEX IF NOT EXISTS idx_integration_ingress_receipts_trigger_diagnostics
  ON public.integration_ingress_receipts (
    integration, camera_name, trigger_value_state, received_at DESC
  );

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081301_integration_ingress_receipts','Add bounded metadata-only integration request receipts and trigger-type diagnostics.')
ON CONFLICT(version) DO NOTHING;

-- Versioned, metadata-only evidence for ambiguous trigger aliases and the
-- existing reads targeted by duplicate submissions. Existing receipts remain
-- schema v1; new application writes explicitly identify schema v2.
ALTER TABLE public.integration_ingress_receipts
  ADD COLUMN IF NOT EXISTS receipt_schema_version SMALLINT NOT NULL DEFAULT 1
    CHECK (receipt_schema_version BETWEEN 1 AND 32767),
  ADD COLUMN IF NOT EXISTS trigger_alias_fields TEXT[] NOT NULL
    DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS trigger_alias_conflict BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS trigger_alias_distinct_value_count SMALLINT NOT NULL DEFAULT 0
    CHECK (trigger_alias_distinct_value_count BETWEEN 0 AND 3),
  ADD COLUMN IF NOT EXISTS duplicate_target_read_ids BIGINT[] NOT NULL
    DEFAULT ARRAY[]::BIGINT[];

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081302_ingress_receipt_diagnostics_v2','Version ingress receipts and add sanitized trigger-alias conflict plus duplicate-target read evidence.')
ON CONFLICT(version) DO NOTHING;

-- Sanitized, append-only application evidence for each accepted read. Events
-- follow the parent read lifecycle so existing read cleanup remains unchanged.
-- The details object is deliberately small and never stores plate text,
-- request bodies, images, paths, alternate trigger values, or credentials.
CREATE TABLE IF NOT EXISTS public.plate_read_pipeline_events (
  id BIGSERIAL PRIMARY KEY,
  read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE CASCADE,
  request_id VARCHAR(128),
  ingress_receipt_id BIGINT REFERENCES public.integration_ingress_receipts(id)
    ON DELETE SET NULL,
  stage VARCHAR(32) NOT NULL CHECK (
    stage IN ('ingress','direction','notifications','vehicle-view')
  ),
  event_type VARCHAR(96) NOT NULL CHECK (
    event_type ~ '^[a-z0-9][a-z0-9_.-]*$'
  ),
  status VARCHAR(32) NOT NULL CHECK (
    status IN ('accepted','succeeded','queued','skipped','partial','failed','completed')
  ),
  component VARCHAR(64) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (
    jsonb_typeof(details) = 'object' AND pg_column_size(details) <= 8192
  ),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_plate_read_pipeline_events_read
  ON public.plate_read_pipeline_events (read_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_plate_read_pipeline_events_request
  ON public.plate_read_pipeline_events (request_id)
  WHERE request_id IS NOT NULL;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081303_read_pipeline_timeline','Add sanitized append-only per-read pipeline events without changing read cleanup behavior.')
ON CONFLICT(version) DO NOTHING;

-- Immutable incident snapshots preserve a bounded, sanitized evidence package
-- before retention can remove source rows. A scope protects matching live rows
-- until protected_until, while the snapshot and its digest remain append-only.
CREATE TABLE IF NOT EXISTS public.logging_incidents (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  description VARCHAR(1000),
  scope_type VARCHAR(16) NOT NULL CHECK (
    scope_type IN ('request','read','window')
  ),
  request_id VARCHAR(128),
  read_id INTEGER,
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  protected_until TIMESTAMPTZ NOT NULL,
  snapshot_schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (
    snapshot_schema_version = 1
  ),
  snapshot JSONB NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 16777216
  ),
  snapshot_sha256 CHAR(64) NOT NULL CHECK (
    snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  evidence_counts JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (
    jsonb_typeof(evidence_counts) = 'object'
  ),
  created_by_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (protected_until > created_at),
  CHECK (
    (scope_type = 'request' AND NULLIF(BTRIM(request_id), '') IS NOT NULL
      AND read_id IS NULL AND window_start IS NULL AND window_end IS NULL)
    OR
    (scope_type = 'read' AND read_id IS NOT NULL
      AND request_id IS NULL AND window_start IS NULL AND window_end IS NULL)
    OR
    (scope_type = 'window' AND request_id IS NULL AND read_id IS NULL
      AND window_start IS NOT NULL AND window_end IS NOT NULL
      AND window_start < window_end)
  )
);

CREATE INDEX IF NOT EXISTS idx_logging_incidents_protection
  ON public.logging_incidents (protected_until DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_logging_incidents_request
  ON public.logging_incidents (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_logging_incidents_read
  ON public.logging_incidents (read_id) WHERE read_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_logging_incident_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'logging_incidents is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS logging_incidents_append_only ON public.logging_incidents;
CREATE TRIGGER logging_incidents_append_only
BEFORE UPDATE OR DELETE ON public.logging_incidents
FOR EACH ROW EXECUTE FUNCTION public.prevent_logging_incident_mutation();

-- Old audit rows move into an immutable, time-partitioned archive before the
-- hot table can release them. The default partition is bounded by the manual
-- preview batch; future releases may add narrower monthly partitions without
-- changing the archive contract.
CREATE TABLE IF NOT EXISTS public.audit_event_archive (
  source_event_id BIGINT NOT NULL,
  actor_user_id BIGINT,
  actor_api_credential_id BIGINT,
  source VARCHAR(20) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100),
  resource_id VARCHAR(255),
  outcome VARCHAR(20) NOT NULL,
  reason TEXT,
  request_id VARCHAR(100),
  metadata JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_preview_id BIGINT,
  PRIMARY KEY (source_event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS public.audit_event_archive_default
  PARTITION OF public.audit_event_archive DEFAULT;

CREATE INDEX IF NOT EXISTS idx_audit_event_archive_occurred
  ON public.audit_event_archive (occurred_at DESC, source_event_id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_archive_request
  ON public.audit_event_archive (request_id, occurred_at DESC)
  WHERE request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_audit_archive_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_event_archive is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_event_archive_append_only
  ON public.audit_event_archive;
CREATE TRIGGER audit_event_archive_append_only
BEFORE UPDATE OR DELETE ON public.audit_event_archive
FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_archive_mutation();

-- The hot audit table remains update-proof. A delete is permitted only after
-- an exact immutable archive copy exists, preserving the append-only evidence
-- contract while allowing the operational table to stay bounded.
CREATE OR REPLACE FUNCTION public.prevent_audit_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1
    FROM public.audit_event_archive archived
    WHERE archived.source_event_id = OLD.id
      AND archived.occurred_at = OLD.occurred_at
      AND archived.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
      AND archived.actor_api_credential_id IS NOT DISTINCT FROM OLD.actor_api_credential_id
      AND archived.source = OLD.source
      AND archived.event_type = OLD.event_type
      AND archived.resource_type IS NOT DISTINCT FROM OLD.resource_type
      AND archived.resource_id IS NOT DISTINCT FROM OLD.resource_id
      AND archived.outcome = OLD.outcome
      AND archived.reason IS NOT DISTINCT FROM OLD.reason
      AND archived.request_id IS NOT DISTINCT FROM OLD.request_id
      AND archived.metadata = OLD.metadata
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.logging_retention_previews (
  id BIGSERIAL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'previewed' CHECK (
    status IN ('previewed','executed','invalidated')
  ),
  policy JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  receipt_ids BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  audit_event_ids BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  candidate_bytes BIGINT NOT NULL DEFAULT 0 CHECK (candidate_bytes >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  executed_at TIMESTAMPTZ,
  result JSONB,
  CHECK (array_position(receipt_ids, NULL) IS NULL),
  CHECK (array_position(audit_event_ids, NULL) IS NULL),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'previewed' AND executed_at IS NULL)
    OR (status IN ('executed','invalidated') AND executed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_logging_retention_previews_actor
  ON public.logging_retention_previews (actor_user_id, created_at DESC);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081401_logging_retention_incidents','Add immutable incident snapshots, preview-bound log retention, and a partitioned append-only audit archive.')
ON CONFLICT(version) DO NOTHING;

-- Canonical, byte-addressed ownership for ready Overview JPEGs. This is an
-- inert catalog foundation: it does not queue work, backfill reads, alter the
-- current read-owned Vehicle View, or change the existing ReID pipeline.
CREATE TABLE IF NOT EXISTS public.vehicle_image_assets (
  id BIGSERIAL PRIMARY KEY,
  content_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  storage_path TEXT NOT NULL UNIQUE CHECK (
    storage_path = 'derived/vehicle-assets/'
      || SUBSTRING(content_sha256 FROM 1 FOR 2)
      || '/' || content_sha256 || '.jpg'
  ),
  media_type VARCHAR(40) NOT NULL DEFAULT 'image/jpeg' CHECK (
    media_type = 'image/jpeg'
  ),
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  image_width INTEGER NOT NULL CHECK (image_width > 0),
  image_height INTEGER NOT NULL CHECK (image_height > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION public.prevent_vehicle_image_asset_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'vehicle_image_assets content is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_image_assets_immutable
  ON public.vehicle_image_assets;
CREATE TRIGGER vehicle_image_assets_immutable
BEFORE UPDATE ON public.vehicle_image_assets
FOR EACH ROW EXECUTE FUNCTION public.prevent_vehicle_image_asset_update();

CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_reads (
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  read_id INTEGER NOT NULL REFERENCES public.plate_reads(id)
    ON DELETE CASCADE,
  source_kind VARCHAR(40) NOT NULL CHECK (
    source_kind IN (
      'overview_primary',
      'entry_overview_primary',
      'overview_fallback',
      'overview_pair_share',
      'entry_overview_route_fallback',
      'entry_overview_history'
    )
  ),
  source_read_id INTEGER REFERENCES public.plate_reads(id) ON DELETE SET NULL,
  relationship VARCHAR(24) NOT NULL CHECK (
    relationship IN ('primary','fallback','shared','display_fallback','history')
  ),
  identity_eligible BOOLEAN NOT NULL,
  overview_context VARCHAR(12) NOT NULL CHECK (
    overview_context IN ('street','entry')
  ),
  captured_at TIMESTAMPTZ,
  read_camera_name VARCHAR(120),
  source_camera_name VARCHAR(120),
  source_path_snapshot TEXT NOT NULL CHECK (
    NULLIF(BTRIM(source_path_snapshot), '') IS NOT NULL
  ),
  source_updated_at TIMESTAMPTZ,
  detection_confidence REAL CHECK (
    detection_confidence IS NULL
    OR detection_confidence BETWEEN 0 AND 1
  ),
  detection_box JSONB CHECK (
    detection_box IS NULL OR jsonb_typeof(detection_box) = 'object'
  ),
  selection_metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (
    jsonb_typeof(selection_metadata) = 'object'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (asset_id, read_id),
  UNIQUE (read_id),
  CHECK (
    (source_kind = 'overview_primary'
      AND source_read_id IS NULL
      AND relationship = 'primary'
      AND identity_eligible = TRUE
      AND overview_context = 'street')
    OR (source_kind = 'entry_overview_primary'
      AND source_read_id IS NULL
      AND relationship = 'primary'
      AND identity_eligible = TRUE
      AND overview_context = 'entry')
    OR (source_kind = 'overview_fallback'
      AND source_read_id IS NULL
      AND relationship = 'fallback'
      AND identity_eligible = TRUE
      AND overview_context = 'street')
    OR (source_kind = 'overview_pair_share'
      AND (source_read_id IS NULL OR source_read_id <> read_id)
      AND relationship = 'shared'
      AND identity_eligible = TRUE
      AND overview_context = 'street')
    OR (source_kind = 'entry_overview_route_fallback'
      AND (source_read_id IS NULL OR source_read_id <> read_id)
      AND relationship = 'display_fallback'
      AND identity_eligible = FALSE
      AND overview_context = 'entry')
    OR (source_kind = 'entry_overview_history'
      AND source_read_id IS NULL
      AND relationship = 'history'
      AND identity_eligible = TRUE
      AND overview_context = 'entry')
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_reads_source
  ON public.vehicle_image_asset_reads (source_read_id)
  WHERE source_read_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_reads_identity
  ON public.vehicle_image_asset_reads (overview_context, captured_at, read_id)
  WHERE identity_eligible = TRUE;

-- Storage reconciliation now treats canonical assets as first-class database
-- references. Defaults safely let an already-running pre-catalog scan finish.
ALTER TABLE public.storage_reconciliation_runs
  ADD COLUMN IF NOT EXISTS max_vehicle_image_asset_id BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vehicle_image_asset_cursor BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.storage_reconciliation_runs
  DROP CONSTRAINT IF EXISTS storage_reconciliation_phase;
ALTER TABLE public.storage_reconciliation_runs
  ADD CONSTRAINT storage_reconciliation_phase CHECK (
    phase IN (
      'filesystem', 'plate-reads', 'capture-assets',
      'vehicle-image-assets', 'completed'
    )
  );

ALTER TABLE public.storage_reconciliation_runs
  DROP CONSTRAINT IF EXISTS storage_reconciliation_counts;
ALTER TABLE public.storage_reconciliation_runs
  ADD CONSTRAINT storage_reconciliation_counts CHECK (
    max_plate_read_id >= 0 AND max_capture_asset_id >= 0
    AND max_vehicle_image_asset_id >= 0
    AND plate_read_cursor >= 0 AND capture_asset_cursor >= 0
    AND vehicle_image_asset_cursor >= 0
    AND files_scanned >= 0 AND bytes_scanned >= 0
    AND references_checked >= 0 AND recent_files_skipped >= 0
    AND skipped_entries >= 0 AND error_count >= 0
    AND orphan_files >= 0 AND orphan_bytes >= 0
    AND missing_reference_paths >= 0
  );

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081402_vehicle_image_asset_foundation','Add an inert canonical Overview JPEG catalog, read provenance links, and storage-reference protection.')
ON CONFLICT(version) DO NOTHING;

-- Operator-controlled, preview-first population of the canonical Overview
-- catalog. Creating a run only freezes eligible read snapshots. A dedicated
-- worker hashes and validates those source JPEGs without publishing files;
-- canonical storage is written only after an operator confirms a bounded
-- batch against the exact completed preview fingerprint.
CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_catalog_runs (
  id BIGSERIAL PRIMARY KEY,
  phase VARCHAR(16) NOT NULL DEFAULT 'preview' CHECK (
    phase IN ('preview','catalog','completed')
  ),
  status VARCHAR(16) NOT NULL DEFAULT 'previewing' CHECK (
    status IN ('previewing','ready','running','paused','completed','cancelled','failed')
  ),
  max_read_id INTEGER NOT NULL CHECK (max_read_id >= 0),
  preview_cursor_read_id INTEGER NOT NULL DEFAULT 0 CHECK (
    preview_cursor_read_id >= 0 AND preview_cursor_read_id <= max_read_id
  ),
  candidate_reads INTEGER NOT NULL DEFAULT 0 CHECK (candidate_reads >= 0),
  batch_size INTEGER NOT NULL DEFAULT 5 CHECK (
    batch_size IN (1,5,25,250)
  ),
  preview_fingerprint CHAR(64) CHECK (
    preview_fingerprint IS NULL OR preview_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  actor_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  confirmed_actor_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
  last_error_code VARCHAR(80),
  last_error_details JSONB CHECK (
    last_error_details IS NULL OR jsonb_typeof(last_error_details) = 'object'
  ),
  confirmed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'previewing' AND phase = 'preview' AND preview_fingerprint IS NULL)
    OR (status IN ('ready','running') AND phase = 'catalog' AND preview_fingerprint IS NOT NULL)
    OR (status = 'paused')
    OR (status = 'completed' AND phase = 'completed' AND preview_fingerprint IS NOT NULL)
    OR (status IN ('cancelled','failed'))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_image_asset_catalog_one_active
  ON public.vehicle_image_asset_catalog_runs ((TRUE))
  WHERE status IN ('previewing','ready','running','paused');

CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_catalog_items (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.vehicle_image_asset_catalog_runs(id)
    ON DELETE RESTRICT,
  -- This is an immutable snapshot identifier, not a live ownership edge.
  -- Keeping it scalar preserves campaign evidence without blocking the
  -- application's existing single-read deletion flow.
  read_id INTEGER NOT NULL,
  snapshot_fingerprint CHAR(64) NOT NULL CHECK (
    snapshot_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  read_camera_name VARCHAR(120),
  read_timestamp TIMESTAMPTZ NOT NULL,
  source_status VARCHAR(20) NOT NULL CHECK (source_status = 'ready'),
  source_path TEXT NOT NULL CHECK (NULLIF(BTRIM(source_path), '') IS NOT NULL),
  source_kind VARCHAR(40) NOT NULL CHECK (
    source_kind IN (
      'overview_primary',
      'entry_overview_primary',
      'overview_fallback',
      'overview_pair_share',
      'entry_overview_route_fallback',
      'entry_overview_history'
    )
  ),
  -- Preserve the exact source-read provenance that was fingerprinted even if
  -- the live source read is later deleted.
  source_read_id INTEGER,
  source_updated_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ,
  source_score REAL,
  -- These are lossless evidence snapshots. Legacy malformed metadata must be
  -- materialized and terminalized per item, never abort the entire preview.
  detection_confidence REAL,
  detection_box JSONB,
  source_width INTEGER,
  source_height INTEGER,
  sampled_count SMALLINT,
  selection_metadata JSONB,
  prior_link_state VARCHAR(12) NOT NULL CHECK (
    prior_link_state IN ('absent','stale')
  ),
  preview_sha256 CHAR(64) CHECK (
    preview_sha256 IS NULL OR preview_sha256 ~ '^[0-9a-f]{64}$'
  ),
  preview_byte_size BIGINT CHECK (preview_byte_size IS NULL OR preview_byte_size > 0),
  preview_width INTEGER CHECK (preview_width IS NULL OR preview_width > 0),
  preview_height INTEGER CHECK (preview_height IS NULL OR preview_height > 0),
  canonical_path TEXT CHECK (
    canonical_path IS NULL OR canonical_path = 'derived/vehicle-assets/'
      || SUBSTRING(preview_sha256 FROM 1 FOR 2)
      || '/' || preview_sha256 || '.jpg'
  ),
  status VARCHAR(20) NOT NULL DEFAULT 'pending_preview' CHECK (
    status IN (
      'pending_preview','previewing','previewed','queued','processing',
      'cataloged','already_current','superseded','unavailable','invalid',
      'failed','cancelled'
    )
  ),
  failure_stage VARCHAR(12) CHECK (
    failure_stage IS NULL OR failure_stage IN ('preview','catalog')
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (
    operator_retry_count BETWEEN 0 AND 1
  ),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token UUID,
  heartbeat_at TIMESTAMPTZ,
  processing_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR jsonb_typeof(error_details) = 'object'
  ),
  asset_id BIGINT REFERENCES public.vehicle_image_assets(id) ON DELETE SET NULL,
  previewed_at TIMESTAMPTZ,
  cataloged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, read_id),
  CHECK (
    (status IN ('previewed','queued','processing','cataloged','already_current')
      AND preview_sha256 IS NOT NULL
      AND preview_byte_size IS NOT NULL
      AND preview_width IS NOT NULL
      AND preview_height IS NOT NULL
      AND canonical_path IS NOT NULL)
    OR status NOT IN ('previewed','queued','processing','cataloged','already_current')
  ),
  CHECK (
    (status IN ('previewing','processing')
      AND claim_token IS NOT NULL
      AND processing_deadline_at IS NOT NULL)
    OR (status NOT IN ('previewing','processing')
      AND claim_token IS NULL
      AND processing_deadline_at IS NULL)
  ),
  CHECK (
    (status = 'failed' AND failure_stage IS NOT NULL AND error_code IS NOT NULL)
    OR status <> 'failed'
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_catalog_items_run
  ON public.vehicle_image_asset_catalog_items (run_id, status, read_id, id);
CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_catalog_items_claim
  ON public.vehicle_image_asset_catalog_items (run_id, next_attempt_at, read_id, id)
  WHERE status IN ('pending_preview','previewing','queued','processing','failed');
CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_catalog_items_hash
  ON public.vehicle_image_asset_catalog_items (run_id, preview_sha256)
  WHERE preview_sha256 IS NOT NULL;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081403_vehicle_image_asset_catalog_campaign','Add a durable preview-first, operator-confirmed campaign for canonical Overview assets.')
ON CONFLICT(version) DO NOTHING;

-- Durable, default-off cataloging for Overview images that become ready after
-- the initial operator campaign. The live worker is additionally gated on a
-- completed campaign and yields whenever an operator campaign is active. No
-- jobs are inserted by the migration, and current Vehicle View readiness does
-- not depend on this queue.
CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_live_catalog_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (enabled = TRUE AND enabled_at IS NOT NULL)
    OR enabled = FALSE
  )
);

INSERT INTO public.vehicle_image_asset_live_catalog_control (
  singleton, enabled, enabled_by_user_id, enabled_at, disabled_at
) VALUES (TRUE, FALSE, NULL, NULL, CURRENT_TIMESTAMP)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_image_asset_live_catalog_jobs (
  id BIGSERIAL PRIMARY KEY,
  -- Deliberately not a foreign key: durable job evidence must not block the
  -- existing single-read deletion lifecycle.
  read_id INTEGER NOT NULL UNIQUE CHECK (read_id > 0),
  source_path_snapshot TEXT NOT NULL CHECK (
    NULLIF(BTRIM(source_path_snapshot), '') IS NOT NULL
  ),
  source_kind_snapshot VARCHAR(40) NOT NULL CHECK (
    source_kind_snapshot IN (
      'overview_primary',
      'entry_overview_primary',
      'overview_fallback',
      'overview_pair_share',
      'entry_overview_route_fallback',
      'entry_overview_history'
    )
  ),
  source_updated_at_snapshot TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued','processing','cataloged','superseded',
      'unavailable','invalid','failed'
    )
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND 5
  ),
  operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (
    operator_retry_count BETWEEN 0 AND 1
  ),
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  claim_token UUID,
  heartbeat_at TIMESTAMPTZ,
  processing_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR jsonb_typeof(error_details) = 'object'
  ),
  asset_id BIGINT REFERENCES public.vehicle_image_assets(id) ON DELETE SET NULL,
  cataloged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL
      AND processing_deadline_at IS NOT NULL)
    OR (status <> 'processing' AND claim_token IS NULL
      AND processing_deadline_at IS NULL)
  ),
  CHECK (
    (status = 'cataloged' AND asset_id IS NOT NULL AND cataloged_at IS NOT NULL)
    OR status <> 'cataloged'
  ),
  CHECK (
    (status IN ('superseded','unavailable','invalid','failed')
      AND error_code IS NOT NULL)
    OR status NOT IN ('superseded','unavailable','invalid','failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_live_catalog_claim
  ON public.vehicle_image_asset_live_catalog_jobs (
    next_attempt_at, read_id, id
  ) WHERE status IN ('queued','processing','failed');
CREATE INDEX IF NOT EXISTS idx_vehicle_image_asset_live_catalog_status
  ON public.vehicle_image_asset_live_catalog_jobs (status, updated_at DESC, id DESC);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081404_vehicle_image_asset_live_catalog','Add default-off, post-campaign automatic cataloging for newly ready Overview assets.')
ON CONFLICT(version) DO NOTHING;

-- Provider-neutral shadow passage events built only from current,
-- identity-eligible canonical Overview links. The correlator is default-off,
-- never gates ingestion or Vehicle View readiness, and does not alter the
-- current ReID, cluster, attribute, notification, or plate-review paths.
CREATE TABLE IF NOT EXISTS public.vehicle_event_shadow_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  settle_seconds INTEGER NOT NULL DEFAULT 20 CHECK (
    settle_seconds BETWEEN 5 AND 300
  ),
  batch_size INTEGER NOT NULL DEFAULT 25 CHECK (
    batch_size IN (5,25,100)
  ),
  enabled_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((enabled = TRUE AND enabled_at IS NOT NULL) OR enabled = FALSE)
);

INSERT INTO public.vehicle_event_shadow_control (
  singleton, enabled, settle_seconds, batch_size, disabled_at
) VALUES (TRUE, FALSE, 20, 25, CURRENT_TIMESTAMP)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_events (
  id BIGSERIAL PRIMARY KEY,
  event_identity CHAR(64) NOT NULL UNIQUE CHECK (
    event_identity ~ '^[0-9a-f]{64}$'
  ),
  status VARCHAR(16) NOT NULL DEFAULT 'shadow' CHECK (
    status IN ('shadow','retired')
  ),
  overview_context VARCHAR(12) NOT NULL CHECK (
    overview_context IN ('street','entry')
  ),
  correlation_class VARCHAR(20) NOT NULL CHECK (
    correlation_class IN ('shared_asset','timed_pair')
  ),
  event_timestamp TIMESTAMPTZ NOT NULL,
  first_read_at TIMESTAMPTZ NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL,
  effective_plate_snapshot VARCHAR(32) NOT NULL CHECK (
    NULLIF(BTRIM(effective_plate_snapshot), '') IS NOT NULL
  ),
  direction_label_snapshot VARCHAR(100),
  correlation_algorithm VARCHAR(80) NOT NULL,
  correlation_revision INTEGER NOT NULL DEFAULT 1 CHECK (
    correlation_revision > 0
  ),
  decision_metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (
    jsonb_typeof(decision_metadata) = 'object'
  ),
  retired_reason VARCHAR(80),
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (first_read_at <= last_read_at),
  CHECK (
    (status = 'shadow' AND retired_reason IS NULL AND retired_at IS NULL)
    OR (status = 'retired' AND retired_reason IS NOT NULL AND retired_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_events_shadow_recent
  ON public.vehicle_events (event_timestamp DESC, id DESC)
  WHERE status = 'shadow';

CREATE TABLE IF NOT EXISTS public.vehicle_event_reads (
  event_id BIGINT NOT NULL REFERENCES public.vehicle_events(id) ON DELETE CASCADE,
  -- Immutable evidence scalar: event history must not block single-read deletion.
  read_id INTEGER NOT NULL CHECK (read_id > 0),
  role VARCHAR(16) NOT NULL CHECK (role IN ('anchor','companion')),
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  read_camera_name VARCHAR(120) NOT NULL CHECK (
    NULLIF(BTRIM(read_camera_name), '') IS NOT NULL
  ),
  read_timestamp TIMESTAMPTZ NOT NULL,
  effective_plate_snapshot VARCHAR(32) NOT NULL CHECK (
    NULLIF(BTRIM(effective_plate_snapshot), '') IS NOT NULL
  ),
  direction_status_snapshot VARCHAR(20),
  direction_label_snapshot VARCHAR(100),
  source_kind_snapshot VARCHAR(40) NOT NULL,
  source_read_id_snapshot INTEGER,
  source_path_snapshot TEXT NOT NULL CHECK (
    NULLIF(BTRIM(source_path_snapshot), '') IS NOT NULL
  ),
  source_updated_at_snapshot TIMESTAMPTZ,
  captured_at_snapshot TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, read_id),
  CHECK (
    direction_status_snapshot IS DISTINCT FROM 'ready'
    OR NULLIF(BTRIM(direction_label_snapshot), '') IS NOT NULL
  ),
  CHECK (source_kind_snapshot IN (
    'overview_primary','entry_overview_primary','overview_fallback',
    'overview_pair_share','entry_overview_history'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_event_reads_one_active_event
  ON public.vehicle_event_reads (read_id)
  WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_vehicle_event_reads_asset
  ON public.vehicle_event_reads (asset_id, event_id);

CREATE TABLE IF NOT EXISTS public.vehicle_event_assets (
  event_id BIGINT NOT NULL REFERENCES public.vehicle_events(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  role VARCHAR(16) NOT NULL CHECK (role IN ('primary','supporting')),
  identity_eligible BOOLEAN NOT NULL DEFAULT TRUE CHECK (
    identity_eligible = TRUE
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, asset_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_event_assets_one_primary
  ON public.vehicle_event_assets (event_id)
  WHERE role = 'primary';
CREATE INDEX IF NOT EXISTS idx_vehicle_event_assets_asset
  ON public.vehicle_event_assets (asset_id, event_id);

CREATE TABLE IF NOT EXISTS public.vehicle_event_shadow_decisions (
  id BIGSERIAL PRIMARY KEY,
  decision_identity CHAR(64) NOT NULL UNIQUE CHECK (
    decision_identity ~ '^[0-9a-f]{64}$'
  ),
  event_id BIGINT REFERENCES public.vehicle_events(id) ON DELETE RESTRICT,
  outcome VARCHAR(16) NOT NULL CHECK (
    outcome IN ('proposed','rejected')
  ),
  reason VARCHAR(80) NOT NULL CHECK (NULLIF(BTRIM(reason), '') IS NOT NULL),
  overview_context VARCHAR(12) NOT NULL CHECK (
    overview_context IN ('street','entry')
  ),
  anchor_read_id INTEGER NOT NULL CHECK (anchor_read_id > 0),
  companion_read_id INTEGER CHECK (
    companion_read_id IS NULL OR companion_read_id > 0
  ),
  anchor_asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  companion_asset_id BIGINT REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  anchor_source_kind VARCHAR(40) NOT NULL,
  anchor_source_read_id INTEGER,
  anchor_source_path TEXT NOT NULL CHECK (
    NULLIF(BTRIM(anchor_source_path), '') IS NOT NULL
  ),
  anchor_source_updated_at TIMESTAMPTZ,
  anchor_captured_at TIMESTAMPTZ,
  anchor_plate_snapshot VARCHAR(32) NOT NULL,
  anchor_direction_status VARCHAR(20),
  anchor_direction_label VARCHAR(100),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  correlation_algorithm VARCHAR(80) NOT NULL,
  decision_metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (
    jsonb_typeof(decision_metadata) = 'object'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (outcome = 'proposed' AND event_id IS NOT NULL
      AND companion_read_id IS NOT NULL AND companion_asset_id IS NOT NULL)
    OR (outcome = 'rejected' AND event_id IS NULL)
  ),
  CHECK (anchor_source_kind IN (
    'overview_primary','entry_overview_primary','overview_fallback',
    'overview_pair_share','entry_overview_history'
  ))
);

CREATE INDEX IF NOT EXISTS idx_vehicle_event_shadow_decisions_anchor
  ON public.vehicle_event_shadow_decisions (
    anchor_read_id, created_at DESC, id DESC
  );
CREATE INDEX IF NOT EXISTS idx_vehicle_event_shadow_decisions_recent
  ON public.vehicle_event_shadow_decisions (created_at DESC, id DESC);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081405_vehicle_event_shadow_correlation','Add default-off provider-neutral shadow correlation for conservative paired canonical Overview observations.')
ON CONFLICT(version) DO NOTHING;

-- Asset-owned vehicle crops derived from immutable canonical Overview JPEGs.
-- The migration is deliberately inert: it creates no run, job, derivative,
-- file, embedding, attribute, ReID result, or external-provider request.
CREATE TABLE IF NOT EXISTS public.vehicle_image_derivatives (
  id BIGSERIAL PRIMARY KEY,
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  derivative_kind VARCHAR(32) NOT NULL CHECK (
    derivative_kind = 'vehicle_crop'
  ),
  algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(algorithm_version), '') IS NOT NULL
  ),
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  content_sha256 CHAR(64) NOT NULL CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  storage_path TEXT NOT NULL CHECK (
    storage_path = 'derived/vehicle-crops/'
      || SUBSTRING(content_sha256 FROM 1 FOR 2)
      || '/' || content_sha256 || '.jpg'
  ),
  media_type VARCHAR(40) NOT NULL DEFAULT 'image/jpeg' CHECK (
    media_type = 'image/jpeg'
  ),
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  image_width INTEGER NOT NULL CHECK (image_width > 0),
  image_height INTEGER NOT NULL CHECK (image_height > 0),
  crop_box JSONB NOT NULL CHECK (
    jsonb_typeof(crop_box) = 'object'
    AND crop_box ?& ARRAY['left','top','width','height','paddingRatio']
    AND jsonb_typeof(crop_box->'left') = 'number'
    AND jsonb_typeof(crop_box->'top') = 'number'
    AND jsonb_typeof(crop_box->'width') = 'number'
    AND jsonb_typeof(crop_box->'height') = 'number'
    AND jsonb_typeof(crop_box->'paddingRatio') = 'number'
    AND (crop_box->>'left')::integer >= 0
    AND (crop_box->>'top')::integer >= 0
    AND (crop_box->>'width')::integer > 0
    AND (crop_box->>'height')::integer > 0
    AND (crop_box->>'paddingRatio')::numeric BETWEEN 0 AND 0.5
  ),
  detector_model VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(detector_model), '') IS NOT NULL
  ),
  detection_confidence REAL CHECK (
    detection_confidence IS NULL OR detection_confidence BETWEEN 0 AND 1
  ),
  evidence_read_id INTEGER NOT NULL CHECK (evidence_read_id > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (asset_id, derivative_kind, algorithm_version)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_image_derivatives_content
  ON public.vehicle_image_derivatives (content_sha256, id);
CREATE INDEX IF NOT EXISTS idx_vehicle_image_derivatives_storage
  ON public.vehicle_image_derivatives (storage_path, id);

CREATE OR REPLACE FUNCTION public.prevent_vehicle_image_derivative_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'vehicle_image_derivatives content is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_image_derivatives_immutable
  ON public.vehicle_image_derivatives;
CREATE TRIGGER vehicle_image_derivatives_immutable
BEFORE UPDATE ON public.vehicle_image_derivatives
FOR EACH ROW EXECUTE FUNCTION public.prevent_vehicle_image_derivative_update();

CREATE TABLE IF NOT EXISTS public.vehicle_image_crop_runs (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(16) NOT NULL DEFAULT 'previewing' CHECK (
    status IN ('previewing','ready','running','paused','completed','cancelled','failed')
  ),
  max_asset_id BIGINT NOT NULL CHECK (max_asset_id >= 0),
  preview_fingerprint CHAR(64) CHECK (
    preview_fingerprint IS NULL OR preview_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  batch_size INTEGER NOT NULL DEFAULT 5 CHECK (
    batch_size IN (1,5,25,250)
  ),
  actor_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  confirmed_actor_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
  confirmed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code VARCHAR(80),
  last_error_details JSONB CHECK (
    last_error_details IS NULL OR jsonb_typeof(last_error_details) = 'object'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'previewing' AND preview_fingerprint IS NULL)
    OR (status IN ('ready','running','paused','completed')
      AND preview_fingerprint IS NOT NULL)
    OR status IN ('cancelled','failed')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_image_crop_one_active
  ON public.vehicle_image_crop_runs ((TRUE))
  WHERE status IN ('previewing','ready','running','paused');

CREATE TABLE IF NOT EXISTS public.vehicle_image_crop_jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.vehicle_image_crop_runs(id)
    ON DELETE RESTRICT,
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_path TEXT NOT NULL CHECK (NULLIF(BTRIM(source_path), '') IS NOT NULL),
  source_width INTEGER NOT NULL CHECK (source_width > 0),
  source_height INTEGER NOT NULL CHECK (source_height > 0),
  evidence_read_id INTEGER NOT NULL CHECK (evidence_read_id > 0),
  evidence_source_kind VARCHAR(40) NOT NULL,
  evidence_source_path TEXT NOT NULL CHECK (
    NULLIF(BTRIM(evidence_source_path), '') IS NOT NULL
  ),
  evidence_source_updated_at TIMESTAMPTZ,
  detection_box JSONB,
  detection_confidence REAL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_preview' CHECK (
    status IN (
      'pending_preview','previewing','previewed','queued','processing',
      'ready','already_current','source_changed','invalid','failed','cancelled'
    )
  ),
  failure_stage VARCHAR(12) CHECK (
    failure_stage IS NULL OR failure_stage IN ('preview','catalog')
  ),
  preview_sha256 CHAR(64) CHECK (
    preview_sha256 IS NULL OR preview_sha256 ~ '^[0-9a-f]{64}$'
  ),
  preview_path TEXT CHECK (
    preview_path IS NULL OR preview_path = 'derived/vehicle-crops/'
      || SUBSTRING(preview_sha256 FROM 1 FOR 2)
      || '/' || preview_sha256 || '.jpg'
  ),
  preview_byte_size BIGINT CHECK (
    preview_byte_size IS NULL OR preview_byte_size > 0
  ),
  preview_width INTEGER CHECK (preview_width IS NULL OR preview_width > 0),
  preview_height INTEGER CHECK (preview_height IS NULL OR preview_height > 0),
  preview_crop_box JSONB CHECK (
    preview_crop_box IS NULL OR jsonb_typeof(preview_crop_box) = 'object'
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (
    operator_retry_count BETWEEN 0 AND 1
  ),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token UUID,
  processing_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR jsonb_typeof(error_details) = 'object'
  ),
  derivative_id BIGINT REFERENCES public.vehicle_image_derivatives(id)
    ON DELETE SET NULL,
  previewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, asset_id),
  CHECK (
    (status IN ('previewed','queued','processing','ready','already_current')
      AND preview_sha256 IS NOT NULL AND preview_path IS NOT NULL
      AND preview_byte_size IS NOT NULL AND preview_width IS NOT NULL
      AND preview_height IS NOT NULL AND preview_crop_box IS NOT NULL)
    OR status NOT IN ('previewed','queued','processing','ready','already_current')
  ),
  CHECK (
    (status IN ('previewing','processing')
      AND claim_token IS NOT NULL AND processing_deadline_at IS NOT NULL)
    OR (status NOT IN ('previewing','processing')
      AND claim_token IS NULL AND processing_deadline_at IS NULL)
  ),
  CHECK (
    (status IN ('source_changed','invalid','failed') AND error_code IS NOT NULL)
    OR status NOT IN ('source_changed','invalid','failed')
  ),
  CHECK (
    (status IN ('ready','already_current')
      AND derivative_id IS NOT NULL AND completed_at IS NOT NULL)
    OR status NOT IN ('ready','already_current')
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_image_crop_jobs_claim
  ON public.vehicle_image_crop_jobs (
    run_id, status, next_attempt_at, asset_id, id
  ) WHERE status IN (
    'pending_preview','previewing','queued','processing','failed'
  );
CREATE INDEX IF NOT EXISTS idx_vehicle_image_crop_jobs_hash
  ON public.vehicle_image_crop_jobs (run_id, preview_sha256)
  WHERE preview_sha256 IS NOT NULL;

ALTER TABLE public.storage_reconciliation_runs
  ADD COLUMN IF NOT EXISTS max_vehicle_image_derivative_id BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vehicle_image_derivative_cursor BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.storage_reconciliation_runs
  DROP CONSTRAINT IF EXISTS storage_reconciliation_phase;
ALTER TABLE public.storage_reconciliation_runs
  ADD CONSTRAINT storage_reconciliation_phase CHECK (
    phase IN (
      'filesystem', 'plate-reads', 'capture-assets',
      'vehicle-image-assets', 'vehicle-image-derivatives', 'completed'
    )
  );

ALTER TABLE public.storage_reconciliation_runs
  DROP CONSTRAINT IF EXISTS storage_reconciliation_counts;
ALTER TABLE public.storage_reconciliation_runs
  ADD CONSTRAINT storage_reconciliation_counts CHECK (
    max_plate_read_id >= 0 AND max_capture_asset_id >= 0
    AND max_vehicle_image_asset_id >= 0
    AND max_vehicle_image_derivative_id >= 0
    AND plate_read_cursor >= 0 AND capture_asset_cursor >= 0
    AND vehicle_image_asset_cursor >= 0
    AND vehicle_image_derivative_cursor >= 0
    AND files_scanned >= 0 AND bytes_scanned >= 0
    AND references_checked >= 0 AND recent_files_skipped >= 0
    AND skipped_entries >= 0 AND error_count >= 0
    AND orphan_files >= 0 AND orphan_bytes >= 0
    AND missing_reference_paths >= 0
  );

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081406_vehicle_image_crop_campaign','Add inert asset-owned canonical Overview vehicle crops with preview-first bounded operator batches and storage-reference protection.')
ON CONFLICT(version) DO NOTHING;

-- Durable, default-off crop generation for canonical Overview assets that
-- become identity-eligible after the operator-controlled crop campaign. The
-- migration queues no work. The low-priority worker reuses the exact campaign
-- crop algorithm and yields whenever an operator crop campaign is active.
CREATE TABLE IF NOT EXISTS public.vehicle_image_crop_live_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (enabled = TRUE AND enabled_at IS NOT NULL)
    OR enabled = FALSE
  )
);

INSERT INTO public.vehicle_image_crop_live_control (
  singleton, enabled, enabled_by_user_id, enabled_at, disabled_at
) VALUES (TRUE, FALSE, NULL, NULL, CURRENT_TIMESTAMP)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vehicle_image_crop_live_jobs (
  id BIGSERIAL PRIMARY KEY,
  -- Snapshot scalars deliberately avoid foreign keys so durable worker
  -- evidence cannot block existing read or future asset-retention workflows.
  asset_id BIGINT NOT NULL UNIQUE CHECK (asset_id > 0),
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_path TEXT NOT NULL CHECK (NULLIF(BTRIM(source_path), '') IS NOT NULL),
  source_width INTEGER NOT NULL CHECK (source_width > 0),
  source_height INTEGER NOT NULL CHECK (source_height > 0),
  evidence_read_id INTEGER NOT NULL CHECK (evidence_read_id > 0),
  evidence_source_kind VARCHAR(40) NOT NULL CHECK (
    evidence_source_kind IN (
      'overview_primary','entry_overview_primary','overview_fallback',
      'overview_pair_share','entry_overview_route_fallback',
      'entry_overview_history'
    )
  ),
  evidence_source_path TEXT NOT NULL CHECK (
    NULLIF(BTRIM(evidence_source_path), '') IS NOT NULL
  ),
  evidence_source_updated_at TIMESTAMPTZ,
  detection_box JSONB NOT NULL CHECK (
    jsonb_typeof(detection_box) = 'object'
    AND detection_box ?& ARRAY['left','top','right','bottom']
  ),
  detection_confidence REAL CHECK (
    detection_confidence IS NULL
    OR (detection_confidence >= 0 AND detection_confidence <= 1)
  ),
  status VARCHAR(24) NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued','processing','ready','already_current','source_changed',
      'unavailable','invalid','failed'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
    attempt_count >= 0 AND attempt_count <= 5
  ),
  operator_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (
    operator_retry_count >= 0 AND operator_retry_count <= 1
  ),
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  claim_token UUID,
  heartbeat_at TIMESTAMPTZ,
  processing_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR jsonb_typeof(error_details) = 'object'
  ),
  derivative_id BIGINT REFERENCES public.vehicle_image_derivatives(id)
    ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'processing'
      AND claim_token IS NOT NULL AND processing_deadline_at IS NOT NULL)
    OR (status <> 'processing'
      AND claim_token IS NULL AND processing_deadline_at IS NULL)
  ),
  CHECK (
    (status IN ('source_changed','unavailable','invalid','failed')
      AND error_code IS NOT NULL)
    OR status NOT IN ('source_changed','unavailable','invalid','failed')
  ),
  CHECK (
    (status IN ('ready','already_current')
      AND derivative_id IS NOT NULL AND completed_at IS NOT NULL)
    OR status NOT IN ('ready','already_current')
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_image_crop_live_claim
  ON public.vehicle_image_crop_live_jobs (
    next_attempt_at, asset_id, id
  ) WHERE status IN ('queued','processing','failed');
CREATE INDEX IF NOT EXISTS idx_vehicle_image_crop_live_status
  ON public.vehicle_image_crop_live_jobs (status, updated_at DESC, id DESC);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081501_vehicle_image_crop_live_worker','Add default-off automatic canonical Overview crop generation after a completed operator crop campaign.')
ON CONFLICT(version) DO NOTHING;

-- Operator-selected repair of genuinely clipped or overly tight direct
-- Overview images. Preview rows freeze the original ready image and its
-- acquisition profile. No migration work is queued, and the original image
-- remains the current Vehicle View until a replacement proves materially more
-- complete. Blur, exposure, and multi-vehicle review findings are never repair
-- eligibility by themselves.
ALTER TABLE public.plate_reads
  DROP CONSTRAINT IF EXISTS plate_reads_vehicle_image_queue_kind_check;
ALTER TABLE public.plate_reads
  ADD CONSTRAINT plate_reads_vehicle_image_queue_kind_check CHECK (
    vehicle_image_queue_kind IS NULL OR
    vehicle_image_queue_kind IN (
      'live','historical','manual','overview','overview_backfill','overview_repair'
    )
  );

CREATE TABLE IF NOT EXISTS public.vehicle_overview_framing_repair_runs (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(16) NOT NULL DEFAULT 'previewed' CHECK (
    status IN ('previewed','running','completed','cancelled')
  ),
  preview_fingerprint CHAR(64) NOT NULL CHECK (
    preview_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  created_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  confirmed_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_overview_framing_repair_one_active
  ON public.vehicle_overview_framing_repair_runs ((TRUE))
  WHERE status IN ('previewed','running');

CREATE TABLE IF NOT EXISTS public.vehicle_overview_framing_repair_jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.vehicle_overview_framing_repair_runs(id)
    ON DELETE CASCADE,
  -- Snapshot scalars intentionally have no plate_reads foreign key. Durable
  -- repair evidence must not block the existing per-read delete operation.
  read_id INTEGER NOT NULL CHECK (read_id > 0),
  plate_number VARCHAR(32),
  camera_name VARCHAR(120) NOT NULL CHECK (NULLIF(BTRIM(camera_name), '') IS NOT NULL),
  read_timestamp_text TEXT NOT NULL CHECK (NULLIF(BTRIM(read_timestamp_text), '') IS NOT NULL),
  direction_label VARCHAR(80),
  prior_image_path TEXT NOT NULL CHECK (NULLIF(BTRIM(prior_image_path), '') IS NOT NULL),
  prior_image_status VARCHAR(24) NOT NULL CHECK (prior_image_status = 'ready'),
  prior_queue_kind VARCHAR(24),
  prior_attempt_count INTEGER NOT NULL CHECK (prior_attempt_count >= 0),
  prior_retryable BOOLEAN NOT NULL,
  prior_error_code VARCHAR(80),
  prior_source_kind VARCHAR(40) NOT NULL CHECK (
    prior_source_kind IN ('overview_primary','entry_overview_primary')
  ),
  prior_source_read_id INTEGER,
  prior_image_timestamp_text TEXT,
  prior_image_score REAL,
  prior_detection_confidence REAL CHECK (
    prior_detection_confidence IS NULL
    OR (prior_detection_confidence >= 0 AND prior_detection_confidence <= 1)
  ),
  prior_detection_box JSONB CHECK (
    prior_detection_box IS NULL OR jsonb_typeof(prior_detection_box) = 'object'
  ),
  prior_image_width INTEGER CHECK (prior_image_width IS NULL OR prior_image_width > 0),
  prior_image_height INTEGER CHECK (prior_image_height IS NULL OR prior_image_height > 0),
  prior_sampled_count INTEGER CHECK (prior_sampled_count IS NULL OR prior_sampled_count >= 0),
  prior_selection_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(prior_selection_metadata) = 'object'
  ),
  prior_image_updated_at_text TEXT NOT NULL CHECK (
    NULLIF(BTRIM(prior_image_updated_at_text), '') IS NOT NULL
  ),
  audited_detection_box JSONB NOT NULL CHECK (
    jsonb_typeof(audited_detection_box) = 'object'
    AND audited_detection_box ?& ARRAY['left','top','right','bottom']
  ),
  audited_completeness_tier SMALLINT NOT NULL CHECK (
    audited_completeness_tier IN (0,1)
  ),
  audited_edge_margin REAL NOT NULL CHECK (audited_edge_margin >= 0 AND audited_edge_margin < 0.015),
  audited_edge_contacts SMALLINT NOT NULL CHECK (audited_edge_contacts BETWEEN 0 AND 4),
  repair_reason VARCHAR(40) NOT NULL CHECK (
    repair_reason IN ('VEHICLE_TOUCHES_IMAGE_EDGE','VEHICLE_FRAMING_TOO_TIGHT')
  ),
  profile_id BIGINT NOT NULL CHECK (profile_id > 0),
  profile_revision BIGINT NOT NULL CHECK (profile_revision > 0),
  overview_context VARCHAR(12) NOT NULL CHECK (overview_context IN ('street','entry')),
  source_camera_name VARCHAR(120) NOT NULL CHECK (NULLIF(BTRIM(source_camera_name), '') IS NOT NULL),
  source_camera_short_name VARCHAR(80),
  expected_delta_ms INTEGER NOT NULL CHECK (ABS(expected_delta_ms) <= 30000),
  tolerance_ms INTEGER NOT NULL CHECK (tolerance_ms BETWEEN 250 AND 3000),
  status VARCHAR(20) NOT NULL DEFAULT 'previewed' CHECK (
    status IN (
      'previewed','queued','processing','repaired','preserved',
      'source_changed','unavailable','failed','cancelled'
    )
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  claim_token UUID,
  heartbeat_at TIMESTAMPTZ,
  processing_deadline_at TIMESTAMPTZ,
  hard_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR jsonb_typeof(error_details) = 'object'
  ),
  replacement_image_path TEXT,
  replacement_detection_box JSONB CHECK (
    replacement_detection_box IS NULL OR jsonb_typeof(replacement_detection_box) = 'object'
  ),
  replacement_completeness_tier SMALLINT CHECK (
    replacement_completeness_tier IS NULL OR replacement_completeness_tier BETWEEN 0 AND 3
  ),
  replacement_edge_margin REAL CHECK (
    replacement_edge_margin IS NULL OR replacement_edge_margin BETWEEN 0 AND 1
  ),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, read_id),
  CHECK (
    (status = 'processing' AND claim_token IS NOT NULL
      AND processing_deadline_at IS NOT NULL AND hard_deadline_at IS NOT NULL)
    OR (status <> 'processing' AND claim_token IS NULL
      AND processing_deadline_at IS NULL AND hard_deadline_at IS NULL)
  ),
  CHECK (
    (status IN ('source_changed','unavailable','failed','preserved') AND error_code IS NOT NULL)
    OR status NOT IN ('source_changed','unavailable','failed','preserved')
  ),
  CHECK (
    (status = 'repaired' AND replacement_image_path IS NOT NULL
      AND replacement_detection_box IS NOT NULL
      AND replacement_completeness_tier IS NOT NULL
      AND replacement_edge_margin IS NOT NULL AND completed_at IS NOT NULL)
    OR status <> 'repaired'
  )
);

CREATE INDEX IF NOT EXISTS idx_overview_framing_repair_jobs_claim
  ON public.vehicle_overview_framing_repair_jobs (
    status, next_attempt_at, id
  ) WHERE status IN ('queued','processing','failed');
CREATE INDEX IF NOT EXISTS idx_overview_framing_repair_jobs_run
  ON public.vehicle_overview_framing_repair_jobs (run_id, status, id);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081502_vehicle_overview_framing_repair','Add inert preview-first bounded repair jobs for operator-selected edge-clipped or overly tight direct Overview images while preserving the current image unless a replacement proves more complete.')
ON CONFLICT(version) DO NOTHING;

-- A framing repair is a distinct semantic export for the same read and source
-- window. Its per-job identity prevents collisions with the original live
-- export while keeping retries and worker restarts idempotent.
ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_profile_kind_check;
ALTER TABLE public.blue_iris_timeline_exports
  ADD CONSTRAINT blue_iris_timeline_exports_profile_kind_check CHECK (
    profile_kind IS NULL OR profile_kind IN ('pair','entry_history','framing_repair')
  ) NOT VALID;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081503_overview_framing_repair_export_identity','Give each guarded Overview framing repair a stable distinct timeline-export identity while permitting its claim-owned ready Vehicle View to use the export ledger.')
ON CONFLICT(version) DO NOTHING;

-- The saved-pixel framing audit and operator repair campaign were withdrawn
-- after production canaries. Preserve the additive tables as immutable audit
-- history, restore any read still owned by an interrupted repair claim to its
-- frozen prior ready state, and terminalize all work that could otherwise be
-- claimed by an older application image during a rolling rollback.
DO $$
BEGIN
  IF to_regclass('public.vehicle_overview_framing_repair_jobs') IS NOT NULL
     AND to_regclass('public.vehicle_overview_framing_repair_runs') IS NOT NULL THEN
    WITH prior AS MATERIALIZED (
      SELECT DISTINCT ON (reads.id)
        reads.id AS read_id,
        jobs.prior_queue_kind,
        jobs.prior_attempt_count,
        jobs.prior_retryable,
        jobs.prior_error_code,
        jobs.prior_image_updated_at_text
      FROM public.plate_reads reads
      JOIN public.vehicle_overview_framing_repair_jobs jobs
        ON jobs.read_id = reads.id
      WHERE reads.vehicle_image_queue_kind = 'overview_repair'
      ORDER BY reads.id,
        (jobs.claim_token IS NOT DISTINCT FROM reads.vehicle_image_claim_token) DESC,
        jobs.updated_at DESC,
        jobs.id DESC
    )
    UPDATE public.plate_reads reads
    SET vehicle_image_status = 'ready',
        vehicle_image_queue_kind = prior.prior_queue_kind,
        vehicle_image_attempt_count = prior.prior_attempt_count,
        vehicle_image_retryable = prior.prior_retryable,
        vehicle_image_error_code = prior.prior_error_code,
        vehicle_image_claim_token = NULL,
        vehicle_image_heartbeat_at = NULL,
        vehicle_image_processing_deadline_at = NULL,
        vehicle_image_hard_deadline_at = NULL,
        vehicle_image_next_attempt_at = NULL,
        vehicle_image_updated_at = prior.prior_image_updated_at_text::timestamptz
    FROM prior
    WHERE reads.id = prior.read_id;

    UPDATE public.blue_iris_timeline_exports
    SET status = 'failed',
        error_code = 'OVERVIEW_FRAMING_REPAIR_WITHDRAWN',
        error_details = jsonb_build_object(
          'reason', 'FEATURE_WITHDRAWN',
          'migration', '2026081504_withdraw_overview_framing_repair'
        ),
        updated_at = CURRENT_TIMESTAMP
    WHERE profile_kind = 'framing_repair'
      AND status IN ('starting','exporting','ready');

    UPDATE public.vehicle_overview_framing_repair_jobs
    SET status = 'cancelled',
        retryable = FALSE,
        claim_token = NULL,
        heartbeat_at = NULL,
        processing_deadline_at = NULL,
        hard_deadline_at = NULL,
        next_attempt_at = NULL,
        error_code = NULL,
        error_details = jsonb_build_object(
          'reason', 'FEATURE_WITHDRAWN',
          'migration', '2026081504_withdraw_overview_framing_repair'
        ),
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('previewed','queued','processing')
       OR (status = 'failed' AND retryable = TRUE);

    UPDATE public.vehicle_overview_framing_repair_runs
    SET status = 'cancelled',
        cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('previewed','running');
  END IF;
END $$;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081504_withdraw_overview_framing_repair','Withdraw the saved-pixel framing audit and operator repair workflow while restoring any interrupted read and retaining prior repair evidence as inert audit history.')
ON CONFLICT(version) DO NOTHING;

-- Provider-neutral embeddings for immutable canonical Overview crop bytes.
-- This migration is deliberately inert: it creates no run, job, embedding,
-- profile, cluster, attribute, ReID assignment, or external-provider request.
CREATE TABLE IF NOT EXISTS public.vehicle_asset_embeddings (
  id BIGSERIAL PRIMARY KEY,
  derivative_id BIGINT NOT NULL REFERENCES public.vehicle_image_derivatives(id)
    ON DELETE RESTRICT,
  model_name VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(model_name), '') IS NOT NULL
  ),
  algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(algorithm_version), '') IS NOT NULL
  ),
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  embedding_sha256 CHAR(64) NOT NULL CHECK (
    embedding_sha256 ~ '^[0-9a-f]{64}$'
  ),
  embedding_dimensions SMALLINT NOT NULL CHECK (
    embedding_dimensions = 512
  ),
  embedding BYTEA NOT NULL CHECK (OCTET_LENGTH(embedding) = 2048),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (derivative_id, model_name, algorithm_version)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_asset_embeddings_model
  ON public.vehicle_asset_embeddings (model_name, algorithm_version, derivative_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_asset_embeddings_content
  ON public.vehicle_asset_embeddings (embedding_sha256, id);

CREATE OR REPLACE FUNCTION public.prevent_vehicle_asset_embedding_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'vehicle_asset_embeddings content is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_asset_embeddings_immutable
  ON public.vehicle_asset_embeddings;
CREATE TRIGGER vehicle_asset_embeddings_immutable
BEFORE UPDATE ON public.vehicle_asset_embeddings
FOR EACH ROW EXECUTE FUNCTION public.prevent_vehicle_asset_embedding_update();

CREATE TABLE IF NOT EXISTS public.vehicle_asset_embedding_runs (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(16) NOT NULL DEFAULT 'previewing' CHECK (
    status IN ('previewing','ready','running','paused','completed','cancelled','failed')
  ),
  max_derivative_id BIGINT NOT NULL CHECK (max_derivative_id >= 0),
  model_name VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(model_name), '') IS NOT NULL
  ),
  algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(algorithm_version), '') IS NOT NULL
  ),
  preview_fingerprint CHAR(64) CHECK (
    preview_fingerprint IS NULL OR preview_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  batch_size INTEGER NOT NULL DEFAULT 5 CHECK (
    batch_size IN (1,5,25,250)
  ),
  actor_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  confirmed_actor_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
  confirmed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code VARCHAR(80),
  last_error_details JSONB CHECK (
    last_error_details IS NULL OR jsonb_typeof(last_error_details) = 'object'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'previewing' AND preview_fingerprint IS NULL)
    OR (status IN ('ready','running','paused','completed')
      AND preview_fingerprint IS NOT NULL)
    OR status IN ('cancelled','failed')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_asset_embedding_one_active
  ON public.vehicle_asset_embedding_runs ((TRUE))
  WHERE status IN ('previewing','ready','running','paused');

CREATE TABLE IF NOT EXISTS public.vehicle_asset_embedding_jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.vehicle_asset_embedding_runs(id)
    ON DELETE RESTRICT,
  derivative_id BIGINT NOT NULL REFERENCES public.vehicle_image_derivatives(id)
    ON DELETE RESTRICT,
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_path TEXT NOT NULL CHECK (NULLIF(BTRIM(source_path), '') IS NOT NULL),
  source_width INTEGER NOT NULL CHECK (source_width > 0),
  source_height INTEGER NOT NULL CHECK (source_height > 0),
  source_algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(source_algorithm_version), '') IS NOT NULL
  ),
  evidence_read_id INTEGER NOT NULL CHECK (evidence_read_id > 0),
  evidence_source_kind VARCHAR(40) NOT NULL,
  evidence_source_path TEXT NOT NULL CHECK (
    NULLIF(BTRIM(evidence_source_path), '') IS NOT NULL
  ),
  evidence_source_updated_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_preview' CHECK (
    status IN (
      'pending_preview','previewing','previewed','queued','processing',
      'ready','already_current','source_changed','invalid','failed','cancelled'
    )
  ),
  failure_stage VARCHAR(12) CHECK (
    failure_stage IS NULL OR failure_stage IN ('preview','embed')
  ),
  preview_embedding_sha256 CHAR(64) CHECK (
    preview_embedding_sha256 IS NULL OR preview_embedding_sha256 ~ '^[0-9a-f]{64}$'
  ),
  preview_embedding_dimensions SMALLINT CHECK (
    preview_embedding_dimensions IS NULL OR preview_embedding_dimensions = 512
  ),
  preview_embedding_bytes INTEGER CHECK (
    preview_embedding_bytes IS NULL OR preview_embedding_bytes = 2048
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (
    operator_retry_count BETWEEN 0 AND 1
  ),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token UUID,
  processing_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR jsonb_typeof(error_details) = 'object'
  ),
  embedding_id BIGINT REFERENCES public.vehicle_asset_embeddings(id)
    ON DELETE SET NULL,
  previewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, derivative_id),
  CHECK (
    (status IN ('previewed','queued','processing','ready','already_current')
      AND preview_embedding_sha256 IS NOT NULL
      AND preview_embedding_dimensions = 512
      AND preview_embedding_bytes = 2048)
    OR status NOT IN ('previewed','queued','processing','ready','already_current')
  ),
  CHECK (
    (status IN ('previewing','processing')
      AND claim_token IS NOT NULL AND processing_deadline_at IS NOT NULL)
    OR (status NOT IN ('previewing','processing')
      AND claim_token IS NULL AND processing_deadline_at IS NULL)
  ),
  CHECK (
    (status IN ('source_changed','invalid','failed') AND error_code IS NOT NULL)
    OR status NOT IN ('source_changed','invalid','failed')
  ),
  CHECK (
    (status IN ('ready','already_current')
      AND embedding_id IS NOT NULL AND completed_at IS NOT NULL)
    OR status NOT IN ('ready','already_current')
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_asset_embedding_jobs_run
  ON public.vehicle_asset_embedding_jobs (run_id, status, derivative_id, id);
CREATE INDEX IF NOT EXISTS idx_vehicle_asset_embedding_jobs_claim
  ON public.vehicle_asset_embedding_jobs (status, next_attempt_at, derivative_id, id)
  WHERE status IN ('pending_preview','previewing','queued','processing','failed');

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081505_vehicle_asset_embedding_campaign','Add inert provider-neutral canonical crop embeddings and a preview-first operator campaign without enabling any ReID v2 consumer.')
ON CONFLICT(version) DO NOTHING;

-- Provider-neutral local attribute observations for immutable canonical crop bytes.
-- This migration is deliberately inert: it creates no run or job and does not
-- alter current read-owned attributes, ReID, assignments, events, or providers.
CREATE TABLE IF NOT EXISTS public.vehicle_asset_attribute_observations (
  id BIGSERIAL PRIMARY KEY,
  derivative_id BIGINT NOT NULL REFERENCES public.vehicle_image_derivatives(id)
    ON DELETE RESTRICT,
  attribute_key VARCHAR(40) NOT NULL CHECK (
    attribute_key IN ('color','body_type')
  ),
  provider VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(provider), '') IS NOT NULL
  ),
  model_version VARCHAR(120) NOT NULL CHECK (
    NULLIF(BTRIM(model_version), '') IS NOT NULL
  ),
  algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(algorithm_version), '') IS NOT NULL
  ),
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  status VARCHAR(12) NOT NULL CHECK (status IN ('ready','unknown')),
  attribute_value VARCHAR(120),
  confidence REAL CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  result_sha256 CHAR(64) NOT NULL CHECK (
    result_sha256 ~ '^[0-9a-f]{64}$'
  ),
  raw_result JSONB NOT NULL CHECK (jsonb_typeof(raw_result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (
    derivative_id, attribute_key, provider, model_version, algorithm_version
  ),
  CHECK (
    (status = 'ready' AND NULLIF(BTRIM(attribute_value), '') IS NOT NULL
      AND confidence IS NOT NULL)
    OR (status = 'unknown' AND attribute_value IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_asset_attribute_observations_contract
  ON public.vehicle_asset_attribute_observations (
    attribute_key, provider, model_version, algorithm_version, derivative_id
  );
CREATE INDEX IF NOT EXISTS idx_vehicle_asset_attribute_observations_value
  ON public.vehicle_asset_attribute_observations (
    attribute_key, attribute_value, confidence DESC, derivative_id
  ) WHERE status = 'ready';

CREATE OR REPLACE FUNCTION public.prevent_vehicle_asset_attribute_observation_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'vehicle_asset_attribute_observations content is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_asset_attribute_observations_immutable
  ON public.vehicle_asset_attribute_observations;
CREATE TRIGGER vehicle_asset_attribute_observations_immutable
BEFORE UPDATE ON public.vehicle_asset_attribute_observations
FOR EACH ROW EXECUTE FUNCTION public.prevent_vehicle_asset_attribute_observation_update();

CREATE TABLE IF NOT EXISTS public.vehicle_asset_attribute_runs (
  id BIGSERIAL PRIMARY KEY,
  status VARCHAR(16) NOT NULL DEFAULT 'previewing' CHECK (
    status IN ('previewing','ready','running','paused','completed','cancelled','failed')
  ),
  max_derivative_id BIGINT NOT NULL CHECK (max_derivative_id >= 0),
  algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(algorithm_version), '') IS NOT NULL
  ),
  preview_fingerprint CHAR(64) CHECK (
    preview_fingerprint IS NULL OR preview_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  batch_size INTEGER NOT NULL DEFAULT 5 CHECK (
    batch_size IN (1,5,25,250)
  ),
  actor_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  confirmed_actor_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
  confirmed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code VARCHAR(80),
  last_error_details JSONB CHECK (
    last_error_details IS NULL OR jsonb_typeof(last_error_details) = 'object'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'previewing' AND preview_fingerprint IS NULL)
    OR (status IN ('ready','running','paused','completed')
      AND preview_fingerprint IS NOT NULL)
    OR status IN ('cancelled','failed')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_asset_attribute_one_active
  ON public.vehicle_asset_attribute_runs ((TRUE))
  WHERE status IN ('previewing','ready','running','paused');

CREATE TABLE IF NOT EXISTS public.vehicle_asset_attribute_jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES public.vehicle_asset_attribute_runs(id)
    ON DELETE RESTRICT,
  derivative_id BIGINT NOT NULL REFERENCES public.vehicle_image_derivatives(id)
    ON DELETE RESTRICT,
  asset_id BIGINT NOT NULL REFERENCES public.vehicle_image_assets(id)
    ON DELETE RESTRICT,
  source_sha256 CHAR(64) NOT NULL CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_path TEXT NOT NULL CHECK (NULLIF(BTRIM(source_path), '') IS NOT NULL),
  source_width INTEGER NOT NULL CHECK (source_width > 0),
  source_height INTEGER NOT NULL CHECK (source_height > 0),
  source_algorithm_version VARCHAR(100) NOT NULL CHECK (
    NULLIF(BTRIM(source_algorithm_version), '') IS NOT NULL
  ),
  evidence_read_id INTEGER NOT NULL CHECK (evidence_read_id > 0),
  evidence_source_kind VARCHAR(40) NOT NULL,
  evidence_source_path TEXT NOT NULL CHECK (
    NULLIF(BTRIM(evidence_source_path), '') IS NOT NULL
  ),
  evidence_source_updated_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_preview' CHECK (
    status IN (
      'pending_preview','previewing','previewed','queued','processing',
      'ready','already_current','source_changed','invalid','failed','cancelled'
    )
  ),
  failure_stage VARCHAR(12) CHECK (
    failure_stage IS NULL OR failure_stage IN ('preview','observe')
  ),
  preview_result_sha256 CHAR(64) CHECK (
    preview_result_sha256 IS NULL OR preview_result_sha256 ~ '^[0-9a-f]{64}$'
  ),
  preview_result JSONB CHECK (
    preview_result IS NULL OR jsonb_typeof(preview_result) = 'object'
  ),
  preview_result_bytes INTEGER CHECK (
    preview_result_bytes IS NULL OR preview_result_bytes > 0
  ),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  operator_retry_count SMALLINT NOT NULL DEFAULT 0 CHECK (
    operator_retry_count BETWEEN 0 AND 1
  ),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token UUID,
  processing_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_details JSONB CHECK (
    error_details IS NULL OR jsonb_typeof(error_details) = 'object'
  ),
  observations_created SMALLINT CHECK (
    observations_created IS NULL OR observations_created BETWEEN 0 AND 2
  ),
  previewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, derivative_id),
  CHECK (
    (status IN ('previewed','queued','processing','ready','already_current')
      AND preview_result_sha256 IS NOT NULL
      AND preview_result IS NOT NULL
      AND preview_result_bytes > 0)
    OR status NOT IN ('previewed','queued','processing','ready','already_current')
  ),
  CHECK (
    (status IN ('previewing','processing')
      AND claim_token IS NOT NULL AND processing_deadline_at IS NOT NULL)
    OR (status NOT IN ('previewing','processing')
      AND claim_token IS NULL AND processing_deadline_at IS NULL)
  ),
  CHECK (
    (status IN ('source_changed','invalid','failed') AND error_code IS NOT NULL)
    OR status NOT IN ('source_changed','invalid','failed')
  ),
  CHECK (
    (status IN ('ready','already_current')
      AND observations_created IS NOT NULL AND completed_at IS NOT NULL)
    OR status NOT IN ('ready','already_current')
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_asset_attribute_jobs_run
  ON public.vehicle_asset_attribute_jobs (run_id, status, derivative_id, id);
CREATE INDEX IF NOT EXISTS idx_vehicle_asset_attribute_jobs_claim
  ON public.vehicle_asset_attribute_jobs (status, next_attempt_at, derivative_id, id)
  WHERE status IN ('pending_preview','previewing','queued','processing','failed');

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081506_vehicle_asset_attribute_campaign','Add inert immutable crop-owned local color and body-type observations plus a preview-first operator campaign without changing current ReID or external providers.')
ON CONFLICT(version) DO NOTHING;
