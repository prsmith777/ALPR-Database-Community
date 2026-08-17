import {
  buildVehicleReidV2ConversionProjection,
} from "./vehicle-reid-v2-conversion-preview.mjs";
import {
  VehicleReidV2ConversionRepository,
  vehicleReidV2ConversionRepositoryInternals,
} from "./vehicle-reid-v2-conversion-repository.mjs";
import {
  VEHICLE_ASSET_EMBEDDING_ALGORITHM,
  VEHICLE_ASSET_EMBEDDING_MODEL,
} from "./vehicle-asset-embedding-contract.mjs";
import {
  VEHICLE_IMAGE_CROP_ALGORITHM,
  VEHICLE_IMAGE_CROP_KIND,
} from "./vehicle-image-crop.mjs";
import { createHash } from "node:crypto";

const {
  EMBEDDING_ALGORITHM,
  EMBEDDING_MODEL,
} = vehicleReidV2ConversionRepositoryInternals;

const AUTHORITY_LOCK = "vehicle_reid_v2_authority_stage2";
const TRUSTED_PLATE_STATUSES = Object.freeze(["confirmed", "corrected", "alias_resolved"]);

function positiveId(value, code = "VEHICLE_REID_V2_AUTHORITY_ID") {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    const error = new Error("A positive ReID v2 identifier is required.");
    error.code = code;
    throw error;
  }
  return parsed;
}

function actorSnapshot(actor) {
  return {
    id: positiveId(actor?.id, "VEHICLE_REID_V2_AUTHORITY_ACTOR_REQUIRED"),
    username: String(actor?.username || "administrator").trim().slice(0, 64),
    displayName: String(actor?.displayName || actor?.username || "Administrator")
      .trim().slice(0, 120),
  };
}

function codedError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function normalizedReason(value, fallback) {
  return String(value || fallback).trim().replace(/\s+/g, " ").slice(0, 160);
}

async function audit(client, { actor, eventType, resourceId, outcome = "succeeded", metadata = {} }) {
  await client.query(
    `INSERT INTO public.audit_events (
       actor_user_id, source, event_type, resource_type, resource_id,
       outcome, metadata
     ) VALUES (
       $1::bigint, 'browser', $2, 'vehicle_reid_v2_conversion_run',
       $3, $4, $5::jsonb
     )`,
    [actor?.id || null, eventType, String(resourceId), outcome, JSON.stringify(metadata)]
  );
}

export class VehicleReidV2AuthorityRepository {
  constructor({ pool, executor = null } = {}) {
    if (!pool && !executor) throw new Error("ReID v2 authority repository requires a database executor");
    this.pool = pool;
    this.executor = executor;
  }

  query(text, values = []) {
    return (this.executor || this.pool).query(text, values);
  }

  async transaction(operation, { isolation = "READ COMMITTED", sessionLock = null } = {}) {
    if (!this.pool?.connect) return operation(this.executor || this.pool);
    const client = await this.pool.connect();
    let began = false;
    let locked = false;
    try {
      if (sessionLock) {
        await client.query("SELECT pg_advisory_lock(hashtext($1))", [sessionLock]);
        locked = true;
      }
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      began = true;
      const result = await operation(client);
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) await client.query("ROLLBACK");
      throw error;
    } finally {
      try {
        if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [sessionLock]);
      } finally {
        client.release();
      }
    }
  }

  async liveProjection(client, run) {
    const frozenAssets = await client.query(
      `SELECT ARRAY_AGG(DISTINCT asset_id ORDER BY asset_id) AS asset_ids
       FROM public.vehicle_reid_v2_conversion_crop_evidence WHERE run_id = $1`,
      [Number(run.id)]
    );
    const conversion = new VehicleReidV2ConversionRepository({ executor: client });
    const live = await conversion.captureLiveEvidence(client, {
      maxReadId: Number(run.max_read_id),
      postBoundAssetIds: frozenAssets.rows[0]?.asset_ids || [],
    });
    return buildVehicleReidV2ConversionProjection({
      sourceRows: live.sourceRows,
      reviewRows: live.reviewRows,
      readRows: live.readRows,
      embeddingModel: EMBEDDING_MODEL,
      embeddingAlgorithmVersion: EMBEDDING_ALGORITHM,
    });
  }

  assertProjectionCurrent(run, projection, submittedFingerprint) {
    if (String(submittedFingerprint || "") !== String(run.preview_fingerprint || "")) {
      throw codedError(
        "VEHICLE_REID_V2_AUTHORITY_PREVIEW_FINGERPRINT",
        "The submitted conversion preview fingerprint is stale."
      );
    }
    const current = projection.identityEvidenceFingerprint === run.identity_evidence_fingerprint
      && projection.previewFingerprint === run.preview_fingerprint;
    if (!current) {
      throw codedError(
        "VEHICLE_REID_V2_AUTHORITY_EVIDENCE_STALE",
        "Current ReID v2 evidence no longer matches the frozen preview.",
        {
          expectedIdentityEvidenceFingerprint: run.identity_evidence_fingerprint,
          currentIdentityEvidenceFingerprint: projection.identityEvidenceFingerprint,
          expectedPreviewFingerprint: run.preview_fingerprint,
          currentPreviewFingerprint: projection.previewFingerprint,
        }
      );
    }
  }

  async acceptPreview({ runId, previewFingerprint, actor } = {}) {
    const operator = actorSnapshot(actor);
    const id = positiveId(runId);
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM public.vehicle_reid_v2_conversion_runs
         WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const run = selected.rows?.[0];
      if (!run || run.status !== "ready" || run.phase !== "revalidate") {
        throw codedError(
          "VEHICLE_REID_V2_AUTHORITY_ACCEPT_STATE",
          "Only a ready, verified conversion preview can be accepted."
        );
      }
      let projection;
      try {
        projection = await this.liveProjection(client, run);
        this.assertProjectionCurrent(run, projection, previewFingerprint);
      } catch (error) {
        if (error?.code === "VEHICLE_REID_V2_AUTHORITY_EVIDENCE_STALE") {
          await client.query(
            `UPDATE public.vehicle_reid_v2_conversion_runs
             SET status = 'stale', stale_at = CURRENT_TIMESTAMP,
                 last_error_code = 'FROZEN_EVIDENCE_CHANGED',
                 last_error_details = $2::jsonb,
                 last_revalidation_status = 'stale',
                 last_revalidation_fingerprint = $3,
                 last_revalidation_error_code = 'FROZEN_EVIDENCE_CHANGED',
                 last_revalidated_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id, JSON.stringify(error.details || {}), error.details?.currentIdentityEvidenceFingerprint]
          );
          await audit(client, {
            actor: operator,
            eventType: "vehicle.reid_v2_authority_accept_stale",
            resourceId: id,
            outcome: "failed",
            metadata: { ...(error.details || {}), authoritativeWrites: 0 },
          });
          return { accepted: false, stale: true };
        }
        throw error;
      }

      await client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs
         SET last_revalidation_status = 'current',
             last_revalidation_fingerprint = $2,
             last_revalidation_error_code = NULL,
             last_revalidated_at = CURRENT_TIMESTAMP,
             last_error_details = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, projection.identityEvidenceFingerprint]
      );
      await client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs
         SET status = 'accepted',
             accepted_preview_fingerprint = preview_fingerprint,
             accepted_actor_user_id = $2,
             accepted_actor_username = $3,
             accepted_actor_display_name = $4,
             accepted_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, operator.id, operator.username, operator.displayName]
      );
      await audit(client, {
        actor: operator,
        eventType: "vehicle.reid_v2_authority_preview_accepted",
        resourceId: id,
        metadata: {
          previewFingerprint: run.preview_fingerprint,
          identityEvidenceFingerprint: projection.identityEvidenceFingerprint,
          authoritativeWrites: 0,
        },
      });
      return { accepted: true, stale: false, runId: id };
    }, { isolation: "REPEATABLE READ", sessionLock: AUTHORITY_LOCK });
  }

  async materializeAcceptedPreview({ runId, previewFingerprint, actor } = {}) {
    const operator = actorSnapshot(actor);
    const id = positiveId(runId);
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM public.vehicle_reid_v2_conversion_runs
         WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const run = selected.rows?.[0];
      if (!run || run.status !== "accepted" || run.phase !== "revalidate") {
        throw codedError(
          "VEHICLE_REID_V2_AUTHORITY_MATERIALIZE_STATE",
          "Only an explicitly accepted conversion preview can be materialized."
        );
      }
      let projection;
      try {
        projection = await this.liveProjection(client, run);
        this.assertProjectionCurrent(run, projection, previewFingerprint);
      } catch (error) {
        if (error?.code === "VEHICLE_REID_V2_AUTHORITY_EVIDENCE_STALE") {
          await client.query(
            `UPDATE public.vehicle_reid_v2_conversion_runs
             SET status = 'stale', stale_at = CURRENT_TIMESTAMP,
                 last_error_code = 'FROZEN_EVIDENCE_CHANGED',
                 last_error_details = $2::jsonb,
                 last_revalidation_status = 'stale',
                 last_revalidation_fingerprint = $3,
                 last_revalidation_error_code = 'FROZEN_EVIDENCE_CHANGED',
                 last_revalidated_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id, JSON.stringify(error.details || {}), error.details?.currentIdentityEvidenceFingerprint]
          );
          await audit(client, {
            actor: operator,
            eventType: "vehicle.reid_v2_authority_materialization_stale",
            resourceId: id,
            outcome: "failed",
            metadata: { ...(error.details || {}), authoritativeWrites: 0 },
          });
          return { runId: id, completed: false, stale: true };
        }
        throw error;
      }

      await client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs
         SET status = 'running', phase = 'materialize', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
      );

      const profiles = await client.query(
        `INSERT INTO public.vehicle_reid_v2_profiles (
           status, revision, provenance_basis, representative_derivative_id,
           representative_embedding_id, representative_source_sha256,
           representative_evidence_fingerprint, origin_conversion_run_id,
           origin_projection_key, created_by_user_id, created_by_username,
           created_by_display_name
         )
         SELECT CASE projected.profile_kind
                  WHEN 'provisional_singleton' THEN 'provisional'
                  ELSE 'active'
                END,
                1, projected.evidence_basis,
                projected.representative_derivative_id,
                projected.representative_embedding_id,
                projected.representative_source_sha256,
                projected.projection_fingerprint,
                projected.run_id, projected.projection_key,
                $2, $3, $4
         FROM public.vehicle_reid_v2_conversion_projected_profiles projected
         WHERE projected.run_id = $1
         ORDER BY projected.id
         RETURNING id`,
        [id, operator.id, operator.username, operator.displayName]
      );

      const members = await client.query(
        `INSERT INTO public.vehicle_reid_v2_profile_members (
           profile_id, status, revision, derivative_id, asset_id,
           derivative_kind, crop_algorithm_version, asset_source_sha256,
           crop_content_sha256, embedding_id, embedding_model,
           embedding_algorithm_version, embedding_source_sha256,
           embedding_sha256, membership_basis,
           representative_evidence_read_id, source_revision_fingerprint,
           evidence_fingerprint, origin_conversion_run_id,
           origin_projected_member_fingerprint
         )
         SELECT profiles.id, 'current', 1, projected.derivative_id,
                projected.asset_id, crops.derivative_kind,
                crops.crop_algorithm_version, crops.asset_source_sha256,
                crops.crop_content_sha256, projected.embedding_id,
                crops.embedding_model, crops.embedding_algorithm_version,
                crops.embedding_source_sha256, crops.embedding_sha256,
                projected.evidence_basis, crops.representative_read_id,
                crops.evidence_fingerprint, projected.member_fingerprint,
                projected.run_id, projected.member_fingerprint
         FROM public.vehicle_reid_v2_conversion_projected_members projected
         JOIN public.vehicle_reid_v2_conversion_projected_profiles projected_profiles
           ON projected_profiles.run_id = projected.run_id
          AND projected_profiles.id = projected.projected_profile_id
         JOIN public.vehicle_reid_v2_profiles profiles
           ON profiles.origin_conversion_run_id = projected_profiles.run_id
          AND profiles.origin_projection_key = projected_profiles.projection_key
         JOIN public.vehicle_reid_v2_conversion_crop_evidence crops
           ON crops.run_id = projected.run_id
          AND crops.derivative_id = projected.derivative_id
         WHERE projected.run_id = $1
         ORDER BY projected.projected_profile_id, projected.derivative_id
         RETURNING id`,
        [id]
      );

      const anchors = await client.query(
        `INSERT INTO public.vehicle_reid_v2_profile_plate_anchors (
           profile_id, status, normalized_plate, evidence_read_id,
           plate_review_status, plate_review_revision, plate_review_id,
           applied_alias_id, evidence_fingerprint, origin_conversion_run_id,
           origin_projection_key
         )
         SELECT profiles.id, 'current', plates.normalized_plate,
                evidence.read_id, evidence.plate_review_status,
                evidence.plate_review_revision, evidence.last_plate_review_id,
                evidence.applied_alias_id, evidence.plate_evidence_fingerprint,
                projected.run_id, projected.projection_key
         FROM public.vehicle_reid_v2_conversion_projected_profiles projected
         JOIN public.vehicle_reid_v2_profiles profiles
           ON profiles.origin_conversion_run_id = projected.run_id
          AND profiles.origin_projection_key = projected.projection_key
         CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(projected.anchor_plates)
           plates(normalized_plate)
         JOIN LATERAL (
           SELECT reads.*
           FROM public.vehicle_reid_v2_conversion_read_dispositions dispositions
           JOIN public.vehicle_reid_v2_conversion_read_evidence reads
             ON reads.run_id = dispositions.run_id
            AND reads.read_id = dispositions.read_id
           WHERE dispositions.run_id = projected.run_id
             AND dispositions.projected_profile_id = projected.id
             AND dispositions.disposition = 'assigned'
             AND reads.normalized_effective_plate = plates.normalized_plate
             AND reads.plate_review_status = ANY($2::varchar[])
           ORDER BY reads.read_id
           LIMIT 1
         ) evidence ON TRUE
         WHERE projected.run_id = $1
         ORDER BY projected.id, plates.normalized_plate
         RETURNING id`,
        [id, TRUSTED_PLATE_STATUSES]
      );

      const assignments = await client.query(
        `INSERT INTO public.vehicle_reid_v2_read_assignments (
           read_id, profile_id, status, revision, assignment_basis,
           profile_membership_basis, profile_revision, profile_member_id,
           asset_id, derivative_id, embedding_id, normalized_effective_plate,
           plate_review_status, plate_review_revision, plate_review_id,
           applied_alias_id, source_kind, source_relationship,
           source_path_snapshot, source_updated_at, source_link_updated_at,
           evidence_fingerprint, origin_conversion_run_id,
           origin_disposition_fingerprint
         )
         SELECT dispositions.read_id, profiles.id, 'active', 1,
                dispositions.assignment_basis,
                dispositions.profile_evidence_basis, profiles.revision,
                CASE WHEN dispositions.assignment_basis = 'exact_effective_plate'
                     THEN NULL ELSE members.id END,
                dispositions.asset_id, dispositions.derivative_id,
                dispositions.embedding_id,
                dispositions.normalized_effective_plate,
                reads.plate_review_status, reads.plate_review_revision,
                reads.last_plate_review_id, reads.applied_alias_id,
                reads.source_kind, reads.relationship,
                reads.source_path_snapshot, reads.source_updated_at,
                reads.link_updated_at, dispositions.disposition_fingerprint,
                dispositions.run_id, dispositions.disposition_fingerprint
         FROM public.vehicle_reid_v2_conversion_read_dispositions dispositions
         JOIN public.vehicle_reid_v2_conversion_projected_profiles projected
           ON projected.run_id = dispositions.run_id
          AND projected.id = dispositions.projected_profile_id
         JOIN public.vehicle_reid_v2_profiles profiles
           ON profiles.origin_conversion_run_id = projected.run_id
          AND profiles.origin_projection_key = projected.projection_key
         JOIN public.vehicle_reid_v2_conversion_read_evidence reads
           ON reads.run_id = dispositions.run_id
          AND reads.read_id = dispositions.read_id
         LEFT JOIN public.vehicle_reid_v2_profile_members members
           ON members.origin_conversion_run_id = dispositions.run_id
          AND members.profile_id = profiles.id
          AND members.derivative_id = dispositions.derivative_id
          AND members.status = 'current'
         WHERE dispositions.run_id = $1
           AND dispositions.disposition = 'assigned'
         ORDER BY dispositions.read_id
         RETURNING id`,
        [id]
      );

      await client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs
         SET status = 'completed', phase = 'complete',
             completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
      );
      await audit(client, {
        actor: operator,
        eventType: "vehicle.reid_v2_authority_materialized",
        resourceId: id,
        metadata: {
          previewFingerprint: run.preview_fingerprint,
          profiles: profiles.rowCount,
          members: members.rowCount,
          plateAnchors: anchors.rowCount,
          assignments: assignments.rowCount,
          modeChanged: false,
        },
      });
      return {
        runId: id,
        completed: true,
        profiles: profiles.rowCount,
        members: members.rowCount,
        plateAnchors: anchors.rowCount,
        assignments: assignments.rowCount,
      };
    }, { isolation: "REPEATABLE READ", sessionLock: AUTHORITY_LOCK });
  }

  async transitionMode({ mode, runId, actor, reason } = {}) {
    const operator = actorSnapshot(actor);
    const requested = String(mode || "");
    if (!["v2_primary", "v1_rollback"].includes(requested)) {
      throw codedError("VEHICLE_REID_V2_AUTHORITY_MODE", "Unsupported ReID authority mode transition.");
    }
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM public.vehicle_reid_control WHERE singleton = TRUE FOR UPDATE`
      );
      const control = selected.rows?.[0];
      if (!control) throw codedError("VEHICLE_REID_V2_AUTHORITY_CONTROL", "ReID authority control is unavailable.");
      const transitionRunId = requested === "v2_primary"
        ? positiveId(runId)
        : positiveId(control.transition_run_id);
      const result = await client.query(
        `UPDATE public.vehicle_reid_control
         SET mode = $1, previous_mode = mode, revision = revision + 1,
             transition_run_id = $2, transition_actor_user_id = $3,
             transition_actor_username = $4,
             transition_actor_display_name = $5,
             transition_reason = $6, transitioned_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE singleton = TRUE
         RETURNING *`,
        [
          requested,
          transitionRunId,
          operator.id,
          operator.username,
          operator.displayName,
          normalizedReason(reason, requested === "v2_primary"
            ? "Explicit Stage 2 authoritative ReID v2 cutover."
            : "Explicit Stage 2 rollback to ReID v1 consumers."),
        ]
      );
      await audit(client, {
        actor: operator,
        eventType: requested === "v2_primary"
          ? "vehicle.reid_v2_authority_cutover"
          : "vehicle.reid_v2_authority_rollback",
        resourceId: transitionRunId,
        metadata: {
          priorMode: control.mode,
          mode: requested,
          revision: Number(result.rows[0].revision),
        },
      });
      return result.rows[0];
    }, { sessionLock: AUTHORITY_LOCK });
  }

  async mergeProfilesByReview({ reviewId, actor } = {}) {
    const operator = actorSnapshot(actor);
    const id = positiveId(reviewId, "VEHICLE_REID_V2_AUTHORITY_REVIEW_ID");
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [AUTHORITY_LOCK]);
      const currentReview = await client.query(
        `SELECT reviews.id, reviews.revision, reviews.label
         FROM public.vehicle_reid_control control
         JOIN public.vehicle_reid_v2_pair_reviews reviews ON reviews.id = $1
         WHERE control.singleton = TRUE AND control.mode = 'v2_primary'
         FOR SHARE OF reviews`,
        [id]
      );
      const reviewContract = currentReview.rows?.[0];
      if (!reviewContract) {
        return { merged: false, split: false, reason: "v2_not_primary_or_review_missing" };
      }

      if (reviewContract.label !== "same_vehicle") {
        const withdrawn = await client.query(
          `UPDATE public.vehicle_reid_v2_profile_merges merges
           SET status = 'withdrawn', ended_by_user_id = $2,
               ended_by_username = $3, ended_by_display_name = $4,
               end_reason = $5, ended_at = CURRENT_TIMESTAMP
           WHERE merges.pair_review_id = $1 AND merges.status = 'current'
           RETURNING merges.source_profile_id, merges.target_profile_id`,
          [
            id,
            operator.id,
            operator.username,
            operator.displayName,
            `pair_review_${reviewContract.label}`,
          ]
        );
        if (!withdrawn.rowCount) {
          return { merged: false, split: false, reason: "no_current_merge_for_review" };
        }
        const row = withdrawn.rows[0];
        await client.query(
          `INSERT INTO public.audit_events (
             actor_user_id, source, event_type, resource_type, resource_id,
             outcome, metadata
           ) VALUES ($1, 'browser', 'vehicle.reid_v2_profiles_split',
             'vehicle_reid_v2_profile', $2, 'succeeded', $3::jsonb)`,
          [
            operator.id,
            String(row.target_profile_id),
            JSON.stringify({
              sourceProfileId: Number(row.source_profile_id),
              targetProfileId: Number(row.target_profile_id),
              reviewId: id,
              reviewRevision: Number(reviewContract.revision),
              label: reviewContract.label,
            }),
          ]
        );
        return {
          merged: false,
          split: true,
          sourceProfileId: Number(row.source_profile_id),
          targetProfileId: Number(row.target_profile_id),
          reviewId: id,
        };
      }

      const result = await client.query(
        `SELECT reviews.id, reviews.revision, reviews.label,
                COALESCE(low_merge.target_profile_id, low_member.profile_id)
                  AS low_profile_id,
                COALESCE(high_merge.target_profile_id, high_member.profile_id)
                  AS high_profile_id,
                reviews.source_sha256_low, reviews.source_sha256_high,
                reviews.embedding_id_low, reviews.embedding_id_high,
                EXISTS (
                  SELECT 1 FROM public.vehicle_reid_v2_current_profile_merges target_merges
                  WHERE target_merges.target_profile_id =
                    COALESCE(low_merge.target_profile_id, low_member.profile_id)
                ) AS low_is_merge_target,
                EXISTS (
                  SELECT 1 FROM public.vehicle_reid_v2_current_profile_merges target_merges
                  WHERE target_merges.target_profile_id =
                    COALESCE(high_merge.target_profile_id, high_member.profile_id)
                ) AS high_is_merge_target
         FROM public.vehicle_reid_control control
         JOIN public.vehicle_reid_v2_pair_reviews reviews ON reviews.id = $1
         JOIN public.vehicle_reid_v2_exact_profile_members low_member
           ON low_member.derivative_id = reviews.derivative_id_low
         JOIN public.vehicle_reid_v2_exact_profile_members high_member
           ON high_member.derivative_id = reviews.derivative_id_high
         LEFT JOIN public.vehicle_reid_v2_current_profile_merges low_merge
           ON low_merge.source_profile_id = low_member.profile_id
         LEFT JOIN public.vehicle_reid_v2_current_profile_merges high_merge
           ON high_merge.source_profile_id = high_member.profile_id
         WHERE control.singleton = TRUE AND control.mode = 'v2_primary'
           AND reviews.label = 'same_vehicle'
           AND reviews.source_sha256_low = low_member.crop_content_sha256
           AND reviews.source_sha256_high = high_member.crop_content_sha256
           AND reviews.embedding_id_low = low_member.embedding_id
           AND reviews.embedding_id_high = high_member.embedding_id
           AND reviews.embedding_model = low_member.embedding_model
           AND reviews.embedding_model = high_member.embedding_model
           AND reviews.algorithm_version = low_member.embedding_algorithm_version
           AND reviews.algorithm_version = high_member.embedding_algorithm_version
         FOR SHARE OF reviews`,
        [id]
      );
      const review = result.rows?.[0];
      if (!review) {
        return { merged: false, reason: "not_two_current_authoritative_profiles" };
      }
      const lowProfileId = Number(review.low_profile_id);
      const highProfileId = Number(review.high_profile_id);
      if (lowProfileId === highProfileId) {
        return { merged: false, reason: "already_same_profile", profileId: lowProfileId };
      }
      if (review.low_is_merge_target && review.high_is_merge_target) {
        return { merged: false, reason: "distinct_merge_groups_require_operator_resolution" };
      }
      const sourceProfileId = review.low_is_merge_target
        ? highProfileId
        : review.high_is_merge_target
          ? lowProfileId
          : Math.max(lowProfileId, highProfileId);
      const targetProfileId = review.low_is_merge_target
        ? lowProfileId
        : review.high_is_merge_target
          ? highProfileId
          : Math.min(lowProfileId, highProfileId);
      const fingerprint = createHash("sha256").update(JSON.stringify({
        algorithm: "vehicle-reid-v2-profile-merge-v1",
        reviewId: id,
        reviewRevision: Number(review.revision),
        sourceProfileId,
        targetProfileId,
        sourceSha256Low: review.source_sha256_low,
        sourceSha256High: review.source_sha256_high,
        embeddingIdLow: Number(review.embedding_id_low),
        embeddingIdHigh: Number(review.embedding_id_high),
      })).digest("hex");
      await client.query(
        `UPDATE public.vehicle_reid_v2_profile_merges merges
         SET status = 'withdrawn', ended_by_user_id = $2,
             ended_by_username = $3, ended_by_display_name = $4,
             end_reason = 'superseded_review_contract',
             ended_at = CURRENT_TIMESTAMP
         WHERE merges.source_profile_id = $1 AND merges.status = 'current'
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_reid_v2_current_profile_merges current_merges
             WHERE current_merges.id = merges.id
           )`,
        [sourceProfileId, operator.id, operator.username, operator.displayName]
      );
      const inserted = await client.query(
        `INSERT INTO public.vehicle_reid_v2_profile_merges (
           source_profile_id, target_profile_id, pair_review_id,
           pair_review_revision, evidence_fingerprint, actor_user_id,
           actor_username, actor_display_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, source_profile_id`,
        [
          sourceProfileId, targetProfileId, id, Number(review.revision), fingerprint,
          operator.id, operator.username, operator.displayName,
        ]
      );
      await client.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id,
           outcome, metadata
         ) VALUES ($1, 'browser', 'vehicle.reid_v2_profiles_merged',
           'vehicle_reid_v2_profile', $2, 'succeeded', $3::jsonb)`,
        [
          operator.id,
          String(targetProfileId),
          JSON.stringify({ sourceProfileId, targetProfileId, reviewId: id, fingerprint }),
        ]
      );
      return {
        merged: true,
        split: false,
        mergeId: Number(inserted.rows[0].id),
        sourceProfileId,
        targetProfileId,
        reviewId: id,
      };
    });
  }

  async getControl() {
    const result = await this.query(
      `SELECT * FROM public.vehicle_reid_control WHERE singleton = TRUE`
    );
    return result.rows?.[0] || null;
  }

  async getOverview() {
    const [control, counts, liveJobs, transitionRun] = await Promise.all([
      this.getControl(),
      this.query(
         `WITH member_counts AS (
           SELECT members.canonical_profile_id AS id,
                  COUNT(members.id)::integer AS member_count
           FROM public.vehicle_reid_v2_current_profile_members members
           GROUP BY members.canonical_profile_id
         ), anchor_counts AS (
           SELECT anchors.canonical_profile_id AS id,
                  COUNT(anchors.id)::integer AS anchor_count
           FROM public.vehicle_reid_v2_current_plate_anchors anchors
           GROUP BY anchors.canonical_profile_id
         ), valid_assignments AS (
           SELECT assignments.*
           FROM public.vehicle_reid_v2_current_read_assignments assignments
         )
         SELECT
           (SELECT COUNT(*) FROM member_counts)::integer AS profiles,
           (SELECT COUNT(*)
            FROM member_counts
            JOIN public.vehicle_reid_v2_profiles profiles
              ON profiles.id = member_counts.id
            LEFT JOIN anchor_counts ON anchor_counts.id = member_counts.id
            WHERE profiles.status = 'provisional'
              AND member_counts.member_count = 1
              AND COALESCE(anchor_counts.anchor_count, 0) = 0)::integer
             AS provisional_profiles,
           (SELECT COUNT(*) FROM member_counts WHERE member_count > 1)::integer
             AS multi_member_profiles,
           (SELECT COUNT(*) FROM member_counts WHERE member_count = 1)::integer
             AS singleton_profiles,
           (SELECT COUNT(*) FROM public.vehicle_reid_v2_current_profile_members)::integer
             AS members,
           (SELECT COUNT(*) FROM public.vehicle_reid_v2_current_plate_anchors)::integer
             AS plate_anchors,
           (SELECT COUNT(*) FROM valid_assignments)::integer AS assignments,
           ((SELECT COUNT(*) FROM public.plate_reads)
             - (SELECT COUNT(*) FROM valid_assignments))::integer AS unassigned_reads,
           (SELECT COUNT(*) FROM valid_assignments
             WHERE assignment_basis = 'exact_effective_plate')::integer
             AS exact_plate_assignments,
           (SELECT COUNT(*) FROM valid_assignments
             WHERE assignment_basis = 'shared_asset')::integer AS shared_asset_assignments,
           (SELECT COUNT(*) FROM valid_assignments
             WHERE assignment_basis IN ('canonical_image','human_same'))::integer
             AS canonical_image_assignments,
           ((SELECT COUNT(*) FROM public.vehicle_reid_v2_read_assignments
             WHERE status = 'active') - (SELECT COUNT(*) FROM valid_assignments))::integer
             AS stale_assignments`
      ),
      this.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
                COUNT(*) FILTER (WHERE status = 'processing')::integer AS processing,
                COUNT(*) FILTER (WHERE status = 'ready')::integer AS ready,
                COUNT(*) FILTER (WHERE status = 'conflict')::integer AS conflict,
                COUNT(*) FILTER (WHERE status = 'unavailable')::integer AS unavailable,
                COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed
         FROM public.vehicle_reid_v2_live_jobs`
      ),
      this.query(
        `SELECT runs.id, runs.status, runs.preview_metrics
         FROM public.vehicle_reid_control control
         LEFT JOIN public.vehicle_reid_v2_conversion_runs runs
           ON runs.id = control.transition_run_id
         WHERE control.singleton = TRUE`
      ),
    ]);
    return {
      control,
      counts: counts.rows?.[0] || {},
      liveJobs: liveJobs.rows?.[0] || {},
      transitionRun: transitionRun.rows?.[0] || null,
    };
  }

  async listProfiles({ page = 1, pageSize = 24, search = "" } = {}) {
    const size = Math.min(100, Math.max(1, Number(pageSize) || 24));
    const offset = (Math.max(1, Number(page) || 1) - 1) * size;
    const term = String(search || "").trim().slice(0, 80);
    const result = await this.query(
      `SELECT profiles.id,
              CASE WHEN profiles.status = 'provisional'
                       AND (COUNT(DISTINCT members.id) > 1
                         OR COUNT(DISTINCT anchors.id) > 0)
                   THEN 'active' ELSE profiles.status END AS status,
              profiles.revision,
              profiles.provenance_basis, profiles.representative_derivative_id,
              representative.storage_path AS representative_storage_path,
              profiles.created_at::text, profiles.updated_at::text,
              COUNT(DISTINCT members.id)::integer AS member_count,
              COUNT(DISTINCT assignments.read_id)::integer AS read_count,
              COALESCE(JSONB_AGG(DISTINCT anchors.normalized_plate)
                FILTER (WHERE anchors.normalized_plate IS NOT NULL), '[]'::jsonb)
                AS anchor_plates,
              COUNT(*) OVER()::integer AS total_count
       FROM public.vehicle_reid_v2_profiles profiles
       JOIN LATERAL (
         SELECT derivatives.storage_path
         FROM public.vehicle_reid_v2_current_profile_members current_members
         JOIN public.vehicle_image_derivatives derivatives
           ON derivatives.id = current_members.derivative_id
         WHERE current_members.canonical_profile_id = profiles.id
         ORDER BY (current_members.derivative_id = profiles.representative_derivative_id) DESC,
                  current_members.id
         LIMIT 1
       ) representative ON TRUE
       LEFT JOIN public.vehicle_reid_v2_current_profile_members members
         ON members.canonical_profile_id = profiles.id
       LEFT JOIN public.vehicle_reid_v2_current_read_assignments assignments
         ON assignments.canonical_profile_id = profiles.id
       LEFT JOIN public.vehicle_reid_v2_current_plate_anchors anchors
         ON anchors.canonical_profile_id = profiles.id
       WHERE profiles.status IN ('active','provisional')
         AND NOT EXISTS (
           SELECT 1 FROM public.vehicle_reid_v2_current_profile_merges hidden_merges
           WHERE hidden_merges.source_profile_id = profiles.id
         )
         AND ($1 = '' OR profiles.id::text = $1
           OR EXISTS (
             SELECT 1 FROM public.vehicle_reid_v2_current_plate_anchors search_anchors
             WHERE search_anchors.canonical_profile_id = profiles.id
               AND search_anchors.normalized_plate ILIKE '%' || $1 || '%'
           ))
       GROUP BY profiles.id, representative.storage_path
       ORDER BY profiles.updated_at DESC, profiles.id DESC
       LIMIT $2 OFFSET $3`,
      [term, size, offset]
    );
    return {
      rows: result.rows || [],
      total: Number(result.rows?.[0]?.total_count || 0),
      page: Math.max(1, Number(page) || 1),
      pageSize: size,
    };
  }

  async getProfile(profileId) {
    const requestedId = positiveId(profileId);
    const canonical = await this.query(
      `SELECT COALESCE(merges.target_profile_id, profiles.id) AS id
       FROM public.vehicle_reid_v2_profiles profiles
       LEFT JOIN public.vehicle_reid_v2_current_profile_merges merges
         ON merges.source_profile_id = profiles.id
       WHERE profiles.id = $1`,
      [requestedId]
    );
    const id = Number(canonical.rows?.[0]?.id || requestedId);
    const [profile, members, reads] = await Promise.all([
      this.query(
        `SELECT profiles.*,
                CASE WHEN profiles.status = 'provisional'
                           AND (
                             (SELECT COUNT(*)
                              FROM public.vehicle_reid_v2_current_profile_members members
                              WHERE members.canonical_profile_id = profiles.id) > 1
                             OR EXISTS (
                               SELECT 1
                               FROM public.vehicle_reid_v2_current_plate_anchors current_anchors
                               WHERE current_anchors.canonical_profile_id = profiles.id
                             )
                           )
                     THEN 'active' ELSE profiles.status END AS effective_status,
                COALESCE(JSONB_AGG(DISTINCT anchors.normalized_plate)
                  FILTER (WHERE anchors.normalized_plate IS NOT NULL), '[]'::jsonb)
                  AS anchor_plates
         FROM public.vehicle_reid_v2_profiles profiles
         LEFT JOIN public.vehicle_reid_v2_current_plate_anchors anchors
           ON anchors.canonical_profile_id = profiles.id
         WHERE profiles.id = $1 GROUP BY profiles.id`,
        [id]
      ),
      this.query(
        `SELECT members.*, derivatives.storage_path,
                crops.effective_plates, crops.overview_contexts
         FROM public.vehicle_reid_v2_current_profile_members members
         JOIN public.vehicle_image_derivatives derivatives
           ON derivatives.id = members.derivative_id
         LEFT JOIN public.vehicle_reid_v2_conversion_crop_evidence crops
           ON crops.run_id = members.origin_conversion_run_id
          AND crops.derivative_id = members.derivative_id
         WHERE members.canonical_profile_id = $1
         ORDER BY members.created_at, members.id`,
        [id]
      ),
      this.query(
        `SELECT assignments.*, reads.timestamp::text AS read_timestamp,
                reads.camera_name, reads.plate_number, reads.image_path,
                reads.thumbnail_path, known.name AS known_name, known.notes,
                COALESCE(JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
                  'name', tags.name, 'color', tags.color
                )) FILTER (WHERE tags.name IS NOT NULL), '[]'::jsonb) AS tags
         FROM public.vehicle_reid_v2_current_read_assignments assignments
         JOIN public.plate_reads reads ON reads.id = assignments.read_id
         LEFT JOIN public.known_plates known ON known.plate_number = reads.plate_number
         LEFT JOIN public.plate_tags plate_tags ON plate_tags.plate_number = reads.plate_number
         LEFT JOIN public.tags tags ON tags.id = plate_tags.tag_id
         WHERE assignments.canonical_profile_id = $1
         GROUP BY assignments.id, reads.id, known.name, known.notes
         ORDER BY reads.timestamp DESC, reads.id DESC LIMIT 250`,
        [id]
      ),
    ]);
    return {
      profile: profile.rows?.[0] || null,
      members: members.rows || [],
      reads: reads.rows || [],
    };
  }

  async resolveRead(readId) {
    const id = positiveId(readId);
    const result = await this.query(
      `SELECT reads.id AS read_id,
              assignments.canonical_profile_id AS profile_id,
              assignments.assignment_basis, derivatives.id AS derivative_id,
              embeddings.id AS embedding_id, derivatives.storage_path,
              CASE WHEN links.asset_id IS NOT NULL THEN TRUE ELSE FALSE END
                AS current_identity_link
       FROM public.plate_reads reads
       LEFT JOIN public.vehicle_image_asset_reads links
         ON links.read_id = reads.id
        AND links.identity_eligible = TRUE
        AND links.relationship <> 'display_fallback'
        AND reads.vehicle_image_status = 'ready'
        AND reads.vehicle_image_path = links.source_path_snapshot
        AND reads.vehicle_image_source_kind = links.source_kind
        AND reads.vehicle_image_updated_at IS NOT DISTINCT FROM links.source_updated_at
       LEFT JOIN public.vehicle_image_derivatives derivatives
         ON derivatives.asset_id = links.asset_id
        AND derivatives.derivative_kind = $2
        AND derivatives.algorithm_version = $3
       LEFT JOIN public.vehicle_asset_embeddings embeddings
         ON embeddings.derivative_id = derivatives.id
        AND embeddings.model_name = $4
        AND embeddings.algorithm_version = $5
        AND embeddings.source_sha256 = derivatives.content_sha256
       LEFT JOIN LATERAL (
         SELECT candidate.*
         FROM public.vehicle_reid_v2_current_read_assignments candidate
         WHERE candidate.read_id = reads.id
         LIMIT 1
       ) assignments ON TRUE
       WHERE reads.id = $1 LIMIT 1`,
      [
        id,
        VEHICLE_IMAGE_CROP_KIND,
        VEHICLE_IMAGE_CROP_ALGORITHM,
        VEHICLE_ASSET_EMBEDDING_MODEL,
        VEHICLE_ASSET_EMBEDDING_ALGORITHM,
      ]
    );
    return result.rows?.[0] || null;
  }
}

export const vehicleReidV2AuthorityRepositoryInternals = Object.freeze({
  AUTHORITY_LOCK,
  TRUSTED_PLATE_STATUSES,
  actorSnapshot,
  codedError,
  normalizedReason,
  positiveId,
});
