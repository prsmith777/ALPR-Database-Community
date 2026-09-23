import {
  evaluateShadowPair,
  shadowDecisionIdentity,
  VEHICLE_EVENT_SHADOW_ALGORITHM,
} from "./vehicle-event-shadow-model.mjs";

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value), 10);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}

const CURRENT_OBSERVATION_SELECT = `
  SELECT reads.id AS read_id,
         reads.plate_number AS effective_plate,
         reads.camera_name AS read_camera_name,
         reads."timestamp"::text AS read_timestamp,
         reads.bi_trigger_direction_status AS direction_status,
         reads.bi_trigger_direction_label AS direction_label,
         links.asset_id,
         links.source_kind,
         links.source_read_id,
         links.source_path_snapshot,
         links.source_updated_at::text AS source_updated_at,
         links.captured_at::text AS captured_at,
         links.identity_eligible,
         links.overview_context,
         assets.content_sha256
  FROM public.vehicle_image_asset_reads links
  JOIN public.vehicle_image_assets assets ON assets.id = links.asset_id
  JOIN public.plate_reads reads ON reads.id = links.read_id`;

const CURRENT_OBSERVATION_PREDICATE = `
  links.identity_eligible = TRUE
  AND reads.vehicle_image_status = 'ready'
  AND NULLIF(BTRIM(reads.vehicle_image_path), '') IS NOT NULL
  AND reads.vehicle_image_path = links.source_path_snapshot
  AND reads.vehicle_image_source_kind = links.source_kind
  AND reads.vehicle_image_source_read_id IS NOT DISTINCT FROM links.source_read_id
  AND reads.vehicle_image_timestamp IS NOT DISTINCT FROM links.captured_at
  AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
  AND NULLIF(BTRIM(reads.plate_number), '') IS NOT NULL
  AND NULLIF(BTRIM(reads.camera_name), '') IS NOT NULL`;

function sameText(left, right) {
  return String(left ?? "") === String(right ?? "");
}

function sameObservation(left, right) {
  return Number(left?.read_id) === Number(right?.read_id)
    && Number(left?.asset_id) === Number(right?.asset_id)
    && sameText(left?.effective_plate, right?.effective_plate)
    && sameText(left?.read_camera_name, right?.read_camera_name)
    && sameText(left?.read_timestamp, right?.read_timestamp)
    && sameText(left?.direction_status, right?.direction_status)
    && sameText(left?.direction_label, right?.direction_label)
    && sameText(left?.source_kind, right?.source_kind)
    && Number(left?.source_read_id || 0) === Number(right?.source_read_id || 0)
    && sameText(left?.source_path_snapshot, right?.source_path_snapshot)
    && sameText(left?.source_updated_at, right?.source_updated_at)
    && sameText(left?.captured_at, right?.captured_at)
    && sameText(left?.overview_context, right?.overview_context);
}

export class VehicleEventShadowRepository {
  constructor(pool) {
    if (!pool || typeof pool.query !== "function") {
      throw new Error("Shadow vehicle events require a database pool");
    }
    this.pool = pool;
  }

  async withTransaction(operation) {
    const ownsClient = typeof this.pool.connect === "function";
    const client = ownsClient ? await this.pool.connect() : this.pool;
    try {
      await client.query("BEGIN");
      const result = await operation(new VehicleEventShadowRepository(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      if (ownsClient) client.release();
    }
  }

  async getControl() {
    const result = await this.pool.query(
      `SELECT enabled, settle_seconds, batch_size, enabled_at, disabled_at, updated_at
       FROM public.vehicle_event_shadow_control WHERE singleton = TRUE`
    );
    const row = result.rows?.[0] || {};
    return {
      enabled: row.enabled === true,
      settleSeconds: boundedInteger(row.settle_seconds, 20, 5, 300),
      batchSize: boundedInteger(row.batch_size, 25, 5, 100),
      enabledAt: row.enabled_at || null,
      disabledAt: row.disabled_at || null,
      updatedAt: row.updated_at || null,
    };
  }

  async setEnabled({ enabled, actorUserId }) {
    const requested = enabled === true;
    const actorId = positiveInteger(actorUserId, "Actor user id");
    return this.withTransaction(async (repository) => {
      await repository.pool.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle-event-shadow-control'))"
      );
      if (requested) {
        const readiness = await repository.pool.query(
          `SELECT EXISTS (
             SELECT 1 FROM public.vehicle_image_asset_catalog_runs
             WHERE status = 'completed' AND phase = 'completed'
           ) AS completed_catalog`
        );
        if (readiness.rows?.[0]?.completed_catalog !== true) {
          throw new Error(
            "Complete the canonical Overview catalog before enabling shadow vehicle events."
          );
        }
      }
      await repository.pool.query(
        `UPDATE public.vehicle_event_shadow_control
         SET enabled = $1, enabled_by_user_id = $2,
             enabled_at = CASE WHEN $1 THEN CURRENT_TIMESTAMP ELSE enabled_at END,
             disabled_at = CASE WHEN $1 THEN NULL ELSE CURRENT_TIMESTAMP END,
             updated_at = CURRENT_TIMESTAMP
         WHERE singleton = TRUE`,
        [requested, actorId]
      );
      await repository.pool.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id,
           outcome, metadata
         ) VALUES ($1, 'browser', $2, 'vehicle_event_shadow', 'singleton',
           'succeeded', $3::jsonb)`,
        [
          actorId,
          requested
            ? "maintenance.vehicle_event_shadow_enabled"
            : "maintenance.vehicle_event_shadow_disabled",
          JSON.stringify({
            enabled: requested,
            affectsIngestion: false,
            affectsReId: false,
            externalProviderContacted: false,
          }),
        ]
      );
      return repository.getControl();
    });
  }

  async listPendingCandidates({ limit = 25, settleSeconds = 20 } = {}) {
    const boundedLimit = boundedInteger(limit, 25, 1, 100);
    const settle = boundedInteger(settleSeconds, 20, 5, 300);
    const result = await this.pool.query(
      `${CURRENT_OBSERVATION_SELECT}
       WHERE ${CURRENT_OBSERVATION_PREDICATE}
         AND reads."timestamp" <= CURRENT_TIMESTAMP - ($1 || ' seconds')::interval
         AND links.updated_at <= CURRENT_TIMESTAMP - ($1 || ' seconds')::interval
         AND NOT EXISTS (
           SELECT 1 FROM public.vehicle_event_reads assigned
           WHERE assigned.read_id = reads.id AND assigned.active = TRUE
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.vehicle_event_shadow_decisions decisions
           WHERE decisions.anchor_read_id = reads.id
             AND decisions.anchor_asset_id = links.asset_id
             AND decisions.anchor_source_kind = links.source_kind
             AND decisions.anchor_source_read_id IS NOT DISTINCT FROM links.source_read_id
             AND decisions.anchor_source_path = links.source_path_snapshot
             AND decisions.anchor_source_updated_at
                   IS NOT DISTINCT FROM links.source_updated_at
             AND decisions.anchor_captured_at IS NOT DISTINCT FROM links.captured_at
             AND decisions.anchor_plate_snapshot = reads.plate_number
             AND decisions.anchor_direction_status
                   IS NOT DISTINCT FROM reads.bi_trigger_direction_status
             AND decisions.anchor_direction_label
                   IS NOT DISTINCT FROM reads.bi_trigger_direction_label
         )
       ORDER BY reads."timestamp", reads.id
       LIMIT $2`,
      [settle, boundedLimit]
    );
    return result.rows || [];
  }

  async findCompanions(anchor) {
    const context = anchor?.overview_context === "entry" ? "entry" : "street";
    const maximumReadGapMs = context === "entry" ? 5_000 : 12_000;
    const result = await this.pool.query(
      `${CURRENT_OBSERVATION_SELECT}
       WHERE ${CURRENT_OBSERVATION_PREDICATE}
         AND reads.id <> $1
         AND links.overview_context = $2
         AND LOWER(BTRIM(reads.plate_number)) = LOWER(BTRIM($3))
         AND LOWER(BTRIM(reads.camera_name)) <> LOWER(BTRIM($4))
         AND ABS(EXTRACT(EPOCH FROM (
           reads."timestamp" - $5::timestamptz
         )) * 1000) <= $6
         AND NOT EXISTS (
           SELECT 1 FROM public.vehicle_event_reads assigned
           WHERE assigned.read_id = reads.id AND assigned.active = TRUE
         )
       ORDER BY ABS(EXTRACT(EPOCH FROM (
         reads."timestamp" - $5::timestamptz
       ))), reads.id
       LIMIT 5`,
      [
        positiveInteger(anchor?.read_id, "Anchor read id"),
        context,
        String(anchor?.effective_plate || ""),
        String(anchor?.read_camera_name || ""),
        anchor?.read_timestamp,
        maximumReadGapMs,
      ]
    );
    return result.rows || [];
  }

  async getCurrentObservations(readIds, { lock = false } = {}) {
    const ids = [...new Set((readIds || []).map((value) => positiveInteger(value, "Read id")))];
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `${CURRENT_OBSERVATION_SELECT}
       WHERE ${CURRENT_OBSERVATION_PREDICATE}
         AND reads.id = ANY($1::int[])
       ORDER BY reads.id
       ${lock ? "FOR UPDATE OF reads, links" : ""}`,
      [ids]
    );
    return result.rows || [];
  }

  async recordRejectedDecision(anchor, evaluation) {
    return this.withTransaction(async (repository) => {
      await repository.pool.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle-event-shadow-materialize'))"
      );
      const decisionIdentity = shadowDecisionIdentity(anchor, evaluation);
      const current = await repository.getCurrentObservations(
        [anchor.read_id], { lock: true }
      );
      if (current.length !== 1 || !sameObservation(current[0], anchor)) {
        return { status: "superseded", created: false };
      }
      const assigned = await repository.pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM public.vehicle_event_reads
           WHERE read_id = $1 AND active = TRUE
         ) AS assigned`,
        [positiveInteger(anchor.read_id, "Anchor read id")]
      );
      if (assigned.rows?.[0]?.assigned === true) {
        return { status: "already_assigned", created: false };
      }
      const result = await repository.pool.query(
        `INSERT INTO public.vehicle_event_shadow_decisions (
           decision_identity, outcome, reason, overview_context,
           anchor_read_id, anchor_asset_id, anchor_source_kind,
           anchor_source_read_id, anchor_source_path,
           anchor_source_updated_at, anchor_captured_at,
           anchor_plate_snapshot, anchor_direction_status,
           anchor_direction_label, candidate_count, correlation_algorithm,
           decision_metadata
         ) VALUES (
           $1, 'rejected', $2, $3, $4, $5, $6, $7, $8,
           $9::timestamptz, $10::timestamptz, $11, $12, $13, $14,
           $15, $16::jsonb
         ) ON CONFLICT (decision_identity) DO NOTHING
         RETURNING id`,
        [
          decisionIdentity,
          String(evaluation.reason || "NO_CONFIDENT_COMPANION"),
          anchor.overview_context,
          positiveInteger(anchor.read_id, "Anchor read id"),
          positiveInteger(anchor.asset_id, "Anchor asset id"),
          anchor.source_kind,
          anchor.source_read_id ?? null,
          anchor.source_path_snapshot,
          anchor.source_updated_at ?? null,
          anchor.captured_at ?? null,
          anchor.effective_plate,
          anchor.direction_status || null,
          anchor.direction_label || null,
          Number(evaluation.candidateCount || 0),
          VEHICLE_EVENT_SHADOW_ALGORITHM,
          JSON.stringify(evaluation.metadata || {}),
        ]
      );
      return { status: "rejected", created: Number(result.rowCount || 0) === 1 };
    });
  }

  async createProposedEvent(anchor, evaluation) {
    const companion = evaluation?.companion;
    if (!companion || evaluation?.outcome !== "proposed") {
      throw new Error("A proposed shadow event requires one companion");
    }
    return this.withTransaction(async (repository) => {
      await repository.pool.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle-event-shadow-materialize'))"
      );
      const current = await repository.getCurrentObservations(
        [anchor.read_id, companion.read_id], { lock: true }
      );
      const liveAnchor = current.find((row) => Number(row.read_id) === Number(anchor.read_id));
      const liveCompanion = current.find(
        (row) => Number(row.read_id) === Number(companion.read_id)
      );
      if (!liveAnchor || !liveCompanion
          || !sameObservation(liveAnchor, anchor)
          || !sameObservation(liveCompanion, companion)) {
        return { status: "superseded", created: false };
      }
      const liveEvaluation = evaluateShadowPair(liveAnchor, [liveCompanion]);
      if (liveEvaluation.outcome !== "proposed"
          || liveEvaluation.event.eventIdentity !== evaluation.event.eventIdentity) {
        return { status: "superseded", created: false };
      }

      const assigned = await repository.pool.query(
        `SELECT read_id FROM public.vehicle_event_reads
         WHERE active = TRUE AND read_id = ANY($1::int[])
         LIMIT 1`,
        [[Number(anchor.read_id), Number(companion.read_id)]]
      );
      if (Number(assigned.rowCount || 0) > 0) {
        return { status: "already_assigned", created: false };
      }

      const event = liveEvaluation.event;
      const inserted = await repository.pool.query(
        `INSERT INTO public.vehicle_events (
           event_identity, status, overview_context, correlation_class,
           event_timestamp, first_read_at, last_read_at,
           effective_plate_snapshot, direction_label_snapshot,
           correlation_algorithm, correlation_revision, decision_metadata
         ) VALUES (
           $1, 'shadow', $2, $3, $4::timestamptz, $5::timestamptz,
           $6::timestamptz, $7, $8, $9, $10, $11::jsonb
         ) ON CONFLICT (event_identity) DO NOTHING
         RETURNING id`,
        [
          event.eventIdentity,
          event.overviewContext,
          event.correlationClass,
          event.eventTimestamp,
          event.firstReadAt,
          event.lastReadAt,
          event.effectivePlateSnapshot,
          event.directionLabelSnapshot,
          event.correlationAlgorithm,
          event.correlationRevision,
          JSON.stringify(event.metadata || {}),
        ]
      );
      let eventId = Number(inserted.rows?.[0]?.id || 0);
      if (!eventId) {
        const existing = await repository.pool.query(
          "SELECT id FROM public.vehicle_events WHERE event_identity = $1",
          [event.eventIdentity]
        );
        eventId = Number(existing.rows?.[0]?.id || 0);
        return { status: "already_exists", eventId, created: false };
      }

      for (const [role, row] of [["anchor", liveAnchor], ["companion", liveCompanion]]) {
        await repository.pool.query(
          `INSERT INTO public.vehicle_event_reads (
             event_id, read_id, role, asset_id, read_camera_name,
             read_timestamp, effective_plate_snapshot,
             direction_status_snapshot, direction_label_snapshot,
             source_kind_snapshot, source_read_id_snapshot, source_path_snapshot,
             source_updated_at_snapshot, captured_at_snapshot, active
           ) VALUES (
             $1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9,
             $10, $11, $12, $13::timestamptz, $14::timestamptz, TRUE
           )`,
          [
            eventId,
            row.read_id,
            role,
            row.asset_id,
            row.read_camera_name,
            row.read_timestamp,
            row.effective_plate,
            row.direction_status || null,
            row.direction_label || null,
            row.source_kind,
            row.source_read_id ?? null,
            row.source_path_snapshot,
            row.source_updated_at ?? null,
            row.captured_at ?? null,
          ]
        );
      }

      const assets = [liveAnchor, liveCompanion].filter(
        (row, index, rows) => rows.findIndex(
          (candidate) => Number(candidate.asset_id) === Number(row.asset_id)
        ) === index
      );
      for (const [index, row] of assets.entries()) {
        await repository.pool.query(
          `INSERT INTO public.vehicle_event_assets (
             event_id, asset_id, role, identity_eligible
           ) VALUES ($1, $2, $3, TRUE)`,
          [eventId, row.asset_id, index === 0 ? "primary" : "supporting"]
        );
      }

      for (const [decisionAnchor, decisionCompanion] of [
        [liveAnchor, liveCompanion], [liveCompanion, liveAnchor],
      ]) {
        const oriented = evaluateShadowPair(decisionAnchor, [decisionCompanion]);
        await repository.pool.query(
          `INSERT INTO public.vehicle_event_shadow_decisions (
             decision_identity, event_id, outcome, reason, overview_context,
             anchor_read_id, companion_read_id, anchor_asset_id,
             companion_asset_id, anchor_source_kind, anchor_source_read_id,
             anchor_source_path, anchor_source_updated_at, anchor_captured_at,
             anchor_plate_snapshot,
             anchor_direction_status, anchor_direction_label, candidate_count,
             correlation_algorithm, decision_metadata
           ) VALUES (
             $1, $2, 'proposed', $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12::timestamptz, $13::timestamptz, $14, $15, $16,
             $17, $18, $19::jsonb
           ) ON CONFLICT (decision_identity) DO NOTHING`,
          [
            shadowDecisionIdentity(decisionAnchor, oriented),
            eventId,
            oriented.reason,
            decisionAnchor.overview_context,
            decisionAnchor.read_id,
            decisionCompanion.read_id,
            decisionAnchor.asset_id,
            decisionCompanion.asset_id,
            decisionAnchor.source_kind,
            decisionAnchor.source_read_id ?? null,
            decisionAnchor.source_path_snapshot,
            decisionAnchor.source_updated_at ?? null,
            decisionAnchor.captured_at ?? null,
            decisionAnchor.effective_plate,
            decisionAnchor.direction_status || null,
            decisionAnchor.direction_label || null,
            oriented.candidateCount,
            VEHICLE_EVENT_SHADOW_ALGORITHM,
            JSON.stringify(oriented.event?.metadata || {}),
          ]
        );
      }
      return { status: "proposed", eventId, created: true };
    });
  }

  async retireStaleEvents({ limit = 25 } = {}) {
    const boundedLimit = boundedInteger(limit, 25, 1, 100);
    return this.withTransaction(async (repository) => {
      const stale = await repository.pool.query(
        `SELECT events.id
         FROM public.vehicle_events events
         WHERE events.status = 'shadow'
           AND EXISTS (
             SELECT 1
             FROM public.vehicle_event_reads event_reads
             LEFT JOIN public.plate_reads reads ON reads.id = event_reads.read_id
             LEFT JOIN public.vehicle_image_asset_reads links
               ON links.read_id = event_reads.read_id
             WHERE event_reads.event_id = events.id
               AND event_reads.active = TRUE
               AND (
                 reads.id IS NULL OR links.read_id IS NULL
                 OR links.identity_eligible IS DISTINCT FROM TRUE
                 OR links.asset_id IS DISTINCT FROM event_reads.asset_id
                 OR reads.vehicle_image_status IS DISTINCT FROM 'ready'
                 OR reads.vehicle_image_path
                      IS DISTINCT FROM event_reads.source_path_snapshot
                 OR reads.vehicle_image_source_kind
                      IS DISTINCT FROM event_reads.source_kind_snapshot
                 OR reads.vehicle_image_source_read_id
                      IS DISTINCT FROM links.source_read_id
                 OR links.source_read_id
                      IS DISTINCT FROM event_reads.source_read_id_snapshot
                 OR reads.vehicle_image_timestamp
                      IS DISTINCT FROM links.captured_at
                 OR reads.vehicle_image_updated_at
                      IS DISTINCT FROM event_reads.source_updated_at_snapshot
                 OR links.captured_at
                      IS DISTINCT FROM event_reads.captured_at_snapshot
                 OR links.overview_context IS DISTINCT FROM events.overview_context
                 OR reads.plate_number
                      IS DISTINCT FROM event_reads.effective_plate_snapshot
                 OR reads.camera_name IS DISTINCT FROM event_reads.read_camera_name
                 OR reads."timestamp" IS DISTINCT FROM event_reads.read_timestamp
                 OR reads.bi_trigger_direction_status
                      IS DISTINCT FROM event_reads.direction_status_snapshot
                 OR reads.bi_trigger_direction_label
                      IS DISTINCT FROM event_reads.direction_label_snapshot
               )
           )
         ORDER BY events.id
         FOR UPDATE OF events SKIP LOCKED
         LIMIT $1`,
        [boundedLimit]
      );
      const ids = (stale.rows || []).map((row) => Number(row.id)).filter(Boolean);
      if (ids.length === 0) return 0;
      await repository.pool.query(
        `UPDATE public.vehicle_events
         SET status = 'retired', retired_reason = 'SOURCE_SNAPSHOT_CHANGED',
             retired_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1::bigint[])`,
        [ids]
      );
      await repository.pool.query(
        `UPDATE public.vehicle_event_reads SET active = FALSE
         WHERE event_id = ANY($1::bigint[]) AND active = TRUE`,
        [ids]
      );
      return ids.length;
    });
  }

  async getOverview() {
    const [control, metrics, recent] = await Promise.all([
      this.getControl(),
      this.pool.query(
        `WITH current_observations AS (
           ${CURRENT_OBSERVATION_SELECT}
           WHERE ${CURRENT_OBSERVATION_PREDICATE}
         )
         SELECT
           (SELECT COUNT(*) FROM current_observations)::bigint
             AS eligible_observations,
           (SELECT COUNT(*) FROM current_observations observations
             WHERE NOT EXISTS (
               SELECT 1 FROM public.vehicle_event_reads event_reads
               WHERE event_reads.read_id = observations.read_id
                 AND event_reads.active = TRUE
             ))::bigint AS unpaired_observations,
           COUNT(*) FILTER (WHERE events.status = 'shadow')::bigint
             AS active_events,
           COUNT(*) FILTER (WHERE events.status = 'retired')::bigint
             AS retired_events,
           COUNT(*) FILTER (WHERE events.status = 'shadow'
             AND events.correlation_class = 'shared_asset')::bigint
             AS shared_asset_events,
           COUNT(*) FILTER (WHERE events.status = 'shadow'
             AND events.correlation_class = 'timed_pair')::bigint
             AS timed_pair_events,
           COALESCE((SELECT COUNT(*) FROM public.vehicle_event_reads
             WHERE active = TRUE), 0)::bigint AS correlated_reads,
           COALESCE((SELECT COUNT(*) FROM public.vehicle_event_shadow_decisions
             WHERE outcome = 'rejected'), 0)::bigint AS rejected_decisions,
           MAX(events.created_at) FILTER (WHERE events.status = 'shadow')
             AS last_event_at
         FROM public.vehicle_events events`
      ),
      this.pool.query(
        `SELECT decisions.id, decisions.outcome, decisions.reason,
                decisions.overview_context, decisions.anchor_read_id,
                decisions.companion_read_id, decisions.candidate_count,
                decisions.created_at, events.correlation_class
         FROM public.vehicle_event_shadow_decisions decisions
         LEFT JOIN public.vehicle_events events ON events.id = decisions.event_id
         ORDER BY decisions.created_at DESC, decisions.id DESC
         LIMIT 20`
      ),
    ]);
    return {
      control,
      counts: metrics.rows?.[0] || {},
      recentDecisions: recent.rows || [],
    };
  }
}

export const vehicleEventShadowRepositoryInternals = Object.freeze({
  CURRENT_OBSERVATION_SELECT,
  CURRENT_OBSERVATION_PREDICATE,
  sameObservation,
});
