-- migration: 2026080703_blue_iris_trigger_direction_hardening
INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080703_blue_iris_trigger_direction_hardening','Separate Blue Iris mapping revisions from ReID, enforce exact reverse crossings, and scope diagnostics by camera.')
ON CONFLICT(version) DO NOTHING;
