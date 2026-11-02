-- migration: 2026081402_vehicle_image_asset_foundation
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
      'filesystem', 'plate-reads',
      'vehicle-image-assets', 'vehicle-image-derivatives', 'completed'
    )
  );

ALTER TABLE public.storage_reconciliation_runs
  DROP CONSTRAINT IF EXISTS storage_reconciliation_counts;
ALTER TABLE public.storage_reconciliation_runs
  ADD CONSTRAINT storage_reconciliation_counts CHECK (
    max_plate_read_id >= 0
    AND max_vehicle_image_asset_id >= 0
    AND plate_read_cursor >= 0
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
