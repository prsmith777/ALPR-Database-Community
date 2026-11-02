-- migration: 2026080301_configurable_image_retirement_grace
-- Image retirement remains manual-only, but its post-retirement recovery
-- window is administrator-configurable from one to 365 days. Seven days stays
-- the default. The fixed worker revalidates the same persisted value.
ALTER TABLE public.host_maintenance_config
 DROP CONSTRAINT IF EXISTS host_maintenance_config_minimum_age_days_check;
ALTER TABLE public.host_maintenance_config
 ADD CONSTRAINT host_maintenance_config_minimum_age_days_check
 CHECK (minimum_age_days BETWEEN 1 AND 365);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080301_configurable_image_retirement_grace','Allow an audited 1-365 day manual image-retirement grace while retaining a seven-day default.')
ON CONFLICT(version) DO NOTHING;
