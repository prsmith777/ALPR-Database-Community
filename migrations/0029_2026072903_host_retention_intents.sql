-- migration: 2026072903_host_retention_intents
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
