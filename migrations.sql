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

DO $
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'mqtt_rules_plate_match_mode_check'
          AND conrelid = 'public.mqtt_rules'::regclass
    ) THEN
        ALTER TABLE public.mqtt_rules
            ADD CONSTRAINT mqtt_rules_plate_match_mode_check
            CHECK (plate_match_mode IN ('off', 'strict', 'balanced', 'broad'));
    END IF;
END $;

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
