-- migration: 2026081101_entry_overview_history_retry
INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081101_entry_overview_history_retry','Allow one audited, operator-authorized retry cycle for terminal transient Gate Overview history import failures while preserving existing views and export identity.')
ON CONFLICT(version) DO NOTHING;
