-- migration: 2026082202_blue_iris_camera_inventory
-- Cache the sanitized Blue Iris camera inventory so playback links can use the
-- stable short camera identifier even when reads and overview profiles retain
-- the operator-facing display name. The vehicle-frame worker refreshes this
-- metadata only after a successful read-only camlist request.
CREATE TABLE IF NOT EXISTS public.blue_iris_camera_inventory (
  short_name VARCHAR(80) PRIMARY KEY CHECK (BTRIM(short_name) <> ''),
  display_name VARCHAR(255) NOT NULL CHECK (BTRIM(display_name) <> ''),
  online BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  present BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blue_iris_camera_inventory_display_name
  ON public.blue_iris_camera_inventory (LOWER(BTRIM(display_name)))
  WHERE present = TRUE;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026082202_blue_iris_camera_inventory','Cache sanitized Blue Iris display-to-short camera mappings for reliable plate-capture and Vehicle View playback links.')
ON CONFLICT(version) DO NOTHING;
