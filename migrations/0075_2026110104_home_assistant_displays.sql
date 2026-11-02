-- migration: 2026110104_home_assistant_displays
CREATE TABLE public.home_assistant_display_grants (
  id UUID PRIMARY KEY,
  label VARCHAR(80) NOT NULL CHECK (BTRIM(label) <> ''),
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  allowed_origin TEXT NOT NULL,
  camera_name VARCHAR(100),
  created_by VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
INSERT INTO public.schema_migrations(version, description) VALUES
 ('2026110104_home_assistant_displays', 'Revocable, camera-scoped read-only display credentials for Home Assistant.')
ON CONFLICT(version) DO NOTHING;
