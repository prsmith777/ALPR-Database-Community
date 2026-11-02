-- migration: 2026080902_blue_iris_timeline_exports
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
