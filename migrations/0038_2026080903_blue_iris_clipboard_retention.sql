-- migration: 2026080903_blue_iris_clipboard_retention
-- Retire the earlier remote-delete workflow without removing its additive
-- compatibility columns. Completed downloads become terminal ledger entries;
-- Blue Iris removes Clipboard exports according to its configured retention.
UPDATE public.blue_iris_timeline_exports
SET status = CASE WHEN downloaded_at IS NOT NULL THEN 'downloaded' ELSE 'failed' END,
    error_code = CASE
      WHEN downloaded_at IS NOT NULL AND error_code = 'EXPORT_DELETE_FAILED' THEN NULL
      ELSE error_code
    END,
    error_details = CASE
      WHEN downloaded_at IS NOT NULL AND error_code = 'EXPORT_DELETE_FAILED' THEN NULL
      ELSE error_details
    END,
    next_delete_attempt_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE status IN ('delete_pending', 'deleting');

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026080903_blue_iris_clipboard_retention','Stop ALPR remote-delete attempts, leave Blue Iris Clipboard retention authoritative, and normalize earlier delete-pending export rows.')
ON CONFLICT(version) DO NOTHING;
