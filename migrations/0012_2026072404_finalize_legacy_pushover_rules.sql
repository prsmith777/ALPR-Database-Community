-- migration: 2026072404_finalize_legacy_pushover_rules
-- The same verified-delivery boundary now retires legacy exact-plate Pushover
-- rows. No credentials are copied into the immutable source snapshot.
INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026072404_finalize_legacy_pushover_rules',
    'Extend verified legacy finalization and immutable snapshots to migrated Pushover rules.'
)
ON CONFLICT (version) DO NOTHING;
