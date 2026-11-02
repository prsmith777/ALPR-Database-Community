-- migration: 2026073001_manual_database_backup
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
