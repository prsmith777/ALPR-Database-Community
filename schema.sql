--
-- PostgreSQL database dump
--

-- Dumped from database version 13.16 (Debian 13.16-1.pgdg120+1)
-- Dumped by pg_dump version 13.16 (Debian 13.16-1.pgdg120+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: fuzzystrmatch; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;


--
-- Name: EXTENSION fuzzystrmatch; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION fuzzystrmatch IS 'determine similarities and distance between strings';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_updated_at_column() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: known_plates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.known_plates (
    plate_number character varying(10) NOT NULL,
    observed_plate character varying(10),
    review_status character varying(24) DEFAULT 'unreviewed' NOT NULL,
    review_revision integer DEFAULT 0 NOT NULL,
    name character varying(255),
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ignore BOOLEAN DEFAULT FALSE
);


ALTER TABLE public.known_plates OWNER TO postgres;

--
-- Name: plate_notifications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.plate_notifications (
    id integer NOT NULL,
    plate_number text NOT NULL,
    enabled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    priority integer DEFAULT 1
);


ALTER TABLE public.plate_notifications OWNER TO postgres;

--
-- Name: plate_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.plate_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.plate_notifications_id_seq OWNER TO postgres;

--
-- Name: plate_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.plate_notifications_id_seq OWNED BY public.plate_notifications.id;


--
-- Name: plate_reads; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.plate_reads (
    id integer NOT NULL,
    plate_number character varying(10) NOT NULL,
    image_data text,
    image_path VARCHAR(255),
    thumbnail_path VARCHAR(255),
    "timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    camera_name character varying(30),
    bi_path varchar(100),
    bi_alert_clip text,
    bi_alert_path text,
    bi_alert_offset_ms bigint,
    plate_annotation varchar(255),
    crop_coordinates int[],
    ocr_annotation jsonb,
    confidence decimal,
    bi_zone varchar(30),
    validated boolean DEFAULT false,
    event_identity varchar(80)
);


ALTER TABLE public.plate_reads OWNER TO postgres;

--
-- Name: plate_reads_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.plate_reads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.plate_reads_id_seq OWNER TO postgres;

--
-- Name: plate_reads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.plate_reads_id_seq OWNED BY public.plate_reads.id;


--
-- Name: plate_tags; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.plate_tags (
    plate_number character varying(10) NOT NULL,
    tag_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.plate_tags OWNER TO postgres;

--
-- Name: plates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.plates (
    plate_number character varying(10) NOT NULL,
    first_seen_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    flagged boolean DEFAULT false NOT NULL,
    occurrence_count integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.plates OWNER TO postgres;


CREATE INDEX idx_plates_occurrence_count ON public.plates(occurrence_count);

--
-- Name: tags; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tags (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    color character varying(20) DEFAULT '#808080'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.tags OWNER TO postgres;

CREATE TABLE public.devmgmt (
    id SERIAL PRIMARY KEY,
    update1 BOOLEAN DEFAULT FALSE,
    training_last_record INTEGER DEFAULT 0
);

ALTER TABLE public.devmgmt OWNER TO postgres;

INSERT INTO public.devmgmt (id, update1)
SELECT 1, false
WHERE NOT EXISTS (SELECT 1 FROM public.devmgmt);



--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.tags_id_seq OWNER TO postgres;

--
-- Name: tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.tags_id_seq OWNED BY public.tags.id;


--
-- Name: plate_notifications id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plate_notifications ALTER COLUMN id SET DEFAULT nextval('public.plate_notifications_id_seq'::regclass);


--
-- Name: plate_reads id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plate_reads ALTER COLUMN id SET DEFAULT nextval('public.plate_reads_id_seq'::regclass);


--
-- Name: tags id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tags ALTER COLUMN id SET DEFAULT nextval('public.tags_id_seq'::regclass);


--
-- Name: known_plates known_plates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.known_plates
    ADD CONSTRAINT known_plates_pkey PRIMARY KEY (plate_number);


--
-- Name: plate_notifications plate_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plate_notifications
    ADD CONSTRAINT plate_notifications_pkey PRIMARY KEY (id);


--
-- Name: plate_notifications plate_notifications_plate_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plate_notifications
    ADD CONSTRAINT plate_notifications_plate_number_key UNIQUE (plate_number);


--
-- Name: plate_reads plate_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plate_reads
    ADD CONSTRAINT plate_reads_pkey PRIMARY KEY (id);


--
-- Name: plate_tags plate_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plate_tags
    ADD CONSTRAINT plate_tags_pkey PRIMARY KEY (plate_number, tag_id);


--
-- Name: plates plates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plates
    ADD CONSTRAINT plates_pkey PRIMARY KEY (plate_number);


--
-- Name: tags tags_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_name_key UNIQUE (name);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);

-- Local derived assets used by visual similarity search. Source plate images
-- remain unchanged and are referenced by path.
CREATE TABLE IF NOT EXISTS public.capture_assets (
    id BIGSERIAL PRIMARY KEY,
    read_id INTEGER NOT NULL REFERENCES public.plate_reads(id) ON DELETE CASCADE,
    asset_type VARCHAR(30) NOT NULL DEFAULT 'vehicle_crop'
        CHECK (asset_type IN ('vehicle_crop')),
    algorithm_version VARCHAR(40) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('ready', 'failed')),
    source_image_path VARCHAR(255) NOT NULL,
    derived_path VARCHAR(255),
    source_sha256 CHAR(64),
    perceptual_hash CHAR(16),
    crop_box JSONB,
    image_width INTEGER,
    image_height INTEGER,
    crop_width INTEGER,
    crop_height INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    error_code VARCHAR(80),
    indexed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (read_id, asset_type, algorithm_version)
);

CREATE INDEX IF NOT EXISTS idx_capture_assets_ready_hash
    ON public.capture_assets (perceptual_hash, read_id)
    WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_capture_assets_status
    ON public.capture_assets (status, updated_at DESC, id DESC);

ALTER TABLE public.capture_assets
    ADD COLUMN IF NOT EXISTS crop_profile_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.camera_visual_profiles (
    camera_key VARCHAR(100) PRIMARY KEY,
    camera_name VARCHAR(100) NOT NULL,
    crop_mode VARCHAR(20) NOT NULL DEFAULT 'auto',
    context_percent INTEGER NOT NULL DEFAULT 90,
    vertical_offset_percent INTEGER NOT NULL DEFAULT 0,
    profile_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: idx_known_plates_plate_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_known_plates_plate_number ON public.known_plates USING btree (plate_number);


--
-- Name: idx_plate_notifications_enabled; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plate_notifications_enabled ON public.plate_notifications USING btree (enabled) WHERE (enabled = true);


--
-- Name: idx_plate_notifications_plate_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plate_notifications_plate_number ON public.plate_notifications USING btree (plate_number);


--
-- Name: idx_plate_reads_plate_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plate_reads_plate_number ON public.plate_reads USING btree (plate_number);


--
-- Name: idx_plate_reads_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plate_reads_timestamp ON public.plate_reads USING btree ("timestamp");


--
-- Name: uq_plate_reads_event_identity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_plate_reads_event_identity ON public.plate_reads USING btree (event_identity) WHERE (event_identity IS NOT NULL);


--
-- Name: idx_plate_tags_plate_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plate_tags_plate_number ON public.plate_tags USING btree (plate_number);


--
-- Name: idx_plates_flagged; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plates_flagged ON public.plates USING btree (plate_number) WHERE (flagged = true);


--
-- Name: idx_plates_plate_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_plates_plate_number ON public.plates USING btree (plate_number);


--
-- Name: plate_tags plate_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.plate_tags
    ADD CONSTRAINT plate_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;

CREATE FUNCTION public.update_plate_occurrence_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;

ALTER FUNCTION public.update_plate_occurrence_count() OWNER TO postgres;

CREATE TRIGGER plate_reads_count_trigger AFTER INSERT OR UPDATE OR DELETE ON public.plate_reads FOR EACH ROW EXECUTE FUNCTION public.update_plate_occurrence_count();

-- Phase 1 storage monitoring tables. User foreign keys are attached by
-- migrations.sql after the identity foundation has been created.
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
    updated_by_user_id BIGINT,
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
    CONSTRAINT storage_maintenance_email_recipients_array CHECK (jsonb_typeof(email_recipients) = 'array'),
    CONSTRAINT storage_maintenance_automatic_categories_empty CHECK (automatic_categories = '[]'::JSONB)
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
    status VARCHAR(20) NOT NULL CHECK (status IN ('previewed', 'queued', 'running', 'completed', 'failed', 'cancelled')),
    actor_user_id BIGINT,
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
        status IN ('candidate', 'deleted', 'skipped-missing', 'skipped-changed', 'skipped-referenced', 'skipped-unsafe', 'failed')
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
    CONSTRAINT maintenance_cleanup_token_lifecycle CHECK (consumed_at IS NULL OR consumed_at >= created_at)
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
        COALESCE(filesystem_total_bytes, 0) >= 0 AND COALESCE(filesystem_used_bytes, 0) >= 0 AND
        COALESCE(filesystem_available_bytes, 0) >= 0 AND COALESCE(source_image_bytes, 0) >= 0 AND
        COALESCE(source_image_count, 0) >= 0 AND COALESCE(thumbnail_bytes, 0) >= 0 AND
        COALESCE(thumbnail_count, 0) >= 0 AND COALESCE(derived_vehicle_image_bytes, 0) >= 0 AND
        COALESCE(derived_vehicle_image_count, 0) >= 0 AND COALESCE(database_bytes, 0) >= 0 AND
        COALESCE(docker_bytes, 0) >= 0 AND COALESCE(backup_bytes, 0) >= 0
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
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'retry', 'succeeded', 'dead')),
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
