-- migration: 2026081504_withdraw_overview_framing_repair
-- The saved-pixel framing audit and operator repair campaign were withdrawn
-- after production canaries. Preserve the additive tables as immutable audit
-- history, restore any read still owned by an interrupted repair claim to its
-- frozen prior ready state, and terminalize all work that could otherwise be
-- claimed by an older application image during a rolling rollback.
DO $$
BEGIN
  IF to_regclass('public.vehicle_overview_framing_repair_jobs') IS NOT NULL
     AND to_regclass('public.vehicle_overview_framing_repair_runs') IS NOT NULL THEN
    WITH prior AS MATERIALIZED (
      SELECT DISTINCT ON (reads.id)
        reads.id AS read_id,
        jobs.prior_queue_kind,
        jobs.prior_attempt_count,
        jobs.prior_retryable,
        jobs.prior_error_code,
        jobs.prior_image_updated_at_text
      FROM public.plate_reads reads
      JOIN public.vehicle_overview_framing_repair_jobs jobs
        ON jobs.read_id = reads.id
      WHERE reads.vehicle_image_queue_kind = 'overview_repair'
      ORDER BY reads.id,
        (jobs.claim_token IS NOT DISTINCT FROM reads.vehicle_image_claim_token) DESC,
        jobs.updated_at DESC,
        jobs.id DESC
    )
    UPDATE public.plate_reads reads
    SET vehicle_image_status = 'ready',
        vehicle_image_queue_kind = prior.prior_queue_kind,
        vehicle_image_attempt_count = prior.prior_attempt_count,
        vehicle_image_retryable = prior.prior_retryable,
        vehicle_image_error_code = prior.prior_error_code,
        vehicle_image_claim_token = NULL,
        vehicle_image_heartbeat_at = NULL,
        vehicle_image_processing_deadline_at = NULL,
        vehicle_image_hard_deadline_at = NULL,
        vehicle_image_next_attempt_at = NULL,
        vehicle_image_updated_at = prior.prior_image_updated_at_text::timestamptz
    FROM prior
    WHERE reads.id = prior.read_id;

    UPDATE public.blue_iris_timeline_exports
    SET status = 'failed',
        error_code = 'OVERVIEW_FRAMING_REPAIR_WITHDRAWN',
        error_details = jsonb_build_object(
          'reason', 'FEATURE_WITHDRAWN',
          'migration', '2026081504_withdraw_overview_framing_repair'
        ),
        updated_at = CURRENT_TIMESTAMP
    WHERE profile_kind = 'framing_repair'
      AND status IN ('starting','exporting','ready');

    UPDATE public.vehicle_overview_framing_repair_jobs
    SET status = 'cancelled',
        retryable = FALSE,
        claim_token = NULL,
        heartbeat_at = NULL,
        processing_deadline_at = NULL,
        hard_deadline_at = NULL,
        next_attempt_at = NULL,
        error_code = NULL,
        error_details = jsonb_build_object(
          'reason', 'FEATURE_WITHDRAWN',
          'migration', '2026081504_withdraw_overview_framing_repair'
        ),
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('previewed','queued','processing')
       OR (status = 'failed' AND retryable = TRUE);

    UPDATE public.vehicle_overview_framing_repair_runs
    SET status = 'cancelled',
        cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('previewed','running');
  END IF;
END $$;

INSERT INTO public.schema_migrations(version,description) VALUES
 ('2026081504_withdraw_overview_framing_repair','Withdraw the saved-pixel framing audit and operator repair workflow while restoring any interrupted read and retaining prior repair evidence as inert audit history.')
ON CONFLICT(version) DO NOTHING;
