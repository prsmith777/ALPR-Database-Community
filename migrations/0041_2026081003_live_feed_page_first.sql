-- migration: 2026081003_live_feed_page_first
-- Live Feed must page the inexpensive read identity set before joining tags,
-- vehicle evidence, and other presentation data. This composite order index
-- supports its default newest-first page without sorting the full read history.
CREATE INDEX IF NOT EXISTS idx_plate_reads_live_feed_timestamp
  ON public.plate_reads ("timestamp" DESC, id DESC);

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081003_live_feed_page_first','Page Live Feed read identities before presentation joins and support newest-first lookup with a composite index.')
ON CONFLICT(version) DO NOTHING;
