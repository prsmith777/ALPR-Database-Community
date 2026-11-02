-- migration: 2026072101_repair_plate_occurrence_counts
-- Reconcile stored plate occurrence counts after bulk imports.
DO $$
DECLARE
    mismatch_count BIGINT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.schema_migrations
        WHERE version = '2026072101_repair_plate_occurrence_counts'
    ) THEN
        WITH actual_counts AS (
            SELECT plate_number, COUNT(*)::INTEGER AS read_count
            FROM public.plate_reads
            GROUP BY plate_number
        )
        UPDATE public.plates AS plate
        SET occurrence_count = actual.read_count
        FROM actual_counts AS actual
        WHERE actual.plate_number = plate.plate_number
          AND plate.occurrence_count IS DISTINCT FROM actual.read_count;

        UPDATE public.plates AS plate
        SET occurrence_count = 0
        WHERE plate.occurrence_count <> 0
          AND NOT EXISTS (
              SELECT 1
              FROM public.plate_reads AS read
              WHERE read.plate_number = plate.plate_number
          );

        SELECT COUNT(*)
        INTO mismatch_count
        FROM (
            SELECT
                COALESCE(plate.plate_number, actual.plate_number) AS plate_number,
                plate.occurrence_count,
                COALESCE(actual.read_count, 0) AS read_count
            FROM public.plates AS plate
            FULL OUTER JOIN (
                SELECT plate_number, COUNT(*)::INTEGER AS read_count
                FROM public.plate_reads
                GROUP BY plate_number
            ) AS actual
                ON actual.plate_number = plate.plate_number
            WHERE plate.plate_number IS NULL
               OR plate.occurrence_count IS DISTINCT FROM COALESCE(actual.read_count, 0)
        ) AS mismatches;

        IF mismatch_count <> 0 THEN
            RAISE EXCEPTION
                'Plate occurrence reconciliation left % mismatched plate rows',
                mismatch_count;
        END IF;

        INSERT INTO public.schema_migrations (version, description)
        VALUES (
            '2026072101_repair_plate_occurrence_counts',
            'Reconcile stored plate occurrence counts with imported plate reads.'
        );
    END IF;
END $$;
