const ACTIONS = new Set(["confirm", "correct", "reject", "reopen"]);
const STATUSES = new Set(["unreviewed", "confirmed", "corrected", "rejected", "alias_resolved"]);

export class PlateReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlateReviewError";
    this.code = code;
  }
}

export function normalizePlateValue(value, label = "Plate") {
  const plate = String(value || "").trim().toUpperCase();
  if (!plate || plate.length > 10) {
    throw new PlateReviewError("INVALID_PLATE", label + " must contain between 1 and 10 characters.");
  }
  return plate;
}

function normalizedText(value, maxLength) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function requireReason(value) {
  const reason = normalizedText(value, 120);
  if (!reason) {
    throw new PlateReviewError("REASON_REQUIRED", "Select or enter a reason for this review action.");
  }
  return reason;
}

function actorSnapshot(actor = {}) {
  const parsedId = Number(actor.id);
  return {
    id: Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null,
    username: String(actor.username || "legacy-admin").slice(0, 64),
    displayName: String(actor.displayName || "Legacy Administrator").slice(0, 120),
  };
}

async function audit(client, { actor, source = "browser", eventType, resourceType, resourceId, reason = null, metadata = {} }) {
  await client.query(
    "INSERT INTO public.audit_events " +
      "(actor_user_id, source, event_type, resource_type, resource_id, outcome, reason, metadata) " +
      "VALUES ($1::bigint, $2, $3, $4, $5, 'succeeded', $6, $7::jsonb)",
    [actor?.id || null, source, eventType, resourceType, resourceId == null ? null : String(resourceId), reason, JSON.stringify(metadata)]
  );
}

export async function resolvePlateAliasWithClient(client, { observedPlate, cameraName = null }) {
  const source = normalizePlateValue(observedPlate, "Observed plate");
  const result = await client.query(
    "SELECT id, source_plate, target_plate, camera_name, reason " +
      "FROM public.plate_aliases WHERE enabled = TRUE AND source_plate = $1 " +
      "AND (camera_name IS NULL OR LOWER(camera_name) = LOWER($2)) " +
      "ORDER BY (camera_name IS NOT NULL) DESC, id DESC LIMIT 1",
    [source, cameraName || null]
  );
  return result.rows[0] || null;
}

export async function recordAliasApplicationWithClient(
  client,
  { readId, eventIdentity = null, alias, observedPlate }
) {
  if (!alias) return;
  await client.query(
    "INSERT INTO public.plate_read_reviews " +
      "(read_id, read_event_identity, action, previous_plate, new_plate, previous_status, new_status, " +
      "reason, actor_username, actor_display_name, alias_id) " +
      "VALUES ($1, $2, 'alias_applied', $3, $4, 'unreviewed', 'alias_resolved', " +
      "'reviewed_recurring_alias', 'system', 'Automatic alias resolution', $5)",
    [readId, eventIdentity, observedPlate, alias.target_plate, alias.id]
  );
  await client.query(
    "UPDATE public.plate_aliases SET use_count = use_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = $1",
    [alias.id]
  );
  await audit(client, {
    actor: null,
    source: "system",
    eventType: "plate.alias_applied",
    resourceType: "plate_read",
    resourceId: readId,
    reason: "reviewed_recurring_alias",
    metadata: { aliasId: alias.id, observedPlate, effectivePlate: alias.target_plate },
  });
}

export class PlateReviewRepository {
  constructor({ getPool }) {
    if (typeof getPool !== "function") throw new TypeError("PlateReviewRepository requires getPool.");
    this.getPool = getPool;
  }

  async transaction(operation) {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getHistory(readId) {
    const pool = await this.getPool();
    const result = await pool.query(
      "SELECT id, read_id, action, previous_plate, new_plate, previous_status, new_status, reason, notes, " +
        "actor_user_id, actor_username, actor_display_name, alias_id, batch_id, reverses_review_id, created_at " +
        "FROM public.plate_read_reviews WHERE read_id = $1 ORDER BY created_at DESC, id DESC",
      [Number(readId)]
    );
    return result.rows;
  }

  async reviewRead({ readId, action, newPlate = null, reason = null, notes = null, actor }) {
    const reviewAction = String(action || "").trim().toLowerCase();
    if (!ACTIONS.has(reviewAction)) {
      throw new PlateReviewError("INVALID_ACTION", "Unknown plate review action.");
    }
    const reviewer = actorSnapshot(actor);
    return await this.transaction(async (client) => {
      const selected = await client.query(
        "SELECT id, event_identity, COALESCE(observed_plate, plate_number) AS observed_plate, plate_number, " +
          "COALESCE(review_status, CASE WHEN validated THEN 'confirmed' ELSE 'unreviewed' END) AS review_status, " +
          "COALESCE(review_revision, 0) AS review_revision FROM public.plate_reads WHERE id = $1 FOR UPDATE",
        [Number(readId)]
      );
      const read = selected.rows[0];
      if (!read) throw new PlateReviewError("READ_NOT_FOUND", "Plate read was not found.");

      let effectivePlate = read.plate_number;
      let nextStatus = read.review_status;
      let validated = true;
      const reviewReason =
        reviewAction === "correct" || reviewAction === "reject"
          ? requireReason(reason)
          : normalizedText(reason, 120);

      if (reviewAction === "correct") {
        effectivePlate = normalizePlateValue(newPlate, "Corrected plate");
        if (effectivePlate === read.plate_number) {
          throw new PlateReviewError("PLATE_UNCHANGED", "The corrected plate is already the effective plate.");
        }
        nextStatus = "corrected";
      } else if (reviewAction === "confirm") {
        nextStatus = "confirmed";
      } else if (reviewAction === "reject") {
        nextStatus = "rejected";
        validated = false;
      } else {
        nextStatus = "unreviewed";
        validated = false;
      }

      if (!STATUSES.has(nextStatus)) throw new PlateReviewError("INVALID_STATUS", "Invalid review status.");
      if (effectivePlate !== read.plate_number) {
        await client.query(
          "INSERT INTO public.plates (plate_number) VALUES ($1) ON CONFLICT (plate_number) DO NOTHING",
          [effectivePlate]
        );
      }
      await client.query(
        "UPDATE public.plate_reads SET plate_number = $2, validated = $3, review_status = $4, " +
          "review_revision = COALESCE(review_revision, 0) + 1, last_reviewed_at = CURRENT_TIMESTAMP, " +
          "last_reviewed_by = $5 WHERE id = $1",
        [read.id, effectivePlate, validated, nextStatus, reviewer.id]
      );
      const inserted = await client.query(
        "INSERT INTO public.plate_read_reviews " +
          "(read_id, read_event_identity, action, previous_plate, new_plate, previous_status, new_status, " +
          "reason, notes, actor_user_id, actor_username, actor_display_name) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11, $12) RETURNING id",
        [
          read.id,
          read.event_identity,
          reviewAction,
          read.plate_number,
          effectivePlate,
          read.review_status,
          nextStatus,
          reviewReason,
          normalizedText(notes, 2000),
          reviewer.id,
          reviewer.username,
          reviewer.displayName,
        ]
      );
      await audit(client, {
        actor: reviewer,
        eventType: "plate." + reviewAction,
        resourceType: "plate_read",
        resourceId: read.id,
        reason: reviewReason,
        metadata: {
          observedPlate: read.observed_plate,
          previousPlate: read.plate_number,
          effectivePlate,
          previousStatus: read.review_status,
          newStatus: nextStatus,
          reviewId: inserted.rows[0].id,
        },
      });
      return {
        id: read.id,
        observedPlate: read.observed_plate,
        effectivePlate,
        reviewStatus: nextStatus,
        reviewRevision: Number(read.review_revision) + 1,
        reviewId: inserted.rows[0].id,
      };
    });
  }

  async reverseLatestReview({ readId, reason, actor }) {
    const reviewer = actorSnapshot(actor);
    const reversalReason = requireReason(reason);
    return await this.transaction(async (client) => {
      const selected = await client.query(
        "SELECT id, event_identity, plate_number, COALESCE(review_status, 'unreviewed') AS review_status " +
          "FROM public.plate_reads WHERE id = $1 FOR UPDATE",
        [Number(readId)]
      );
      const read = selected.rows[0];
      if (!read) throw new PlateReviewError("READ_NOT_FOUND", "Plate read was not found.");
      const latest = await client.query(
        "SELECT review.* FROM public.plate_read_reviews AS review WHERE review.read_id = $1 " +
          "AND review.action IN ('confirm', 'correct', 'reject', 'reopen') " +
          "AND NOT EXISTS (SELECT 1 FROM public.plate_read_reviews AS reversal " +
          "WHERE reversal.reverses_review_id = review.id) " +
          "ORDER BY review.created_at DESC, review.id DESC LIMIT 1 FOR UPDATE",
        [read.id]
      );
      const prior = latest.rows[0];
      if (!prior) {
        throw new PlateReviewError("NOTHING_TO_REVERSE", "There is no review action to reverse.");
      }
      const restoredStatus = STATUSES.has(prior.previous_status) ? prior.previous_status : "unreviewed";
      const restoredPlate = normalizePlateValue(prior.previous_plate);
      await client.query(
        "UPDATE public.plate_reads SET plate_number = $2, validated = $3, review_status = $4, " +
          "review_revision = COALESCE(review_revision, 0) + 1, last_reviewed_at = CURRENT_TIMESTAMP, " +
          "last_reviewed_by = $5 WHERE id = $1",
        [
          read.id,
          restoredPlate,
          ["confirmed", "corrected", "alias_resolved"].includes(restoredStatus),
          restoredStatus,
          reviewer.id,
        ]
      );
      const inserted = await client.query(
        "INSERT INTO public.plate_read_reviews " +
          "(read_id, read_event_identity, action, previous_plate, new_plate, previous_status, new_status, " +
          "reason, actor_user_id, actor_username, actor_display_name, reverses_review_id) " +
          "VALUES ($1, $2, 'reverse', $3, $4, $5, $6, $7, $8::bigint, $9, $10, $11) RETURNING id",
        [
          read.id,
          read.event_identity,
          read.plate_number,
          restoredPlate,
          read.review_status,
          restoredStatus,
          reversalReason,
          reviewer.id,
          reviewer.username,
          reviewer.displayName,
          prior.id,
        ]
      );
      await audit(client, {
        actor: reviewer,
        eventType: "plate.review_reversed",
        resourceType: "plate_read",
        resourceId: read.id,
        reason: reversalReason,
        metadata: {
          reversedReviewId: prior.id,
          reversalReviewId: inserted.rows[0].id,
          effectivePlate: restoredPlate,
          reviewStatus: restoredStatus,
        },
      });
      return { effectivePlate: restoredPlate, reviewStatus: restoredStatus };
    });
  }

  async previewBatch({ sourcePlate, cameraName = null, unreviewedOnly = false }) {
    const source = normalizePlateValue(sourcePlate, "Source plate");
    const pool = await this.getPool();
    const result = await pool.query(
      "SELECT COUNT(*)::integer AS read_count, COUNT(DISTINCT camera_name)::integer AS camera_count, " +
        "MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen, " +
        "COUNT(*) FILTER (WHERE COALESCE(review_status, 'unreviewed') <> 'unreviewed')::integer AS already_reviewed " +
        "FROM public.plate_reads WHERE plate_number = $1 " +
        "AND ($2::text IS NULL OR LOWER(camera_name) = LOWER($2)) " +
        "AND ($3::boolean = FALSE OR COALESCE(review_status, 'unreviewed') = 'unreviewed')",
      [source, cameraName || null, Boolean(unreviewedOnly)]
    );
    return { sourcePlate: source, ...result.rows[0] };
  }

  async batchCorrect({ sourcePlate, targetPlate, cameraName = null, unreviewedOnly = false, reason, notes = null, actor }) {
    const source = normalizePlateValue(sourcePlate, "Source plate");
    const target = normalizePlateValue(targetPlate, "Corrected plate");
    if (source === target) throw new PlateReviewError("PLATE_UNCHANGED", "Source and corrected plates must differ.");
    const reviewer = actorSnapshot(actor);
    const correctionReason = requireReason(reason);
    return await this.transaction(async (client) => {
      const selected = await client.query(
        "SELECT id, event_identity, plate_number, COALESCE(review_status, 'unreviewed') AS review_status " +
          "FROM public.plate_reads WHERE plate_number = $1 " +
          "AND ($2::text IS NULL OR LOWER(camera_name) = LOWER($2)) " +
          "AND ($3::boolean = FALSE OR COALESCE(review_status, 'unreviewed') = 'unreviewed') " +
          "ORDER BY id FOR UPDATE",
        [source, cameraName || null, Boolean(unreviewedOnly)]
      );
      if (!selected.rowCount) throw new PlateReviewError("NO_MATCHING_READS", "No matching reads remain to correct.");
      const batch = await client.query(
        "INSERT INTO public.plate_review_batches " +
          "(source_plate, target_plate, criteria, matched_count, actor_user_id, actor_username, actor_display_name, reason, notes) " +
          "VALUES ($1, $2, $3::jsonb, $4, $5::bigint, $6, $7, $8, $9) RETURNING id",
        [
          source,
          target,
          JSON.stringify({ cameraName: cameraName || null, unreviewedOnly: Boolean(unreviewedOnly) }),
          selected.rowCount,
          reviewer.id,
          reviewer.username,
          reviewer.displayName,
          correctionReason,
          normalizedText(notes, 2000),
        ]
      );
      const batchId = batch.rows[0].id;
      await client.query(
        "INSERT INTO public.plates (plate_number) VALUES ($1) ON CONFLICT (plate_number) DO NOTHING",
        [target]
      );
      for (const read of selected.rows) {
        await client.query(
          "UPDATE public.plate_reads SET plate_number = $2, validated = TRUE, review_status = 'corrected', " +
            "review_revision = COALESCE(review_revision, 0) + 1, last_reviewed_at = CURRENT_TIMESTAMP, " +
            "last_reviewed_by = $3 WHERE id = $1",
          [read.id, target, reviewer.id]
        );
        await client.query(
          "INSERT INTO public.plate_read_reviews " +
            "(read_id, read_event_identity, action, previous_plate, new_plate, previous_status, new_status, " +
            "reason, notes, actor_user_id, actor_username, actor_display_name, batch_id) " +
            "VALUES ($1, $2, 'correct', $3, $4, $5, 'corrected', $6, $7, $8::bigint, $9, $10, $11)",
          [
            read.id,
            read.event_identity,
            read.plate_number,
            target,
            read.review_status,
            correctionReason,
            normalizedText(notes, 2000),
            reviewer.id,
            reviewer.username,
            reviewer.displayName,
            batchId,
          ]
        );
      }
      await audit(client, {
        actor: reviewer,
        eventType: "plate.batch_corrected",
        resourceType: "plate_review_batch",
        resourceId: batchId,
        reason: correctionReason,
        metadata: {
          sourcePlate: source,
          targetPlate: target,
          matchedCount: selected.rowCount,
          cameraName: cameraName || null,
          unreviewedOnly: Boolean(unreviewedOnly),
        },
      });
      return { batchId, matchedCount: selected.rowCount };
    });
  }

  async listAliases() {
    const pool = await this.getPool();
    const result = await pool.query(
      "SELECT id, source_plate, target_plate, camera_name, enabled, reason, created_by_user_id, " +
        "created_by_username, created_by_display_name, created_at, disabled_at, use_count, last_used_at " +
        "FROM public.plate_aliases ORDER BY enabled DESC, created_at DESC, id DESC"
    );
    return result.rows;
  }

  async createAlias({ sourcePlate, targetPlate, cameraName = null, reason, actor }) {
    const source = normalizePlateValue(sourcePlate, "Observed plate");
    const target = normalizePlateValue(targetPlate, "Effective plate");
    if (source === target) throw new PlateReviewError("PLATE_UNCHANGED", "Alias source and target must differ.");
    const reviewer = actorSnapshot(actor);
    const aliasReason = requireReason(reason);
    const camera = normalizedText(cameraName, 30);
    return await this.transaction(async (client) => {
      const existing = await client.query(
        "SELECT id FROM public.plate_aliases WHERE enabled = TRUE AND source_plate = $1 " +
          "AND COALESCE(LOWER(camera_name), '') = COALESCE(LOWER($2), '') LIMIT 1",
        [source, camera]
      );
      if (existing.rowCount) {
        throw new PlateReviewError(
          "ALIAS_EXISTS",
          "An enabled alias already exists for this observed plate and camera scope."
        );
      }
      await client.query(
        "INSERT INTO public.plates (plate_number) VALUES ($1) ON CONFLICT (plate_number) DO NOTHING",
        [target]
      );
      const inserted = await client.query(
        "INSERT INTO public.plate_aliases " +
          "(source_plate, target_plate, camera_name, reason, created_by_user_id, created_by_username, created_by_display_name) " +
          "VALUES ($1, $2, $3, $4, $5::bigint, $6, $7) RETURNING *",
        [source, target, camera, aliasReason, reviewer.id, reviewer.username, reviewer.displayName]
      );
      await audit(client, {
        actor: reviewer,
        eventType: "plate.alias_created",
        resourceType: "plate_alias",
        resourceId: inserted.rows[0].id,
        reason: aliasReason,
        metadata: { sourcePlate: source, targetPlate: target, cameraName: camera },
      });
      return inserted.rows[0];
    });
  }

  async disableAlias({ aliasId, actor, reason = "disabled_by_administrator" }) {
    const reviewer = actorSnapshot(actor);
    const disabledReason = requireReason(reason);
    return await this.transaction(async (client) => {
      const updated = await client.query(
        "UPDATE public.plate_aliases SET enabled = FALSE, disabled_at = CURRENT_TIMESTAMP, disabled_by_user_id = $2 " +
          "WHERE id = $1 AND enabled = TRUE RETURNING id, source_plate, target_plate, camera_name",
        [Number(aliasId), reviewer.id]
      );
      if (!updated.rowCount) throw new PlateReviewError("ALIAS_NOT_FOUND", "Enabled alias was not found.");
      await audit(client, {
        actor: reviewer,
        eventType: "plate.alias_disabled",
        resourceType: "plate_alias",
        resourceId: aliasId,
        reason: disabledReason,
        metadata: updated.rows[0],
      });
      return updated.rows[0];
    });
  }
}
