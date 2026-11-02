-- migration: 2026081503_overview_framing_repair_export_identity
-- A framing repair is a distinct semantic export for the same read and source
-- window. Its per-job identity prevents collisions with the original live
-- export while keeping retries and worker restarts idempotent.
ALTER TABLE public.blue_iris_timeline_exports
  DROP CONSTRAINT IF EXISTS blue_iris_timeline_exports_profile_kind_check;
ALTER TABLE public.blue_iris_timeline_exports
  ADD CONSTRAINT blue_iris_timeline_exports_profile_kind_check CHECK (
    profile_kind IS NULL OR profile_kind IN ('pair','entry_history','framing_repair')
  ) NOT VALID;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081503_overview_framing_repair_export_identity','Give each guarded Overview framing repair a stable distinct timeline-export identity while permitting its claim-owned ready Vehicle View to use the export ledger.')
ON CONFLICT(version) DO NOTHING;
