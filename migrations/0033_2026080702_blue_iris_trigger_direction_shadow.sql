-- migration: 2026080702_blue_iris_trigger_direction_shadow
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
