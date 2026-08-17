import { createHash, randomUUID } from "node:crypto";

import {
  VEHICLE_ASSET_EMBEDDING_ALGORITHM,
  VEHICLE_ASSET_EMBEDDING_MODEL,
} from "./vehicle-asset-embedding-contract.mjs";
import {
  VEHICLE_IMAGE_CROP_ALGORITHM,
  VEHICLE_IMAGE_CROP_KIND,
} from "./vehicle-image-crop.mjs";

// Materialization, reviewed profile merges/splits, and live writes share one
// authority lock so an identity decision cannot race a control or alias change.
const LIVE_AUTHORITY_LOCK = "vehicle_reid_v2_authority_stage2";
const TRUSTED_PLATE_STATUSES = Object.freeze(["confirmed", "corrected", "alias_resolved"]);
const MAX_BATCH_SIZE = 25;

function boundedLimit(value, fallback = 5) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Math.min(MAX_BATCH_SIZE, Math.max(1, parsed || fallback));
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stableFingerprint(kind, values) {
  return sha256(JSON.stringify({ kind, version: 1, values }));
}

function normalizedPlate(value) {
  return String(value || "").trim().toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

function safeError(error) {
  return {
    code: String(error?.code || "VEHICLE_REID_V2_LIVE_FAILED").trim().slice(0, 80),
    message: String(error?.message || error || "Live ReID processing failed").trim().slice(0, 500),
  };
}

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function isTrustedPlate(row) {
  return TRUSTED_PLATE_STATUSES.includes(String(row?.review_status || ""))
    && Boolean(normalizedPlate(row?.plate_number));
}

function currentLinkSql(links = "links", reads = "reads") {
  return `${links}.identity_eligible = TRUE
    AND ${links}.relationship <> 'display_fallback'
    AND ${reads}.vehicle_image_status = 'ready'
    AND ${reads}.vehicle_image_path = ${links}.source_path_snapshot
    AND ${reads}.vehicle_image_source_kind = ${links}.source_kind
    AND ${reads}.vehicle_image_updated_at IS NOT DISTINCT FROM ${links}.source_updated_at`;
}

async function writeAudit(client, { eventType, readId, outcome = "succeeded", metadata = {} }) {
  await client.query(
    `INSERT INTO public.audit_events (
       actor_user_id, source, event_type, resource_type, resource_id,
       outcome, metadata
     ) VALUES (
       NULL, 'system', $1, 'plate_read', $2, $3, $4::jsonb
     )`,
    [eventType, String(readId), outcome, JSON.stringify(metadata)]
  );
}

export class VehicleReidV2LiveRepository {
  constructor({ pool } = {}) {
    if (!pool?.connect || typeof pool.query !== "function") {
      throw new TypeError("VehicleReidV2LiveRepository requires a PostgreSQL pool.");
    }
    this.pool = pool;
  }

  async transaction(operation) {
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query("BEGIN");
      began = true;
      const result = await operation(client);
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async discover({ limit = 25 } = {}) {
    const bounded = boundedLimit(limit, 25);
    const result = await this.pool.query(
      `WITH control AS (
         SELECT mode FROM public.vehicle_reid_control WHERE singleton = TRUE
       ), candidates AS (
         SELECT reads.id
         FROM public.plate_reads reads
         CROSS JOIN control
         WHERE control.mode = 'v2_primary'
           AND (
             NOT EXISTS (
               SELECT 1 FROM public.vehicle_reid_v2_current_read_assignments assignments
               WHERE assignments.read_id = reads.id
             )
             OR (
               reads.review_status = ANY($6::varchar[])
               AND EXISTS (
                 SELECT 1
                 FROM public.vehicle_reid_v2_current_read_assignments assignments
                 WHERE assignments.read_id = reads.id
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM public.vehicle_reid_v2_current_read_assignments assignments
                 JOIN public.vehicle_reid_v2_current_plate_anchors anchors
                   ON anchors.canonical_profile_id = assignments.canonical_profile_id
                  AND anchors.normalized_plate = UPPER(
                    REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g')
                  )
                 WHERE assignments.read_id = reads.id
               )
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_reid_v2_live_jobs jobs
             WHERE jobs.read_id = reads.id
               AND (
                 jobs.status IN ('pending','processing','conflict','unavailable')
                 OR (jobs.status = 'failed' AND (
                   jobs.retryable = FALSE
                   OR jobs.attempt_count >= 3
                   OR COALESCE(jobs.next_attempt_at, CURRENT_TIMESTAMP) > CURRENT_TIMESTAMP
                 ))
               )
           )
           AND (
             EXISTS (
               SELECT 1
               FROM public.vehicle_image_asset_reads links
               JOIN public.vehicle_image_derivatives derivatives
                 ON derivatives.asset_id = links.asset_id
                AND derivatives.derivative_kind = $2
                AND derivatives.algorithm_version = $3
               JOIN public.vehicle_asset_embeddings embeddings
                 ON embeddings.derivative_id = derivatives.id
                AND embeddings.model_name = $4
                AND embeddings.algorithm_version = $5
                AND embeddings.source_sha256 = derivatives.content_sha256
               WHERE links.read_id = reads.id
                 AND ${currentLinkSql()}
             )
             OR (
               reads.review_status = ANY($6::varchar[])
               AND (
                 EXISTS (
                   SELECT 1 FROM public.vehicle_reid_v2_current_plate_anchors anchors
                   WHERE anchors.normalized_plate = UPPER(
                       REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g')
                     )
                 )
                 OR EXISTS (
                   SELECT 1
                   FROM public.vehicle_reid_v2_read_assignments historical
                   WHERE historical.read_id = reads.id
                     AND historical.status = 'active'
                     AND historical.assignment_basis = 'exact_effective_plate'
                     AND historical.normalized_effective_plate = UPPER(
                       REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g')
                     )
                 )
               )
             )
           )
         ORDER BY reads.id
         LIMIT $1
       )
       INSERT INTO public.vehicle_reid_v2_live_jobs (read_id)
       SELECT id FROM candidates
       ON CONFLICT (read_id) DO UPDATE
         SET status = CASE
               WHEN public.vehicle_reid_v2_live_jobs.status = 'ready'
                 OR (public.vehicle_reid_v2_live_jobs.status = 'failed'
                   AND public.vehicle_reid_v2_live_jobs.retryable = TRUE)
                 THEN 'pending'
               ELSE public.vehicle_reid_v2_live_jobs.status
             END,
             next_attempt_at = CASE
               WHEN public.vehicle_reid_v2_live_jobs.status = 'ready'
                 OR (public.vehicle_reid_v2_live_jobs.status = 'failed'
                   AND public.vehicle_reid_v2_live_jobs.retryable = TRUE)
                 THEN NULL
               ELSE public.vehicle_reid_v2_live_jobs.next_attempt_at
             END,
             profile_id = CASE
               WHEN public.vehicle_reid_v2_live_jobs.status = 'ready' THEN NULL
               ELSE public.vehicle_reid_v2_live_jobs.profile_id END,
             assignment_id = CASE
               WHEN public.vehicle_reid_v2_live_jobs.status = 'ready' THEN NULL
               ELSE public.vehicle_reid_v2_live_jobs.assignment_id END,
             result_basis = CASE
               WHEN public.vehicle_reid_v2_live_jobs.status = 'ready' THEN NULL
               ELSE public.vehicle_reid_v2_live_jobs.result_basis END,
             attempt_count = CASE
               WHEN public.vehicle_reid_v2_live_jobs.status = 'ready' THEN 0
               ELSE public.vehicle_reid_v2_live_jobs.attempt_count END,
             operator_retry_count = CASE
               WHEN public.vehicle_reid_v2_live_jobs.status = 'ready' THEN 0
               ELSE public.vehicle_reid_v2_live_jobs.operator_retry_count END,
             retryable = CASE
               WHEN public.vehicle_reid_v2_live_jobs.status = 'ready' THEN TRUE
               ELSE public.vehicle_reid_v2_live_jobs.retryable END,
             completed_at = CASE
               WHEN public.vehicle_reid_v2_live_jobs.status = 'ready' THEN NULL
               ELSE public.vehicle_reid_v2_live_jobs.completed_at END,
             updated_at = CURRENT_TIMESTAMP
       WHERE public.vehicle_reid_v2_live_jobs.status = 'ready'
          OR (public.vehicle_reid_v2_live_jobs.status = 'failed'
            AND public.vehicle_reid_v2_live_jobs.retryable = TRUE
            AND public.vehicle_reid_v2_live_jobs.attempt_count < 3
            AND COALESCE(public.vehicle_reid_v2_live_jobs.next_attempt_at,
              CURRENT_TIMESTAMP) <= CURRENT_TIMESTAMP)
       RETURNING read_id`,
      [
        bounded,
        VEHICLE_IMAGE_CROP_KIND,
        VEHICLE_IMAGE_CROP_ALGORITHM,
        VEHICLE_ASSET_EMBEDDING_MODEL,
        VEHICLE_ASSET_EMBEDDING_ALGORITHM,
        TRUSTED_PLATE_STATUSES,
      ]
    );
    return result.rows.map((row) => Number(row.read_id));
  }

  async claim({ limit = 5 } = {}) {
    const bounded = boundedLimit(limit);
    const token = randomUUID();
    return this.transaction(async (client) => {
      const mode = await client.query(
        `SELECT mode FROM public.vehicle_reid_control WHERE singleton = TRUE`
      );
      if (mode.rows?.[0]?.mode !== "v2_primary") return { token, readIds: [] };
      const result = await client.query(
        `WITH candidates AS (
           SELECT jobs.read_id
           FROM public.vehicle_reid_v2_live_jobs jobs
           WHERE (
             jobs.status = 'pending'
             OR (jobs.status = 'failed' AND jobs.retryable = TRUE
               AND COALESCE(jobs.next_attempt_at, CURRENT_TIMESTAMP) <= CURRENT_TIMESTAMP)
             OR (jobs.status = 'processing'
               AND jobs.processing_deadline_at < CURRENT_TIMESTAMP)
           )
             AND jobs.attempt_count < 3
           ORDER BY jobs.read_id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE public.vehicle_reid_v2_live_jobs jobs
         SET status = 'processing', attempt_count = jobs.attempt_count + 1,
             retryable = FALSE, claim_token = $2::uuid,
             processing_deadline_at = CURRENT_TIMESTAMP + INTERVAL '2 minutes',
             next_attempt_at = NULL, error_code = NULL, error_details = NULL,
             updated_at = CURRENT_TIMESTAMP
         FROM candidates
         WHERE jobs.read_id = candidates.read_id
         RETURNING jobs.read_id`,
        [bounded, token]
      );
      return { token, readIds: result.rows.map((row) => Number(row.read_id)) };
    });
  }

  async loadReadEvidence(client, readId) {
    const result = await client.query(
      `SELECT reads.id AS read_id, reads.plate_number, reads.review_status,
              reads.review_revision, reads.applied_alias_id,
              (SELECT reviews.id FROM public.plate_read_reviews reviews
               WHERE reviews.read_id = reads.id
               ORDER BY reviews.created_at DESC, reviews.id DESC LIMIT 1)
                AS plate_review_id,
              links.asset_id, links.source_kind, links.relationship,
              links.source_path_snapshot, links.source_updated_at,
              links.updated_at AS source_link_updated_at,
              derivatives.id AS derivative_id,
              derivatives.derivative_kind, derivatives.algorithm_version,
              derivatives.source_sha256 AS asset_source_sha256,
              derivatives.content_sha256 AS crop_content_sha256,
              derivatives.evidence_read_id,
              embeddings.id AS embedding_id, embeddings.model_name,
              embeddings.algorithm_version AS embedding_algorithm_version,
              embeddings.source_sha256 AS embedding_source_sha256,
              embeddings.embedding_sha256
       FROM public.plate_reads reads
       LEFT JOIN public.vehicle_image_asset_reads links
         ON links.read_id = reads.id AND ${currentLinkSql()}
       LEFT JOIN public.vehicle_image_derivatives derivatives
         ON derivatives.asset_id = links.asset_id
        AND derivatives.derivative_kind = $2
        AND derivatives.algorithm_version = $3
       LEFT JOIN public.vehicle_asset_embeddings embeddings
         ON embeddings.derivative_id = derivatives.id
        AND embeddings.model_name = $4
        AND embeddings.algorithm_version = $5
        AND embeddings.source_sha256 = derivatives.content_sha256
       WHERE reads.id = $1
       LIMIT 1`,
      [
        readId,
        VEHICLE_IMAGE_CROP_KIND,
        VEHICLE_IMAGE_CROP_ALGORITHM,
        VEHICLE_ASSET_EMBEDDING_MODEL,
        VEHICLE_ASSET_EMBEDDING_ALGORITHM,
      ]
    );
    return result.rows?.[0] || null;
  }

  async loadAssetReads(client, assetId) {
    const result = await client.query(
      `SELECT reads.id AS read_id, reads.plate_number, reads.review_status,
              reads.review_revision, reads.applied_alias_id,
              (SELECT reviews.id FROM public.plate_read_reviews reviews
               WHERE reviews.read_id = reads.id
               ORDER BY reviews.created_at DESC, reviews.id DESC LIMIT 1)
                AS plate_review_id,
              links.asset_id, links.source_kind, links.relationship,
              links.source_path_snapshot, links.source_updated_at,
              links.updated_at AS source_link_updated_at
       FROM public.vehicle_image_asset_reads links
       JOIN public.plate_reads reads ON reads.id = links.read_id
       WHERE links.asset_id = $1 AND ${currentLinkSql()}
       ORDER BY reads.id`,
      [assetId]
    );
    return result.rows || [];
  }

  async loadExistingMember(client, derivativeId) {
    const result = await client.query(
      `SELECT members.*,
              COALESCE(merges.target_profile_id, members.profile_id) AS canonical_profile_id,
              profiles.status AS profile_status,
              profiles.revision AS profile_revision,
              profiles.provenance_basis,
              source_profiles.revision AS source_profile_revision,
              source_profiles.provenance_basis AS source_provenance_basis,
              EXISTS (
                SELECT 1
                FROM public.vehicle_reid_v2_current_profile_members current_members
                WHERE current_members.canonical_profile_id =
                  COALESCE(merges.target_profile_id, members.profile_id)
              ) AS canonical_profile_current
       FROM public.vehicle_reid_v2_exact_profile_members members
       JOIN public.vehicle_reid_v2_profiles source_profiles
         ON source_profiles.id = members.profile_id
       LEFT JOIN public.vehicle_reid_v2_current_profile_merges merges
         ON merges.source_profile_id = members.profile_id
       JOIN public.vehicle_reid_v2_profiles profiles
         ON profiles.id = COALESCE(merges.target_profile_id, members.profile_id)
       WHERE members.derivative_id = $1
         AND profiles.status IN ('active','provisional')
       LIMIT 1`,
      [derivativeId]
    );
    return result.rows?.[0] || null;
  }

  async loadPlateAnchorProfiles(client, plates) {
    if (!plates.length) return [];
    const result = await client.query(
      `SELECT DISTINCT anchors.canonical_profile_id AS profile_id,
              profiles.status AS profile_status,
              profiles.revision AS profile_revision, profiles.provenance_basis,
              anchors.normalized_plate
       FROM public.vehicle_reid_v2_current_plate_anchors anchors
       JOIN public.vehicle_reid_v2_profiles profiles
         ON profiles.id = anchors.canonical_profile_id
       WHERE anchors.normalized_plate = ANY($1::varchar[])
         AND profiles.status IN ('active','provisional')
         AND EXISTS (
           SELECT 1
           FROM public.vehicle_reid_v2_current_profile_members members
           WHERE members.canonical_profile_id = anchors.canonical_profile_id
         )
       ORDER BY profile_id, anchors.normalized_plate`,
      [plates]
    );
    return result.rows || [];
  }

  async loadHistoricalExactProfiles(client, readId, plate) {
    const result = await client.query(
      `SELECT DISTINCT COALESCE(merges.target_profile_id, assignments.profile_id)
                AS profile_id,
              profiles.status AS profile_status,
              profiles.revision AS profile_revision,
              profiles.provenance_basis
       FROM public.vehicle_reid_v2_read_assignments assignments
       LEFT JOIN public.vehicle_reid_v2_current_profile_merges merges
         ON merges.source_profile_id = assignments.profile_id
       JOIN public.vehicle_reid_v2_profiles profiles
         ON profiles.id = COALESCE(merges.target_profile_id, assignments.profile_id)
       WHERE assignments.read_id = $1
         AND assignments.status = 'active'
         AND assignments.assignment_basis = 'exact_effective_plate'
         AND assignments.normalized_effective_plate = $2
         AND profiles.status IN ('active','provisional')
         AND EXISTS (
           SELECT 1
           FROM public.vehicle_reid_v2_current_profile_members members
           WHERE members.canonical_profile_id =
             COALESCE(merges.target_profile_id, assignments.profile_id)
         )
       ORDER BY profile_id`,
      [readId, plate]
    );
    return result.rows || [];
  }

  async loadPairReviewEvidence(client, evidence) {
    const result = await client.query(
      `SELECT reviews.id, reviews.label, reviews.revision,
              COALESCE(merges.target_profile_id, members.profile_id) AS profile_id,
              profiles.status AS profile_status,
              profiles.revision AS profile_revision, profiles.provenance_basis,
              CASE WHEN reviews.derivative_id_low = $1
                   THEN reviews.derivative_id_high ELSE reviews.derivative_id_low END
                AS other_derivative_id
       FROM public.vehicle_reid_v2_pair_reviews reviews
       JOIN public.vehicle_image_derivatives other_derivatives
         ON other_derivatives.id = CASE WHEN reviews.derivative_id_low = $1
                   THEN reviews.derivative_id_high ELSE reviews.derivative_id_low END
       JOIN public.vehicle_asset_embeddings other_embeddings
         ON other_embeddings.derivative_id = other_derivatives.id
        AND other_embeddings.model_name = $4
        AND other_embeddings.algorithm_version = $5
        AND other_embeddings.source_sha256 = other_derivatives.content_sha256
       LEFT JOIN public.vehicle_reid_v2_exact_profile_members members
         ON members.derivative_id = other_derivatives.id
       LEFT JOIN public.vehicle_reid_v2_current_profile_merges merges
         ON merges.source_profile_id = members.profile_id
       LEFT JOIN public.vehicle_reid_v2_profiles profiles
         ON profiles.id = COALESCE(merges.target_profile_id, members.profile_id)
        AND profiles.status IN ('active','provisional')
        AND EXISTS (
          SELECT 1
          FROM public.vehicle_reid_v2_current_profile_members current_members
          WHERE current_members.canonical_profile_id = profiles.id
        )
       WHERE (reviews.derivative_id_low = $1 OR reviews.derivative_id_high = $1)
         AND reviews.embedding_model = $4
         AND reviews.algorithm_version = $5
         AND (
           (reviews.derivative_id_low = $1
             AND reviews.source_sha256_low = $2
             AND reviews.embedding_id_low = $3
             AND reviews.source_sha256_high = other_derivatives.content_sha256
             AND reviews.embedding_id_high = other_embeddings.id)
           OR
           (reviews.derivative_id_high = $1
             AND reviews.source_sha256_high = $2
             AND reviews.embedding_id_high = $3
             AND reviews.source_sha256_low = other_derivatives.content_sha256
             AND reviews.embedding_id_low = other_embeddings.id)
         )
         AND EXISTS (
           SELECT 1 FROM public.vehicle_image_asset_reads links
           JOIN public.plate_reads reads ON reads.id = links.read_id
           WHERE links.asset_id = other_derivatives.asset_id
             AND ${currentLinkSql()}
         )
       ORDER BY reviews.id`,
      [
        Number(evidence.derivative_id),
        evidence.crop_content_sha256,
        Number(evidence.embedding_id),
        VEHICLE_ASSET_EMBEDDING_MODEL,
        VEHICLE_ASSET_EMBEDDING_ALGORITHM,
      ]
    );
    return result.rows || [];
  }

  async createProfile(client, evidence, { provenanceBasis, representativeFingerprint }) {
    const result = await client.query(
      `INSERT INTO public.vehicle_reid_v2_profiles (
         status, revision, provenance_basis, representative_derivative_id,
         representative_embedding_id, representative_source_sha256,
         representative_evidence_fingerprint, created_by_user_id,
         created_by_username, created_by_display_name
       ) VALUES (
         $1, 1, $2, $3, $4, $5, $6, NULL,
         'reid-v2-live', 'ReID live processor'
       ) RETURNING *`,
      [
        provenanceBasis === "provisional_singleton" ? "provisional" : "active",
        provenanceBasis,
        Number(evidence.derivative_id),
        Number(evidence.embedding_id),
        evidence.crop_content_sha256,
        representativeFingerprint,
      ]
    );
    return result.rows[0];
  }

  async createMember(client, profile, evidence, {
    evidenceFingerprint,
    sourceFingerprint,
    membershipBasis,
  }) {
    const result = await client.query(
      `INSERT INTO public.vehicle_reid_v2_profile_members (
         profile_id, status, revision, derivative_id, asset_id,
         derivative_kind, crop_algorithm_version, asset_source_sha256,
         crop_content_sha256, embedding_id, embedding_model,
         embedding_algorithm_version, embedding_source_sha256,
         embedding_sha256, membership_basis, representative_evidence_read_id,
         source_revision_fingerprint, evidence_fingerprint
       ) VALUES (
         $1, 'current', 1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16
       ) RETURNING *`,
      [
        Number(profile.id),
        Number(evidence.derivative_id),
        Number(evidence.asset_id),
        evidence.derivative_kind,
        evidence.algorithm_version,
        evidence.asset_source_sha256,
        evidence.crop_content_sha256,
        Number(evidence.embedding_id),
        evidence.model_name,
        evidence.embedding_algorithm_version,
        evidence.embedding_source_sha256,
        evidence.embedding_sha256,
        membershipBasis,
        Number(evidence.evidence_read_id || evidence.read_id),
        sourceFingerprint,
        evidenceFingerprint,
      ]
    );
    return result.rows[0];
  }

  async createPlateAnchor(client, profileId, read, normalized, fingerprint) {
    const result = await client.query(
      `INSERT INTO public.vehicle_reid_v2_profile_plate_anchors (
         profile_id, status, normalized_plate, evidence_read_id,
         plate_review_status, plate_review_revision, plate_review_id,
         applied_alias_id, evidence_fingerprint
       )
       SELECT $1, 'current', $2::varchar(32), $3, $4, $5, $6, $7, $8
       WHERE NOT EXISTS (
         SELECT 1 FROM public.vehicle_reid_v2_current_plate_anchors anchors
         WHERE anchors.canonical_profile_id = $1
           AND anchors.normalized_plate = $2::varchar(32)
       )
       RETURNING id`,
      [
        Number(profileId), normalized, Number(read.read_id), read.review_status,
        Number(read.review_revision || 0), read.plate_review_id || null,
        read.applied_alias_id || null, fingerprint,
      ]
    );
    return result.rows?.[0] || null;
  }

  async createImageAssignment(client, { read, profile, member, basis, fingerprint }) {
    const result = await client.query(
      `INSERT INTO public.vehicle_reid_v2_read_assignments (
         read_id, profile_id, status, revision, assignment_basis,
         profile_membership_basis, profile_revision, profile_member_id,
         asset_id, derivative_id, embedding_id, normalized_effective_plate,
         plate_review_status, plate_review_revision, plate_review_id,
         applied_alias_id, source_kind, source_relationship,
         source_path_snapshot, source_updated_at, source_link_updated_at,
         evidence_fingerprint
       ) SELECT
         $1, $2, 'active', 1, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
       WHERE NOT EXISTS (
         SELECT 1 FROM public.vehicle_reid_v2_current_read_assignments current
         WHERE current.read_id = $1
       )
       RETURNING id`,
      [
        Number(read.read_id), Number(profile.id), basis, member.membership_basis,
        Number(profile.revision), Number(member.id), Number(member.asset_id),
        Number(member.derivative_id), Number(member.embedding_id),
        normalizedPlate(read.plate_number) || null, read.review_status,
        Number(read.review_revision || 0), read.plate_review_id || null,
        read.applied_alias_id || null, read.source_kind, read.relationship,
        read.source_path_snapshot, read.source_updated_at,
        read.source_link_updated_at, fingerprint,
      ]
    );
    return result.rows?.[0] || null;
  }

  async createPlateAssignment(client, { read, profile, fingerprint }) {
    const normalized = normalizedPlate(read.plate_number);
    const result = await client.query(
      `INSERT INTO public.vehicle_reid_v2_read_assignments (
         read_id, profile_id, status, revision, assignment_basis,
         profile_membership_basis, profile_revision, normalized_effective_plate,
         plate_review_status, plate_review_revision, plate_review_id,
         applied_alias_id, evidence_fingerprint
       ) VALUES (
         $1, $2, 'active', 1, 'exact_effective_plate',
         'exact_effective_plate', $3, $4,
         $5, $6, $7, $8, $9
       )
       RETURNING id`,
      [
        Number(read.read_id), Number(profile.id), Number(profile.revision), normalized,
        read.review_status,
        Number(read.review_revision || 0), read.plate_review_id || null,
        read.applied_alias_id || null, fingerprint,
      ]
    );
    return result.rows?.[0] || null;
  }

  async finishJob(client, readId, claimToken, {
    status, profileId = null, assignmentId = null, basis = null,
    errorCode = null, details = {},
  }) {
    const result = await client.query(
      `UPDATE public.vehicle_reid_v2_live_jobs
       SET status = $3, profile_id = $4, assignment_id = $5,
           result_basis = $6, error_code = $7, error_details = $8::jsonb,
           retryable = FALSE, claim_token = NULL, processing_deadline_at = NULL,
           completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE read_id = $1 AND claim_token = $2::uuid
       RETURNING read_id`,
      [
        readId, claimToken, status, profileId, assignmentId, basis, errorCode,
        JSON.stringify(details || {}),
      ]
    );
    if (!result.rowCount) {
      throw codedError("VEHICLE_REID_V2_LIVE_CLAIM_LOST", "The live ReID job claim expired.");
    }
  }

  async markRelatedReady(client, readId, { profileId, assignmentId, basis }) {
    await client.query(
      `INSERT INTO public.vehicle_reid_v2_live_jobs (
         read_id, status, attempt_count, retryable, profile_id,
         assignment_id, result_basis, completed_at
       ) VALUES ($1, 'ready', 1, FALSE, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (read_id) DO UPDATE
         SET status = 'ready', retryable = FALSE,
             profile_id = EXCLUDED.profile_id,
             assignment_id = EXCLUDED.assignment_id,
             result_basis = EXCLUDED.result_basis,
             error_code = NULL, error_details = NULL,
             claim_token = NULL, processing_deadline_at = NULL,
             completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE public.vehicle_reid_v2_live_jobs.status <> 'processing'`,
      [readId, profileId, assignmentId, basis]
    );
  }

  async processClaimedRead({ readId, claimToken }) {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LIVE_AUTHORITY_LOCK]);
      const mode = await client.query(
        `SELECT mode FROM public.vehicle_reid_control WHERE singleton = TRUE FOR SHARE`
      );
      if (mode.rows?.[0]?.mode !== "v2_primary") {
        await this.finishJob(client, readId, claimToken, {
          status: "unavailable",
          errorCode: "V2_NOT_PRIMARY",
          details: { mode: mode.rows?.[0]?.mode || null },
        });
        return { status: "unavailable", readId };
      }

      const existing = await client.query(
        `SELECT assignments.id, assignments.canonical_profile_id AS profile_id,
                assignments.assignment_basis
         FROM public.vehicle_reid_v2_current_read_assignments assignments
         WHERE assignments.read_id = $1 LIMIT 1`,
        [readId]
      );
      const evidence = await this.loadReadEvidence(client, readId);
      if (!evidence) {
        throw codedError("VEHICLE_REID_V2_LIVE_READ_MISSING", "The plate read no longer exists.");
      }
      if (existing.rowCount) {
        const assignment = existing.rows[0];
        if (isTrustedPlate(evidence)) {
          const plate = normalizedPlate(evidence.plate_number);
          const anchorFingerprint = stableFingerprint("profile-plate-anchor", {
            profileId: Number(assignment.profile_id),
            plate,
            readId: Number(evidence.read_id),
            reviewStatus: evidence.review_status,
            reviewRevision: Number(evidence.review_revision || 0),
            plateReviewId: Number(evidence.plate_review_id || 0) || null,
            appliedAliasId: Number(evidence.applied_alias_id || 0) || null,
          });
          await this.createPlateAnchor(
            client,
            Number(assignment.profile_id),
            evidence,
            plate,
            anchorFingerprint
          );
        }
        await this.finishJob(client, readId, claimToken, {
          status: "ready",
          profileId: Number(assignment.profile_id),
          assignmentId: Number(assignment.id),
          basis: assignment.assignment_basis,
        });
        return { status: "ready", readId, reused: true };
      }

      if (!evidence.derivative_id || !evidence.embedding_id) {
        if (!isTrustedPlate(evidence)) {
          await this.finishJob(client, readId, claimToken, {
            status: "unavailable",
            errorCode: "NO_IDENTITY_ELIGIBLE_EVIDENCE",
          });
          return { status: "unavailable", readId };
        }
        const plate = normalizedPlate(evidence.plate_number);
        const [anchors, historical] = await Promise.all([
          this.loadPlateAnchorProfiles(client, [plate]),
          this.loadHistoricalExactProfiles(client, readId, plate),
        ]);
        const profiles = new Map();
        for (const candidate of [...anchors, ...historical]) {
          profiles.set(Number(candidate.profile_id), { ...candidate, id: candidate.profile_id });
        }
        if (profiles.size !== 1) {
          const status = profiles.size > 1 ? "conflict" : "unavailable";
          const errorCode = profiles.size > 1
            ? "AMBIGUOUS_EXACT_PLATE_PROFILE"
            : "NO_EXACT_PLATE_PROFILE";
          await this.finishJob(client, readId, claimToken, { status, errorCode, details: { plate } });
          return { status, readId };
        }
        const profile = profiles.values().next().value;
        const anchorFingerprint = stableFingerprint("profile-plate-anchor", {
          profileId: Number(profile.id), plate, readId,
          reviewStatus: evidence.review_status,
          reviewRevision: Number(evidence.review_revision || 0),
          plateReviewId: Number(evidence.plate_review_id || 0) || null,
          appliedAliasId: Number(evidence.applied_alias_id || 0) || null,
        });
        await this.createPlateAnchor(client, Number(profile.id), evidence, plate, anchorFingerprint);
        const fingerprint = stableFingerprint("exact-plate-assignment", {
          readId, profileId: Number(profile.id), plate,
          reviewStatus: evidence.review_status,
          reviewRevision: Number(evidence.review_revision || 0),
          plateReviewId: Number(evidence.plate_review_id || 0) || null,
          appliedAliasId: Number(evidence.applied_alias_id || 0) || null,
        });
        const assignment = await this.createPlateAssignment(client, {
          read: evidence, profile, fingerprint,
        });
        if (!assignment) throw codedError("VEHICLE_REID_V2_LIVE_ASSIGNMENT_RACE", "Another assignment won the read race.");
        await this.finishJob(client, readId, claimToken, {
          status: "ready", profileId: Number(profile.id),
          assignmentId: Number(assignment.id), basis: "exact_effective_plate",
        });
        await writeAudit(client, {
          eventType: "vehicle.reid_v2_live_read_assigned",
          readId,
          metadata: { profileId: Number(profile.id), basis: "exact_effective_plate" },
        });
        return { status: "ready", readId, profileId: Number(profile.id) };
      }

      const assetReads = await this.loadAssetReads(client, Number(evidence.asset_id));
      const nonRejectedPlates = [...new Set(assetReads
        .filter((row) => row.review_status !== "rejected")
        .map((row) => normalizedPlate(row.plate_number)).filter(Boolean))].sort();
      if (nonRejectedPlates.length > 1) {
        await this.finishJob(client, readId, claimToken, {
          status: "conflict",
          errorCode: "AMBIGUOUS_EFFECTIVE_PLATES",
          details: { assetId: Number(evidence.asset_id), plates: nonRejectedPlates },
        });
        await writeAudit(client, {
          eventType: "vehicle.reid_v2_live_conflict",
          readId, outcome: "failed",
          metadata: { reason: "ambiguous_effective_plates", plates: nonRejectedPlates },
        });
        return { status: "conflict", readId };
      }

      const trustedReads = assetReads.filter(isTrustedPlate);
      const trustedPlates = [...new Set(trustedReads
        .map((row) => normalizedPlate(row.plate_number)).filter(Boolean))].sort();
      const [existingMember, anchorProfiles, reviews] = await Promise.all([
        this.loadExistingMember(client, Number(evidence.derivative_id)),
        this.loadPlateAnchorProfiles(client, trustedPlates),
        this.loadPairReviewEvidence(client, evidence),
      ]);
      if (existingMember && existingMember.canonical_profile_current !== true) {
        await this.finishJob(client, readId, claimToken, {
          status: "conflict",
          errorCode: "PROFILE_COMPONENT_QUARANTINED",
          details: { profileId: Number(existingMember.canonical_profile_id) },
        });
        return { status: "conflict", readId };
      }
      const negativeReviews = reviews.filter((row) => (
        row.label === "different_vehicle" || row.label === "unsure"
      ));
      if (negativeReviews.length) {
        await this.finishJob(client, readId, claimToken, {
          status: "conflict",
          errorCode: negativeReviews.some((row) => row.label === "different_vehicle")
            ? "HUMAN_DIFFERENT" : "HUMAN_UNSURE",
          details: { reviewIds: negativeReviews.map((row) => Number(row.id)) },
        });
        return { status: "conflict", readId };
      }

      const candidateProfiles = new Map();
      const plateProfileIds = new Set();
      const sameReviewProfileIds = new Set();
      if (existingMember) {
        candidateProfiles.set(Number(existingMember.canonical_profile_id), {
          id: Number(existingMember.canonical_profile_id),
          revision: Number(existingMember.profile_revision),
          provenance_basis: existingMember.provenance_basis,
        });
      }
      for (const anchor of anchorProfiles) {
        const profileId = Number(anchor.profile_id);
        plateProfileIds.add(profileId);
        candidateProfiles.set(profileId, { ...anchor, id: profileId });
      }
      for (const review of reviews.filter((row) => row.label === "same_vehicle" && row.profile_id)) {
        const profileId = Number(review.profile_id);
        sameReviewProfileIds.add(profileId);
        candidateProfiles.set(profileId, {
          id: profileId,
          revision: Number(review.profile_revision),
          provenance_basis: review.provenance_basis,
        });
      }
      if (candidateProfiles.size > 1) {
        await this.finishJob(client, readId, claimToken, {
          status: "conflict",
          errorCode: "MULTIPLE_AUTHORITATIVE_PROFILES",
          details: { profileIds: [...candidateProfiles.keys()].sort((a, b) => a - b) },
        });
        return { status: "conflict", readId };
      }

      const sourceFingerprint = stableFingerprint("canonical-source", {
        assetId: Number(evidence.asset_id), derivativeId: Number(evidence.derivative_id),
        embeddingId: Number(evidence.embedding_id), assetSourceSha256: evidence.asset_source_sha256,
        cropContentSha256: evidence.crop_content_sha256,
        embeddingSha256: evidence.embedding_sha256,
      });
      const memberFingerprint = stableFingerprint("profile-member", {
        sourceFingerprint,
        linkedReadIds: assetReads.map((row) => Number(row.read_id)),
        plates: nonRejectedPlates,
        sameReviewIds: reviews.filter((row) => row.label === "same_vehicle")
          .map((row) => Number(row.id)),
      });
      let profile = candidateProfiles.values().next().value || null;
      let membershipBasis = "provisional_singleton";
      if (profile) {
        const profileId = Number(profile.id);
        const byPlate = plateProfileIds.has(profileId);
        const bySame = sameReviewProfileIds.has(profileId);
        membershipBasis = byPlate && bySame
          ? "mixed"
          : byPlate
            ? "exact_effective_plate"
            : bySame
              ? "human_same"
              : existingMember?.membership_basis || "provisional_singleton";
      } else if (trustedPlates.length) {
        membershipBasis = "exact_effective_plate";
      }
      if (!profile) {
        profile = await this.createProfile(client, evidence, {
          provenanceBasis: membershipBasis,
          representativeFingerprint: memberFingerprint,
        });
      }
      if (!profile.revision) profile.revision = profile.profile_revision;

      let member = existingMember;
      if (!member) {
        member = await this.createMember(client, profile, evidence, {
          sourceFingerprint,
          evidenceFingerprint: memberFingerprint,
          membershipBasis,
        });
      }
      const assignmentProfile = existingMember ? {
        id: Number(existingMember.profile_id),
        revision: Number(existingMember.source_profile_revision),
        provenance_basis: existingMember.source_provenance_basis,
      } : profile;

      for (const trustedRead of trustedReads) {
        const plate = normalizedPlate(trustedRead.plate_number);
        const anchorFingerprint = stableFingerprint("profile-plate-anchor", {
          profileId: Number(profile.id), plate, readId: Number(trustedRead.read_id),
          reviewStatus: trustedRead.review_status,
          reviewRevision: Number(trustedRead.review_revision || 0),
          plateReviewId: Number(trustedRead.plate_review_id || 0) || null,
          appliedAliasId: Number(trustedRead.applied_alias_id || 0) || null,
        });
        await this.createPlateAnchor(client, Number(profile.id), trustedRead, plate, anchorFingerprint);
      }

      const assignableReads = assetReads.filter((row) => row.review_status !== "rejected");
      const basis = assignableReads.length > 1 ? "shared_asset" : "canonical_image";
      let requestedAssignment = null;
      for (const linkedRead of assignableReads) {
        const fingerprint = stableFingerprint("canonical-image-assignment", {
          readId: Number(linkedRead.read_id), profileId: Number(profile.id),
          memberId: Number(member.id), basis,
          sourceKind: linkedRead.source_kind, relationship: linkedRead.relationship,
          sourcePath: linkedRead.source_path_snapshot,
          sourceUpdatedAt: linkedRead.source_updated_at,
          linkUpdatedAt: linkedRead.source_link_updated_at,
          reviewStatus: linkedRead.review_status,
          reviewRevision: Number(linkedRead.review_revision || 0),
        });
        const assignment = await this.createImageAssignment(client, {
          read: linkedRead, profile: assignmentProfile, member, basis, fingerprint,
        });
        if (assignment && Number(linkedRead.read_id) !== readId) {
          await this.markRelatedReady(client, Number(linkedRead.read_id), {
            profileId: Number(profile.id), assignmentId: Number(assignment.id), basis,
          });
        }
        if (Number(linkedRead.read_id) === readId) requestedAssignment = assignment;
      }

      if (!requestedAssignment) {
        const raced = await client.query(
          `SELECT id FROM public.vehicle_reid_v2_current_read_assignments
           WHERE read_id = $1 LIMIT 1`,
          [readId]
        );
        requestedAssignment = raced.rows?.[0] || null;
      }
      if (!requestedAssignment) {
        await this.finishJob(client, readId, claimToken, {
          status: "unavailable",
          errorCode: evidence.review_status === "rejected"
            ? "REJECTED_PLATE_EVIDENCE" : "ASSIGNMENT_NOT_CREATED",
        });
        return { status: "unavailable", readId };
      }
      await this.finishJob(client, readId, claimToken, {
        status: "ready", profileId: Number(profile.id),
        assignmentId: Number(requestedAssignment.id), basis,
      });
      await writeAudit(client, {
        eventType: "vehicle.reid_v2_live_read_assigned",
        readId,
        metadata: {
          profileId: Number(profile.id), memberId: Number(member.id), basis,
          createdProfile: candidateProfiles.size === 0,
        },
      });
      return {
        status: "ready", readId, profileId: Number(profile.id),
        assignmentId: Number(requestedAssignment.id), basis,
      };
    });
  }

  async recordFailure({ readId, claimToken, error }) {
    const failure = safeError(error);
    await this.pool.query(
      `UPDATE public.vehicle_reid_v2_live_jobs
       SET status = 'failed', retryable = attempt_count < 3,
           claim_token = NULL, processing_deadline_at = NULL,
           next_attempt_at = CASE WHEN attempt_count < 3
             THEN CURRENT_TIMESTAMP + INTERVAL '30 seconds' ELSE NULL END,
           error_code = $3, error_details = $4::jsonb,
           completed_at = CASE WHEN attempt_count >= 3
             THEN CURRENT_TIMESTAMP ELSE completed_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE read_id = $1 AND claim_token = $2::uuid`,
      [readId, claimToken, failure.code, JSON.stringify(failure)]
    );
    return failure;
  }

  async getOverview() {
    const result = await this.pool.query(
      `SELECT control.mode,
              COUNT(jobs.read_id) FILTER (WHERE jobs.status = 'pending')::integer AS pending,
              COUNT(jobs.read_id) FILTER (WHERE jobs.status = 'processing')::integer AS processing,
              COUNT(jobs.read_id) FILTER (WHERE jobs.status = 'ready')::integer AS ready,
              COUNT(jobs.read_id) FILTER (WHERE jobs.status = 'conflict')::integer AS conflict,
              COUNT(jobs.read_id) FILTER (WHERE jobs.status = 'unavailable')::integer AS unavailable,
              COUNT(jobs.read_id) FILTER (WHERE jobs.status = 'failed')::integer AS failed,
              MAX(jobs.completed_at)::text AS last_completed_at
       FROM public.vehicle_reid_control control
       LEFT JOIN public.vehicle_reid_v2_live_jobs jobs ON TRUE
       WHERE control.singleton = TRUE
       GROUP BY control.mode`
    );
    return result.rows?.[0] || null;
  }

  async listExceptions({ limit = 25 } = {}) {
    const bounded = boundedLimit(limit, 25);
    const result = await this.pool.query(
      `SELECT jobs.read_id, jobs.status, jobs.attempt_count,
              jobs.operator_retry_count, jobs.error_code, jobs.error_details,
              jobs.updated_at::text, reads.plate_number, reads.camera_name,
              reads.timestamp::text AS read_timestamp
       FROM public.vehicle_reid_v2_live_jobs jobs
       JOIN public.plate_reads reads ON reads.id = jobs.read_id
       WHERE jobs.status IN ('conflict','unavailable','failed')
       ORDER BY jobs.updated_at DESC, jobs.read_id DESC
       LIMIT $1`,
      [bounded]
    );
    return result.rows || [];
  }

  async retryException({ readId, actor } = {}) {
    const id = Number(readId);
    const actorId = Number(actor?.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw codedError("VEHICLE_REID_V2_LIVE_READ_ID", "A valid ReID live read is required.");
    }
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LIVE_AUTHORITY_LOCK]);
      const result = await client.query(
        `UPDATE public.vehicle_reid_v2_live_jobs
         SET status = 'pending', attempt_count = 0,
             operator_retry_count = operator_retry_count + 1,
             retryable = TRUE, claim_token = NULL,
             processing_deadline_at = NULL, next_attempt_at = NULL,
             profile_id = NULL, assignment_id = NULL, result_basis = NULL,
             error_code = NULL, error_details = NULL, completed_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE read_id = $1
           AND status IN ('conflict','unavailable','failed')
           AND operator_retry_count < 1
         RETURNING read_id, operator_retry_count`,
        [id]
      );
      if (!result.rowCount) {
        throw codedError(
          "VEHICLE_REID_V2_LIVE_RETRY_UNAVAILABLE",
          "This live ReID exception has no bounded operator retry remaining."
        );
      }
      await client.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id,
           outcome, metadata
         ) VALUES ($1, 'browser', 'vehicle.reid_v2_live_retry',
           'plate_read', $2, 'succeeded', $3::jsonb)`,
        [
          Number.isSafeInteger(actorId) && actorId > 0 ? actorId : null,
          String(id),
          JSON.stringify({ operatorRetryCount: Number(result.rows[0].operator_retry_count) }),
        ]
      );
      return { readId: id, operatorRetryCount: Number(result.rows[0].operator_retry_count) };
    });
  }
}

export class VehicleReidV2LiveService {
  constructor({ repository, logger = console } = {}) {
    if (!repository) throw new TypeError("VehicleReidV2LiveService requires a repository.");
    this.repository = repository;
    this.logger = logger;
  }

  async processBatch({ limit = 5 } = {}) {
    const bounded = boundedLimit(limit);
    const discovered = await this.repository.discover({ limit: Math.max(bounded, 25) });
    const claim = await this.repository.claim({ limit: bounded });
    let succeeded = 0;
    let failed = 0;
    const results = [];
    for (const readId of claim.readIds) {
      try {
        const result = await this.repository.processClaimedRead({
          readId, claimToken: claim.token,
        });
        results.push(result);
        if (result.status === "ready") succeeded += 1;
      } catch (error) {
        failed += 1;
        const failure = await this.repository.recordFailure({
          readId, claimToken: claim.token, error,
        });
        results.push({ status: "failed", readId, error: failure });
        this.logger?.error?.("Live authoritative ReID processing failed", {
          readId, error: failure,
        });
      }
    }
    const overview = await this.repository.getOverview();
    return {
      status: claim.readIds.length || discovered.length ? "working" : "idle",
      mode: overview?.mode || null,
      discovered: discovered.length,
      processed: claim.readIds.length,
      succeeded,
      failed,
      results,
      overview,
    };
  }

  getOverview() {
    return this.repository.getOverview();
  }

  async getReviewOverview() {
    const [overview, exceptions] = await Promise.all([
      this.repository.getOverview(),
      this.repository.listExceptions({ limit: 25 }),
    ]);
    return {
      overview,
      exceptions: exceptions.map((row) => ({
        readId: Number(row.read_id),
        status: row.status,
        attemptCount: Number(row.attempt_count || 0),
        operatorRetryCount: Number(row.operator_retry_count || 0),
        errorCode: row.error_code || null,
        errorDetails: row.error_details || {},
        plateNumber: row.plate_number || null,
        cameraName: row.camera_name || null,
        readTimestamp: row.read_timestamp || null,
        updatedAt: row.updated_at || null,
      })),
    };
  }

  retryException(input = {}) {
    return this.repository.retryException(input);
  }
}

export const vehicleReidV2LiveInternals = Object.freeze({
  LIVE_AUTHORITY_LOCK,
  MAX_BATCH_SIZE,
  TRUSTED_PLATE_STATUSES,
  boundedLimit,
  codedError,
  currentLinkSql,
  isTrustedPlate,
  normalizedPlate,
  safeError,
  sha256,
  stableFingerprint,
});
