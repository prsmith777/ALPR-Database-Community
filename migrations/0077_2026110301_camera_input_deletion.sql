-- migration: 2026110301_camera_input_deletion
-- Keep source identity and passage/image references after removing an input.
ALTER TABLE public.camera_inputs ADD COLUMN deleted_at TIMESTAMPTZ;
DROP INDEX public.uq_camera_inputs_name;
CREATE UNIQUE INDEX uq_camera_inputs_name ON public.camera_inputs(LOWER(BTRIM(camera_name))) WHERE deleted_at IS NULL;
DROP INDEX public.uq_camera_inputs_device;
CREATE UNIQUE INDEX uq_camera_inputs_device ON public.camera_inputs(device_id) WHERE source='axis' AND deleted_at IS NULL;
INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026110301_camera_input_deletion','Remove camera inputs while preserving imported reads, images and archived source identity.');
