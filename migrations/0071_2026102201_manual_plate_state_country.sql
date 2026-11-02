-- migration: 2026102201_manual_plate_state_country
-- Manually entered metadata shared by reads of the same effective plate.
ALTER TABLE public.plates ADD COLUMN IF NOT EXISTS state_country VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_plates_state_country_options
  ON public.plates (LOWER(state_country), state_country)
  WHERE NULLIF(BTRIM(state_country), '') IS NOT NULL;
INSERT INTO public.schema_migrations(version, description) VALUES
 ('2026102201_manual_plate_state_country', 'Add optional manually entered State/Country plate metadata.')
ON CONFLICT(version) DO NOTHING;
