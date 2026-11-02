-- migration: 2026082203_recognition_filter_indexes
-- Recognition Feed filters should use bounded index lookups instead of
-- rescanning the read history whenever an operator changes a control.
CREATE INDEX IF NOT EXISTS idx_plate_reads_filter_camera
  ON public.plate_reads (LOWER(camera_name), "timestamp" DESC, id DESC)
  WHERE camera_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plate_reads_filter_review_status
  ON public.plate_reads (review_status, "timestamp" DESC, id DESC)
  WHERE review_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plate_tags_filter_tag
  ON public.plate_tags (tag_id, plate_number);
CREATE INDEX IF NOT EXISTS idx_vehicle_direction_filter_label
  ON public.vehicle_direction_observations (LOWER(direction_label), read_id)
  WHERE direction_label IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vehicle_direction_filter_status
  ON public.vehicle_direction_observations (status, read_id);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026082203_recognition_filter_indexes','Add query-path indexes for Recognition Feed camera, tag, review-status, and direction filters.')
ON CONFLICT(version) DO NOTHING;
