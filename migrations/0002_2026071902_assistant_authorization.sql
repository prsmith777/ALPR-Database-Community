-- migration: 2026071902_assistant_authorization
INSERT INTO public.schema_migrations (version, description)
VALUES (
    '2026071902_assistant_authorization',
    'Restrict AI Assistant access to explicitly authorized administrators.'
)
ON CONFLICT (version) DO NOTHING;
