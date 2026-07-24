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
