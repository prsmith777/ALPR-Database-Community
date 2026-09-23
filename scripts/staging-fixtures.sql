\set ON_ERROR_STOP on

-- Synthetic staging data for interactive UX verification.
--
-- This file is intentionally not part of schema.sql, migrations.sql, image
-- startup, or application startup. It must be invoked explicitly by the
-- root-owned, staging-only Codex command wrapper. The wrapper supplies all
-- four required variables below and independently verifies the host, Compose
-- project, database container, and a root-owned staging sentinel.

\if :{?fixture_database}
\else
  \echo 'fixture_database is required'
  \quit 2
\endif
\if :{?fixture_load}
\else
  \echo 'fixture_load is required'
  \quit 2
\endif
\if :{?fixture_status}
\else
  \echo 'fixture_status is required'
  \quit 2
\endif
\if :{?fixture_clear}
\else
  \echo 'fixture_clear is required'
  \quit 2
\endif

SELECT (
  (:'fixture_load')::boolean::integer
  + (:'fixture_status')::boolean::integer
  + (:'fixture_clear')::boolean::integer
) = 1 AS fixture_one_operation \gset
\if :fixture_one_operation
\else
  \echo 'exactly one fixture operation must be selected'
  \quit 2
\endif

SELECT current_database() = :'fixture_database' AS fixture_database_ok \gset
\if :fixture_database_ok
\else
  \echo 'refusing to operate on an unexpected database'
  \quit 2
\endif

SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

\if :fixture_status
  BEGIN READ ONLY;
  SELECT (
    to_regclass('public.codex_staging_fixture_sets') IS NOT NULL
    AND to_regclass('public.codex_staging_fixture_manifest') IS NOT NULL
  ) AS fixture_registry_exists \gset

  \if :fixture_registry_exists
    SELECT EXISTS (
      SELECT 1
      FROM public.codex_staging_fixture_sets
      WHERE fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26'::uuid
    ) AS fixture_set_exists \gset
    \if :fixture_set_exists
      SELECT
        fixture_set_id,
        dataset_name,
        schema_version,
        state,
        loaded_at,
        updated_at,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = s.fixture_set_id AND m.entity_type = 'plate') AS fixture_plates,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = s.fixture_set_id AND m.entity_type = 'plate_read') AS fixture_reads,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = s.fixture_set_id AND m.entity_type = 'known_plate') AS fixture_known_plates,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = s.fixture_set_id AND m.entity_type = 'tag') AS fixture_tags,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = s.fixture_set_id AND m.entity_type = 'plate_tag') AS fixture_plate_tags,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = s.fixture_set_id AND m.entity_type = 'notification') AS fixture_notifications,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.plates p ON m.entity_type = 'plate' AND m.entity_key = p.plate_number
          WHERE m.fixture_set_id = s.fixture_set_id) AS actual_plates,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.plate_reads r ON m.entity_type = 'plate_read' AND m.entity_key = r.id::text
          WHERE m.fixture_set_id = s.fixture_set_id) AS actual_reads,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.known_plates k ON m.entity_type = 'known_plate' AND m.entity_key = k.plate_number
          WHERE m.fixture_set_id = s.fixture_set_id) AS actual_known_plates,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.tags t ON m.entity_type = 'tag' AND m.entity_key = t.id::text
          WHERE m.fixture_set_id = s.fixture_set_id) AS actual_tags,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.plate_tags pt ON m.entity_type = 'plate_tag'
            AND m.entity_key = pt.plate_number || '|' || pt.tag_id::text
          WHERE m.fixture_set_id = s.fixture_set_id) AS actual_plate_tags,
        (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.plate_notifications n ON m.entity_type = 'notification' AND m.entity_key = n.id::text
          WHERE m.fixture_set_id = s.fixture_set_id) AS actual_notifications
      FROM public.codex_staging_fixture_sets s
      WHERE fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26'::uuid;
    \else
      \echo 'fixture_state=clear fixture_sets=0 fixture_records=0'
    \endif
  \else
    \echo 'fixture_state=absent fixture_sets=0 fixture_records=0'
  \endif
  COMMIT;
\endif

\if :fixture_load
  BEGIN;
  SELECT pg_advisory_xact_lock(hashtextextended('codex-alpr-staging-fixtures:v1', 0));

  CREATE TABLE IF NOT EXISTS public.codex_staging_fixture_sets (
    fixture_set_id uuid PRIMARY KEY,
    dataset_name text NOT NULL,
    schema_version integer NOT NULL,
    state text NOT NULL CHECK (state IN ('active', 'deleting')),
    loaded_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS public.codex_staging_fixture_manifest (
    fixture_set_id uuid NOT NULL
      REFERENCES public.codex_staging_fixture_sets(fixture_set_id) ON DELETE CASCADE,
    entity_type text NOT NULL CHECK (entity_type IN (
      'plate', 'plate_read', 'known_plate', 'tag', 'plate_tag', 'notification'
    )),
    entity_key text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (fixture_set_id, entity_type, entity_key)
  );

  SELECT EXISTS (
    SELECT 1
    FROM public.codex_staging_fixture_sets
    WHERE fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26'::uuid
      AND state = 'active'
  ) AS fixture_already_loaded \gset

  \if :fixture_already_loaded
    DO $fixture$
    DECLARE
      fixture_id constant uuid := '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26';
    BEGIN
      IF (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'plate') <> 10
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'plate_read') <> 31
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'known_plate') <> 7
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'tag') <> 4
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'plate_tag') <> 10
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'notification') <> 3 THEN
        RAISE EXCEPTION 'The existing fixture registry is incomplete; clear it before loading again.';
      END IF;

      IF (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.plates p ON m.entity_type = 'plate' AND m.entity_key = p.plate_number
          WHERE m.fixture_set_id = fixture_id) <> 10
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.plate_reads r ON m.entity_type = 'plate_read' AND m.entity_key = r.id::text
          WHERE m.fixture_set_id = fixture_id) <> 31
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.known_plates k ON m.entity_type = 'known_plate' AND m.entity_key = k.plate_number
          WHERE m.fixture_set_id = fixture_id) <> 7
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.tags t ON m.entity_type = 'tag' AND m.entity_key = t.id::text
          WHERE m.fixture_set_id = fixture_id) <> 4
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.plate_tags pt ON m.entity_type = 'plate_tag'
            AND m.entity_key = pt.plate_number || '|' || pt.tag_id::text
          WHERE m.fixture_set_id = fixture_id) <> 10
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest m
          JOIN public.plate_notifications n ON m.entity_type = 'notification' AND m.entity_key = n.id::text
          WHERE m.fixture_set_id = fixture_id) <> 3 THEN
        RAISE EXCEPTION 'The existing fixture data is incomplete; clear it before loading again.';
      END IF;
    END
    $fixture$;
  \else
    DO $fixture$
    DECLARE
      fixture_id constant uuid := '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26';
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.plate_reads r
        WHERE NOT EXISTS (
          SELECT 1 FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = fixture_id
            AND m.entity_type = 'plate_read'
            AND m.entity_key = r.id::text
        )
      ) OR EXISTS (
        SELECT 1 FROM public.plates p
        WHERE NOT EXISTS (
          SELECT 1 FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = fixture_id
            AND m.entity_type = 'plate'
            AND m.entity_key = p.plate_number
        )
      ) OR EXISTS (
        SELECT 1 FROM public.known_plates k
        WHERE NOT EXISTS (
          SELECT 1 FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = fixture_id
            AND m.entity_type = 'known_plate'
            AND m.entity_key = k.plate_number
        )
      ) OR EXISTS (
        SELECT 1 FROM public.tags t
        WHERE NOT EXISTS (
          SELECT 1 FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = fixture_id
            AND m.entity_type = 'tag'
            AND m.entity_key = t.id::text
        )
      ) OR EXISTS (
        SELECT 1 FROM public.plate_tags pt
        WHERE NOT EXISTS (
          SELECT 1 FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = fixture_id
            AND m.entity_type = 'plate_tag'
            AND m.entity_key = pt.plate_number || '|' || pt.tag_id::text
        )
      ) OR EXISTS (
        SELECT 1 FROM public.plate_notifications n
        WHERE NOT EXISTS (
          SELECT 1 FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = fixture_id
            AND m.entity_type = 'notification'
            AND m.entity_key = n.id::text
        )
      ) THEN
        RAISE EXCEPTION 'Refusing to mix synthetic fixtures with unowned staging data.';
      END IF;
    END
    $fixture$;

    INSERT INTO public.codex_staging_fixture_sets (
      fixture_set_id, dataset_name, schema_version, state
    ) VALUES (
      '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26',
      'SYNTHETIC UX FIXTURES',
      1,
      'active'
    );

    WITH inserted AS (
      INSERT INTO public.tags (name, color, created_at)
      VALUES
        ('SYNTHETIC: Resident', '#2563EB', CURRENT_TIMESTAMP),
        ('SYNTHETIC: Visitor', '#7C3AED', CURRENT_TIMESTAMP),
        ('SYNTHETIC: Delivery', '#D97706', CURRENT_TIMESTAMP),
        ('SYNTHETIC: Review', '#DC2626', CURRENT_TIMESTAMP)
      RETURNING id
    )
    INSERT INTO public.codex_staging_fixture_manifest (fixture_set_id, entity_type, entity_key)
    SELECT '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26', 'tag', id::text
    FROM inserted;

    WITH inserted AS (
      INSERT INTO public.plates (plate_number, first_seen_at, created_at, flagged, occurrence_count)
      VALUES
        ('TST000002', CURRENT_TIMESTAMP - INTERVAL '45 days', CURRENT_TIMESTAMP, false, 0),
        ('TST000010', CURRENT_TIMESTAMP - INTERVAL '20 days', CURRENT_TIMESTAMP, false, 0),
        ('TST000101', CURRENT_TIMESTAMP - INTERVAL '30 days', CURRENT_TIMESTAMP, true, 0),
        ('TST000102', CURRENT_TIMESTAMP - INTERVAL '12 days', CURRENT_TIMESTAMP, false, 0),
        ('TST000103', CURRENT_TIMESTAMP - INTERVAL '9 days', CURRENT_TIMESTAMP, false, 0),
        ('TST000104', CURRENT_TIMESTAMP - INTERVAL '4 days', CURRENT_TIMESTAMP, false, 0),
        ('TSTABC123', CURRENT_TIMESTAMP - INTERVAL '18 days', CURRENT_TIMESTAMP, false, 0),
        ('TSTABC128', CURRENT_TIMESTAMP - INTERVAL '7 days', CURRENT_TIMESTAMP, false, 0),
        ('TSTNOREAD', CURRENT_TIMESTAMP - INTERVAL '2 days', CURRENT_TIMESTAMP, true, 0),
        ('TSTLOW001', CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP, false, 0)
      RETURNING plate_number
    )
    INSERT INTO public.codex_staging_fixture_manifest (fixture_set_id, entity_type, entity_key)
    SELECT '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26', 'plate', plate_number
    FROM inserted;

    WITH inserted AS (
      INSERT INTO public.known_plates (plate_number, name, notes, created_at, ignore)
      VALUES
        ('TST000002', 'Zulu Fixture', '[SYNTHETIC TEST DATA] Resident vehicle', CURRENT_TIMESTAMP - INTERVAL '7 days', false),
        ('TST000010', 'Alpha Fixture', NULL, CURRENT_TIMESTAMP - INTERVAL '1 day', true),
        ('TST000101', NULL, '[SYNTHETIC TEST DATA] Review requested', CURRENT_TIMESTAMP - INTERVAL '5 days', false),
        ('TST000102', 'Delivery Fixture', '[SYNTHETIC TEST DATA] Expected delivery', CURRENT_TIMESTAMP - INTERVAL '3 days', false),
        ('TST000103', 'Ignored Fixture', '[SYNTHETIC TEST DATA] Ignore-rule coverage', CURRENT_TIMESTAMP - INTERVAL '2 days', true),
        ('TSTABC123', 'Fuzzy Match One', '[SYNTHETIC TEST DATA] Similar plate pair', CURRENT_TIMESTAMP - INTERVAL '4 days', false),
        ('TSTABC128', 'Fuzzy Match Two', '[SYNTHETIC TEST DATA] Similar plate pair', CURRENT_TIMESTAMP - INTERVAL '6 hours', false)
      RETURNING plate_number
    )
    INSERT INTO public.codex_staging_fixture_manifest (fixture_set_id, entity_type, entity_key)
    SELECT '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26', 'known_plate', plate_number
    FROM inserted;

    WITH assignments(plate_number, tag_name) AS (
      VALUES
        ('TST000002', 'SYNTHETIC: Resident'),
        ('TST000002', 'SYNTHETIC: Review'),
        ('TST000010', 'SYNTHETIC: Visitor'),
        ('TST000101', 'SYNTHETIC: Review'),
        ('TST000102', 'SYNTHETIC: Delivery'),
        ('TST000103', 'SYNTHETIC: Resident'),
        ('TSTABC123', 'SYNTHETIC: Visitor'),
        ('TSTABC123', 'SYNTHETIC: Review'),
        ('TSTABC128', 'SYNTHETIC: Visitor'),
        ('TSTNOREAD', 'SYNTHETIC: Review')
    ), inserted AS (
      INSERT INTO public.plate_tags (plate_number, tag_id, created_at)
      SELECT a.plate_number, t.id, CURRENT_TIMESTAMP
      FROM assignments a
      JOIN public.tags t ON t.name = a.tag_name
      RETURNING plate_number, tag_id
    )
    INSERT INTO public.codex_staging_fixture_manifest (fixture_set_id, entity_type, entity_key)
    SELECT
      '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26',
      'plate_tag',
      plate_number || '|' || tag_id::text
    FROM inserted;

    WITH inserted AS (
      INSERT INTO public.plate_notifications (
        plate_number, enabled, created_at, updated_at, priority
      ) VALUES
        ('TST000101', true, CURRENT_TIMESTAMP - INTERVAL '3 days', CURRENT_TIMESTAMP, 3),
        ('TSTABC128', true, CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP, 2),
        ('TSTNOREAD', false, CURRENT_TIMESTAMP - INTERVAL '2 hours', CURRENT_TIMESTAMP, 3)
      RETURNING id
    )
    INSERT INTO public.codex_staging_fixture_manifest (fixture_set_id, entity_type, entity_key)
    SELECT '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26', 'notification', id::text
    FROM inserted;

    WITH patterns(
      plate_number, read_count, day_offset, start_hour, confidence_start, validated_every
    ) AS (
      VALUES
        ('TST000002', 8, 14, 5, 0.68::numeric, 2),
        ('TST000010', 5, 8, 8, 0.74::numeric, 3),
        ('TST000101', 4, 6, 22, 0.41::numeric, 2),
        ('TST000102', 3, 4, 12, 0.88::numeric, 2),
        ('TST000103', 2, 3, 1, 0.57::numeric, 2),
        ('TST000104', 1, 2, 16, 0.96::numeric, 1),
        ('TSTABC123', 4, 5, 7, 0.79::numeric, 2),
        ('TSTABC128', 3, 2, 9, 0.76::numeric, 3),
        ('TSTLOW001', 1, 1, 23, 0.35::numeric, 2)
    ), fixture_reads AS (
      SELECT
        p.plate_number,
        n.read_index,
        CASE WHEN n.read_index % 3 = 0 THEN NULL ELSE
          '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAA3AGQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/2Q=='
        END AS image_data,
        date_trunc('day', CURRENT_TIMESTAMP)
          - (p.day_offset + ((n.read_index - 1) / 4)) * INTERVAL '1 day'
          + ((p.start_hour + n.read_index * 3) % 24) * INTERVAL '1 hour'
          + ((n.read_index * 7) % 60) * INTERVAL '1 minute' AS read_timestamp,
        (ARRAY['STG-FIX-NORTH', 'STG-FIX-DRIVE', 'STG-FIX-GATE', NULL])[
          1 + ((n.read_index - 1) % 4)
        ] AS camera_name,
        LEAST(0.99::numeric, p.confidence_start + (n.read_index - 1) * 0.03)::numeric(5,4) AS confidence,
        (n.read_index % p.validated_every = 0) AS validated
      FROM patterns p
      CROSS JOIN LATERAL generate_series(1, p.read_count) AS n(read_index)
    ), inserted AS (
      INSERT INTO public.plate_reads (
        plate_number,
        image_data,
        image_path,
        thumbnail_path,
        timestamp,
        created_at,
        camera_name,
        bi_path,
        plate_annotation,
        crop_coordinates,
        ocr_annotation,
        confidence,
        bi_zone,
        validated,
        event_identity
      )
      SELECT
        plate_number,
        image_data,
        NULL,
        NULL,
        read_timestamp,
        read_timestamp,
        camera_name,
        NULL,
        '[SYNTHETIC TEST DATA]',
        CASE WHEN read_index % 2 = 0 THEN ARRAY[100, 80, 540, 280] ELSE NULL END,
        jsonb_build_object(
          'synthetic', true,
          'fixture_set', '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26',
          'candidate', plate_number
        ),
        confidence,
        'STAGING',
        validated,
        'codex-fixture:ux-v1:' || plate_number || ':' || lpad(read_index::text, 2, '0')
      FROM fixture_reads
      RETURNING id
    )
    INSERT INTO public.codex_staging_fixture_manifest (fixture_set_id, entity_type, entity_key)
    SELECT '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26', 'plate_read', id::text
    FROM inserted;

    DO $fixture$
    DECLARE
      fixture_id constant uuid := '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26';
      mismatched_counts integer;
    BEGIN
      IF (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'plate') <> 10
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'plate_read') <> 31
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'known_plate') <> 7
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'tag') <> 4
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'plate_tag') <> 10
        OR (SELECT count(*) FROM public.codex_staging_fixture_manifest
          WHERE fixture_set_id = fixture_id AND entity_type = 'notification') <> 3 THEN
        RAISE EXCEPTION 'Fixture manifest counts do not match the expected dataset.';
      END IF;

      SELECT count(*) INTO mismatched_counts
      FROM public.plates p
      WHERE EXISTS (
        SELECT 1 FROM public.codex_staging_fixture_manifest m
        WHERE m.fixture_set_id = fixture_id
          AND m.entity_type = 'plate'
          AND m.entity_key = p.plate_number
      )
      AND p.occurrence_count <> (
        SELECT count(*) FROM public.plate_reads r WHERE r.plate_number = p.plate_number
      );
      IF mismatched_counts <> 0 THEN
        RAISE EXCEPTION 'Fixture occurrence counts are inconsistent.';
      END IF;
    END
    $fixture$;

  \endif
  COMMIT;
  \if :fixture_already_loaded
    \echo 'fixture_state=already_loaded fixture_plates=10 fixture_reads=31'
  \else
    \echo 'fixture_state=loaded fixture_plates=10 fixture_reads=31'
  \endif
\endif

\if :fixture_clear
  SELECT (
    to_regclass('public.codex_staging_fixture_sets') IS NOT NULL
    AND to_regclass('public.codex_staging_fixture_manifest') IS NOT NULL
  ) AS fixture_registry_exists \gset

  \if :fixture_registry_exists
    SELECT EXISTS (
      SELECT 1
      FROM public.codex_staging_fixture_sets
      WHERE fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26'::uuid
    ) AS fixture_set_exists \gset
    \if :fixture_set_exists
    BEGIN;
    SELECT pg_advisory_xact_lock(hashtextextended('codex-alpr-staging-fixtures:v1', 0));

    UPDATE public.codex_staging_fixture_sets
    SET state = 'deleting', updated_at = CURRENT_TIMESTAMP
    WHERE fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26';

    DO $fixture$
    DECLARE
      fixture_id constant uuid := '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26';
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM public.plate_reads r
        JOIN public.codex_staging_fixture_manifest p
          ON p.fixture_set_id = fixture_id
          AND p.entity_type = 'plate'
          AND p.entity_key = r.plate_number
        WHERE NOT EXISTS (
          SELECT 1 FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = fixture_id
            AND m.entity_type = 'plate_read'
            AND m.entity_key = r.id::text
        )
      ) OR EXISTS (
        SELECT 1
        FROM public.known_plates k
        JOIN public.codex_staging_fixture_manifest p
          ON p.fixture_set_id = fixture_id
          AND p.entity_type = 'plate'
          AND p.entity_key = k.plate_number
        WHERE NOT EXISTS (
          SELECT 1 FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = fixture_id
            AND m.entity_type = 'known_plate'
            AND m.entity_key = k.plate_number
        )
      ) OR EXISTS (
        SELECT 1
        FROM public.plate_tags pt
        WHERE (
          EXISTS (
            SELECT 1 FROM public.codex_staging_fixture_manifest p
            WHERE p.fixture_set_id = fixture_id
              AND p.entity_type = 'plate'
              AND p.entity_key = pt.plate_number
          ) OR EXISTS (
            SELECT 1 FROM public.codex_staging_fixture_manifest t
            WHERE t.fixture_set_id = fixture_id
              AND t.entity_type = 'tag'
              AND t.entity_key = pt.tag_id::text
          )
        ) AND NOT EXISTS (
          SELECT 1 FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = fixture_id
            AND m.entity_type = 'plate_tag'
            AND m.entity_key = pt.plate_number || '|' || pt.tag_id::text
        )
      ) OR EXISTS (
        SELECT 1
        FROM public.plate_notifications n
        JOIN public.codex_staging_fixture_manifest p
          ON p.fixture_set_id = fixture_id
          AND p.entity_type = 'plate'
          AND p.entity_key = n.plate_number
        WHERE NOT EXISTS (
          SELECT 1 FROM public.codex_staging_fixture_manifest m
          WHERE m.fixture_set_id = fixture_id
            AND m.entity_type = 'notification'
            AND m.entity_key = n.id::text
        )
      ) THEN
        RAISE EXCEPTION 'Refusing cleanup because fixture records have unowned dependent data.';
      END IF;
    END
    $fixture$;

    DELETE FROM public.plate_notifications n
    USING public.codex_staging_fixture_manifest m
    WHERE m.fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26'
      AND m.entity_type = 'notification'
      AND m.entity_key = n.id::text;

    DELETE FROM public.plate_tags pt
    USING public.codex_staging_fixture_manifest m
    WHERE m.fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26'
      AND (
        m.entity_type = 'plate_tag'
        AND m.entity_key = pt.plate_number || '|' || pt.tag_id::text
      );

    DELETE FROM public.known_plates k
    USING public.codex_staging_fixture_manifest m
    WHERE m.fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26'
      AND m.entity_type = 'known_plate'
      AND m.entity_key = k.plate_number;

    DELETE FROM public.plate_reads r
    USING public.codex_staging_fixture_manifest m
    WHERE m.fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26'
      AND m.entity_type = 'plate_read'
      AND m.entity_key = r.id::text;

    DELETE FROM public.plates p
    USING public.codex_staging_fixture_manifest m
    WHERE m.fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26'
      AND m.entity_type = 'plate'
      AND m.entity_key = p.plate_number
      AND NOT EXISTS (
        SELECT 1 FROM public.plate_reads r WHERE r.plate_number = p.plate_number
      );

    DELETE FROM public.tags t
    USING public.codex_staging_fixture_manifest m
    WHERE m.fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26'
      AND m.entity_type = 'tag'
      AND m.entity_key = t.id::text
      AND NOT EXISTS (
        SELECT 1 FROM public.plate_tags pt WHERE pt.tag_id = t.id
      );

    DO $fixture$
    DECLARE
      fixture_id constant uuid := '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26';
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.codex_staging_fixture_manifest m
        JOIN public.plates p ON m.entity_type = 'plate' AND m.entity_key = p.plate_number
        WHERE m.fixture_set_id = fixture_id
      ) OR EXISTS (
        SELECT 1 FROM public.codex_staging_fixture_manifest m
        JOIN public.plate_reads r ON m.entity_type = 'plate_read' AND m.entity_key = r.id::text
        WHERE m.fixture_set_id = fixture_id
      ) OR EXISTS (
        SELECT 1 FROM public.codex_staging_fixture_manifest m
        JOIN public.tags t ON m.entity_type = 'tag' AND m.entity_key = t.id::text
        WHERE m.fixture_set_id = fixture_id
      ) OR EXISTS (
        SELECT 1 FROM public.codex_staging_fixture_manifest m
        JOIN public.known_plates k ON m.entity_type = 'known_plate' AND m.entity_key = k.plate_number
        WHERE m.fixture_set_id = fixture_id
      ) OR EXISTS (
        SELECT 1 FROM public.codex_staging_fixture_manifest m
        JOIN public.plate_tags pt ON m.entity_type = 'plate_tag'
          AND m.entity_key = pt.plate_number || '|' || pt.tag_id::text
        WHERE m.fixture_set_id = fixture_id
      ) OR EXISTS (
        SELECT 1 FROM public.codex_staging_fixture_manifest m
        JOIN public.plate_notifications n ON m.entity_type = 'notification' AND m.entity_key = n.id::text
        WHERE m.fixture_set_id = fixture_id
      ) THEN
        RAISE EXCEPTION 'Fixture cleanup found retained owned data; no changes were committed.';
      END IF;
    END
    $fixture$;

    DELETE FROM public.codex_staging_fixture_manifest
    WHERE fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26';
    DELETE FROM public.codex_staging_fixture_sets
    WHERE fixture_set_id = '5d5d95b7-5df0-4b10-8e20-7edb4d7d3b26';

    COMMIT;
    \echo 'fixture_state=cleared fixture_sets=0 fixture_records=0'
    \else
      \echo 'fixture_state=already_clear fixture_sets=0 fixture_records=0'
    \endif
  \else
    \echo 'fixture_state=already_clear fixture_sets=0 fixture_records=0'
  \endif
\endif
