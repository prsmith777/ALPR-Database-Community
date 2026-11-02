-- migration: 2026080501_read_only_backup_catalog
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
