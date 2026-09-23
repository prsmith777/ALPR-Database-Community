import { randomUUID } from "node:crypto";

import {
  buildVehicleReidV2ConversionProjection,
  vehicleReidV2ConversionPreviewInternals,
  VEHICLE_REID_V2_CONVERSION_ALGORITHM,
} from "./vehicle-reid-v2-conversion-preview.mjs";
import {
  buildVehicleReidV2ProfileCandidateSnapshot,
} from "./vehicle-reid-v2-profile-candidates.mjs";
import { VehicleReidV2ShadowRepository } from "./vehicle-reid-v2-shadow-repository.mjs";

const CROP_KIND = "vehicle_crop";
const CROP_ALGORITHM = "canonical-overview-detection-box-v1";
const EMBEDDING_MODEL = "vehicle-reid-0001-ir-fp16-v1";
const EMBEDDING_ALGORITHM = "canonical-overview-crop-embedding-v1";
const MAX_SOURCES = 10_000;
const MAX_READS = 250_000;
const MAX_REVIEWS = 50_000;
const INSERT_CHUNK = 250;

const { hashJson } = vehicleReidV2ConversionPreviewInternals;

function boundedBatch(value) {
  const parsed = Number(value);
  return [1, 5, 25, 250].includes(parsed) ? parsed : 5;
}

function optionalNonnegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function dispositionFingerprint(identityEvidenceFingerprint, item) {
  return hashJson({
    algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
    kind: "read_disposition",
    identityEvidenceFingerprint,
    item,
  });
}

function dispositionItemFromRow(row) {
  return {
    readId: Number(row.read_id),
    disposition: row.disposition,
    reasonCode: row.reason_code,
    profileKey: row.projection_key ? String(row.projection_key).trim() : null,
    assignmentBasis: row.assignment_basis || null,
    profileEvidenceBasis: row.profile_evidence_basis || null,
    assetId: Number(row.asset_id) || null,
    derivativeId: Number(row.derivative_id) || null,
    embeddingId: Number(row.embedding_id) || null,
    normalizedEffectivePlate: row.normalized_effective_plate || null,
    historical: row.historical === true,
    nighttime: row.nighttime === true,
  };
}

function actorSnapshot(actor) {
  const id = Number(actor?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error("A current administrator is required for a conversion preview.");
    error.code = "VEHICLE_REID_V2_CONVERSION_ACTOR_REQUIRED";
    throw error;
  }
  return {
    id,
    username: String(actor?.username || "administrator").trim().slice(0, 64),
    displayName: String(actor?.displayName || actor?.username || "Administrator")
      .trim().slice(0, 120),
  };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function chunks(values, size = INSERT_CHUNK) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function objectValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function currentLinkPredicate(links = "links", reads = "reads") {
  return `${links}.identity_eligible = TRUE
    AND ${reads}.vehicle_image_status = 'ready'
    AND ${reads}.vehicle_image_path = ${links}.source_path_snapshot
    AND ${reads}.vehicle_image_source_kind = ${links}.source_kind
    AND ${reads}.vehicle_image_updated_at IS NOT DISTINCT FROM ${links}.source_updated_at`;
}

async function audit(client, {
  actor,
  eventType,
  resourceId,
  outcome = "succeeded",
  metadata = {},
}) {
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

export class VehicleReidV2ConversionRepository {
  constructor({ pool, executor = null } = {}) {
    if (!pool && !executor) throw new Error("ReID v2 conversion repository requires a database executor");
    this.pool = pool;
    this.executor = executor;
  }

  query(text, values = []) {
    return (this.executor || this.pool).query(text, values);
  }

  async transaction(operation, {
    isolation = "READ COMMITTED",
    sessionAdvisoryLock = null,
  } = {}) {
    if (!this.pool?.connect) {
      return operation(this.executor || this.pool);
    }
    const client = await this.pool.connect();
    let began = false;
    let sessionLockHeld = false;
    try {
      if (sessionAdvisoryLock) {
        await client.query("SELECT pg_advisory_lock(hashtext($1))", [sessionAdvisoryLock]);
        sessionLockHeld = true;
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
        if (sessionLockHeld) {
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [sessionAdvisoryLock]);
        }
      } finally {
        client.release();
      }
    }
  }

  async listLiveSources(client, { maxReadId, postBoundAssetIds = [] }) {
    const result = await client.query(
      `SELECT derivatives.id AS derivative_id,
              derivatives.asset_id,
              derivatives.derivative_kind,
              derivatives.algorithm_version AS crop_algorithm_version,
              assets.content_sha256 AS asset_source_sha256,
              derivatives.content_sha256 AS crop_content_sha256,
              derivatives.content_sha256,
              derivatives.storage_path AS crop_storage_path,
              embeddings.id AS embedding_id,
              embeddings.model_name AS embedding_model,
              embeddings.algorithm_version AS embedding_algorithm_version,
              embeddings.source_sha256 AS embedding_source_sha256,
              embeddings.embedding_sha256,
              embeddings.embedding_dimensions,
              representative.read_id AS representative_read_id,
              representative.read_id AS read_id,
              representative.source_kind AS representative_source_kind,
              representative.source_kind,
              representative.source_path_snapshot AS representative_source_path,
              representative.source_updated_at::text AS representative_source_updated_at,
              representative.link_updated_at::text AS representative_link_updated_at,
              representative.camera_name,
              representative.overview_context,
              related.plate_numbers,
              related.effective_plate_evidence,
              related.overview_contexts,
              COUNT(*) OVER()::bigint AS total_sources
       FROM public.vehicle_image_derivatives derivatives
       JOIN public.vehicle_image_assets assets ON assets.id = derivatives.asset_id
        AND derivatives.source_sha256 = assets.content_sha256
       JOIN public.vehicle_asset_embeddings embeddings
         ON embeddings.derivative_id = derivatives.id
        AND embeddings.model_name = $3
        AND embeddings.algorithm_version = $4
        AND embeddings.source_sha256 = derivatives.content_sha256
       JOIN LATERAL (
         SELECT links.read_id, links.source_kind, links.source_path_snapshot,
                links.source_updated_at, links.updated_at AS link_updated_at,
                reads.camera_name, links.overview_context
         FROM public.vehicle_image_asset_reads links
         JOIN public.plate_reads reads ON reads.id = links.read_id
         WHERE links.asset_id = derivatives.asset_id
            AND links.read_id <= $5
           AND ${currentLinkPredicate()}
         ORDER BY reads.timestamp DESC, links.read_id DESC
         LIMIT 1
       ) representative ON TRUE
       JOIN LATERAL (
         SELECT ARRAY_AGG(DISTINCT UPPER(REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g'))
                    ORDER BY UPPER(REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g')))
                  AS plate_numbers,
                JSONB_AGG(JSONB_BUILD_OBJECT(
                  'plate', reads.plate_number,
                  'reviewStatus', reads.review_status,
                  'reviewRevision', reads.review_revision,
                  'readId', reads.id
                ) ORDER BY reads.id) AS effective_plate_evidence,
                JSONB_AGG(DISTINCT links.overview_context ORDER BY links.overview_context)
                  AS overview_contexts
         FROM public.vehicle_image_asset_reads links
         JOIN public.plate_reads reads ON reads.id = links.read_id
         WHERE links.asset_id = derivatives.asset_id
            AND (links.read_id <= $5 OR links.asset_id = ANY($6::bigint[]))
            AND ${currentLinkPredicate()}
        ) related ON TRUE
       WHERE derivatives.derivative_kind = $1
         AND derivatives.algorithm_version = $2
        ORDER BY derivatives.id
        LIMIT ${MAX_SOURCES + 1}`,
      [
        CROP_KIND,
        CROP_ALGORITHM,
        EMBEDDING_MODEL,
        EMBEDDING_ALGORITHM,
        maxReadId,
        postBoundAssetIds,
      ]
    );
    if ((result.rows || []).length > MAX_SOURCES) {
      throw codedError(
        "VEHICLE_REID_V2_CONVERSION_SOURCE_LIMIT",
        `The exact-current crop inventory exceeds the ${MAX_SOURCES.toLocaleString()}-crop preview bound.`
      );
    }
    return result.rows || [];
  }

  async listLiveReviews(client, { derivativeIds = null } = {}) {
    const result = await client.query(
      `SELECT reviews.id AS review_id, reviews.id,
              reviews.revision, reviews.derivative_id_low,
              reviews.derivative_id_high, reviews.source_sha256_low,
              reviews.source_sha256_high, reviews.embedding_id_low,
              reviews.embedding_id_high, reviews.embedding_model,
              reviews.algorithm_version AS embedding_algorithm_version,
              reviews.algorithm_version, reviews.similarity_score,
              reviews.label, reviews.evidence_plate_low,
              reviews.evidence_plate_high, reviews.campaign_id,
              reviews.updated_at::text AS review_updated_at,
              reviews.updated_at::text AS updated_at
       FROM public.vehicle_reid_v2_pair_reviews reviews
       WHERE reviews.embedding_model = $1
          AND reviews.algorithm_version = $2
          AND ($3::bigint[] IS NULL
            OR reviews.derivative_id_low = ANY($3::bigint[])
            OR reviews.derivative_id_high = ANY($3::bigint[]))
        ORDER BY reviews.derivative_id_low, reviews.derivative_id_high, reviews.id
        LIMIT ${MAX_REVIEWS + 1}`,
      [EMBEDDING_MODEL, EMBEDDING_ALGORITHM, derivativeIds]
    );
    if ((result.rows || []).length > MAX_REVIEWS) {
      throw codedError(
        "VEHICLE_REID_V2_CONVERSION_REVIEW_LIMIT",
        `The pair-review inventory exceeds the ${MAX_REVIEWS.toLocaleString()}-review preview bound.`
      );
    }
    return result.rows || [];
  }

  async listLiveReads(client, { maxReadId }) {
    const result = await client.query(
      `SELECT reads.id AS read_id,
              reads.event_identity AS read_event_identity,
              reads.timestamp::text AS read_timestamp,
              reads.created_at::text AS read_created_at,
              reads.camera_name,
              reads.observed_plate,
              reads.plate_number AS effective_plate,
              UPPER(REGEXP_REPLACE(reads.plate_number, '[^A-Za-z0-9]', '', 'g'))
                AS normalized_effective_plate,
              reads.review_status AS plate_review_status,
              reads.review_status,
              reads.review_revision AS plate_review_revision,
              reads.review_revision,
              latest_review.id AS last_plate_review_id,
              latest_review.action AS last_plate_review_action,
              latest_review.created_at::text AS last_plate_review_created_at,
              reads.applied_alias_id,
              reads.vehicle_image_status,
              reads.vehicle_image_queue_kind,
              reads.vehicle_image_error_code,
              reads.vehicle_image_path,
              reads.vehicle_image_source_kind,
              reads.vehicle_image_updated_at::text AS vehicle_image_updated_at,
              CASE
                WHEN candidates.daylight_status = 'nighttime'
                  OR UPPER(COALESCE(reads.vehicle_image_error_code, '')) LIKE '%NIGHT%'
                  THEN 'nighttime'
                WHEN candidates.daylight_status = 'daytime' THEN 'daytime'
                ELSE 'unknown'
              END AS daylight_status,
              CASE
                WHEN links.asset_id IS NULL THEN 'absent'
                WHEN links.identity_eligible = FALSE
                  OR links.relationship = 'display_fallback' THEN 'display_only'
                WHEN ${currentLinkPredicate()}
                  AND derivatives.id IS NOT NULL AND embeddings.id IS NOT NULL THEN 'current'
                WHEN ${currentLinkPredicate()} THEN 'incomplete'
                ELSE 'stale'
              END AS canonical_link_state,
              links.asset_id,
              derivatives.id AS derivative_id,
              embeddings.id AS embedding_id,
              links.source_read_id,
              links.source_kind,
              links.relationship,
              links.identity_eligible,
              links.overview_context,
              links.source_path_snapshot,
              links.source_updated_at::text AS source_updated_at,
              links.updated_at::text AS link_updated_at,
              reads.vehicle_image_queue_kind IN ('historical','overview_backfill')
                OR links.source_kind = 'entry_overview_history' AS historical,
              assignments.cluster_id AS v1_cluster_id,
              assignments.assignment_status AS v1_assignment_status,
              assignments.revision AS v1_assignment_revision,
              assignments.embedding_model AS v1_embedding_model,
              assignments.algorithm_version AS v1_algorithm_version
       FROM public.plate_reads reads
       LEFT JOIN public.vehicle_image_asset_reads links ON links.read_id = reads.id
       LEFT JOIN public.vehicle_image_assets assets ON assets.id = links.asset_id
       LEFT JOIN public.vehicle_image_derivatives derivatives
         ON derivatives.asset_id = links.asset_id
        AND derivatives.derivative_kind = $2
        AND derivatives.algorithm_version = $3
        AND derivatives.source_sha256 = assets.content_sha256
       LEFT JOIN public.vehicle_asset_embeddings embeddings
         ON embeddings.derivative_id = derivatives.id
        AND embeddings.model_name = $4
        AND embeddings.algorithm_version = $5
        AND embeddings.source_sha256 = derivatives.content_sha256
       LEFT JOIN public.vehicle_overview_candidates candidates
         ON candidates.id = reads.vehicle_overview_candidate_id
       LEFT JOIN LATERAL (
         SELECT reviews.id, reviews.action, reviews.created_at
         FROM public.plate_read_reviews reviews
         WHERE reviews.read_id = reads.id
         ORDER BY reviews.created_at DESC, reviews.id DESC
         LIMIT 1
       ) latest_review ON TRUE
       LEFT JOIN public.vehicle_cluster_assignments assignments
         ON assignments.read_id = reads.id
       WHERE reads.id <= $1
        ORDER BY reads.id
        LIMIT ${MAX_READS + 1}`,
      [maxReadId, CROP_KIND, CROP_ALGORITHM, EMBEDDING_MODEL, EMBEDDING_ALGORITHM]
    );
    if ((result.rows || []).length > MAX_READS) {
      throw codedError(
        "VEHICLE_REID_V2_CONVERSION_READ_LIMIT",
        `The historical read inventory exceeds the ${MAX_READS.toLocaleString()}-read preview bound.`
      );
    }
    return result.rows || [];
  }

  async captureLiveEvidence(client, {
    maxReadId = null,
    postBoundAssetIds = [],
  } = {}) {
    const requestedMaxReadId = optionalNonnegativeInteger(maxReadId);
    const bounds = await client.query(
      `SELECT COALESCE($1::integer, (SELECT MAX(id) FROM public.plate_reads), 0)::integer
                AS max_read_id,
              COALESCE((SELECT MAX(id) FROM public.plate_read_reviews), 0)::bigint
                AS max_plate_review_id,
              COALESCE((SELECT MAX(id) FROM public.vehicle_reid_v2_pair_reviews), 0)::bigint
                AS max_pair_review_id`,
      [requestedMaxReadId]
    );
    const frozenMaxReadId = Number(bounds.rows[0].max_read_id || 0);
    const sourceRows = await this.listLiveSources(client, {
      maxReadId: frozenMaxReadId,
      postBoundAssetIds,
    });
    const derivativeIds = sourceRows.map((row) => Number(row.derivative_id)).filter(Number.isSafeInteger);
    const [reviewRows, readRows] = await Promise.all([
      this.listLiveReviews(client, { derivativeIds }),
      this.listLiveReads(client, { maxReadId: frozenMaxReadId }),
    ]);
    return {
      maxReadId: frozenMaxReadId,
      maxDerivativeId: Math.max(0, ...sourceRows.map((row) => Number(row.derivative_id) || 0)),
      maxPlateReviewId: Number(bounds.rows[0].max_plate_review_id || 0),
      maxPairReviewId: Number(bounds.rows[0].max_pair_review_id || 0),
      sourceRows,
      reviewRows,
      readRows,
    };
  }

  async insertCropEvidence(client, runId, projection) {
    const rows = projection.sources.map((source) => ({
      derivative_id: source.derivativeId,
      asset_id: source.assetId,
      derivative_kind: source.cropKind,
      crop_algorithm_version: source.cropAlgorithmVersion,
      asset_source_sha256: source.assetSourceSha256,
      crop_content_sha256: source.cropContentSha256,
      crop_storage_path: source.cropStoragePath,
      embedding_id: source.embeddingId,
      embedding_model: source.embeddingModel,
      embedding_algorithm_version: source.embeddingAlgorithmVersion,
      embedding_source_sha256: source.embeddingSourceSha256,
      embedding_sha256: source.embeddingSha256,
      embedding_dimensions: source.embeddingDimensions,
      representative_read_id: source.representativeReadId,
      representative_source_kind: source.representativeSourceKind,
      representative_source_path: source.representativeSourcePath,
      representative_source_updated_at: source.representativeSourceUpdatedAt,
      representative_link_updated_at: source.representativeLinkUpdatedAt,
      effective_plates: source.effectivePlates,
      overview_contexts: source.overviewContexts,
      evidence_fingerprint: hashJson({
        algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
        kind: "crop",
        source,
      }),
    }));
    for (const batch of chunks(rows)) {
      await client.query(
        `INSERT INTO public.vehicle_reid_v2_conversion_crop_evidence (
           run_id, derivative_id, asset_id, derivative_kind,
           crop_algorithm_version, asset_source_sha256, crop_content_sha256,
           crop_storage_path, embedding_id, embedding_model,
           embedding_algorithm_version, embedding_source_sha256,
           embedding_sha256, embedding_dimensions, representative_read_id,
           representative_source_kind, representative_source_path,
           representative_source_updated_at, representative_link_updated_at,
           effective_plates, overview_contexts, evidence_fingerprint
         )
         SELECT $1, rows.derivative_id, rows.asset_id, rows.derivative_kind,
                rows.crop_algorithm_version, rows.asset_source_sha256,
                rows.crop_content_sha256, rows.crop_storage_path,
                rows.embedding_id, rows.embedding_model,
                rows.embedding_algorithm_version, rows.embedding_source_sha256,
                rows.embedding_sha256, rows.embedding_dimensions,
                rows.representative_read_id, rows.representative_source_kind,
                rows.representative_source_path,
                rows.representative_source_updated_at,
                rows.representative_link_updated_at, rows.effective_plates,
                rows.overview_contexts, rows.evidence_fingerprint
         FROM JSONB_TO_RECORDSET($2::jsonb) AS rows(
           derivative_id bigint, asset_id bigint, derivative_kind varchar(32),
           crop_algorithm_version varchar(100), asset_source_sha256 char(64),
           crop_content_sha256 char(64), crop_storage_path text,
           embedding_id bigint, embedding_model varchar(100),
           embedding_algorithm_version varchar(100),
           embedding_source_sha256 char(64), embedding_sha256 char(64),
           embedding_dimensions smallint, representative_read_id integer,
           representative_source_kind varchar(40), representative_source_path text,
           representative_source_updated_at timestamptz,
           representative_link_updated_at timestamptz, effective_plates jsonb,
           overview_contexts jsonb, evidence_fingerprint char(64)
         )`,
        [runId, JSON.stringify(batch)]
      );
    }
    return new Map(rows.map((row) => [row.derivative_id, row.evidence_fingerprint]));
  }

  async insertReviewEvidence(client, runId, rawRows) {
    const rows = rawRows.map((row) => ({
      review_id: Number(row.review_id || row.id),
      revision: Number(row.revision || 1),
      derivative_id_low: Number(row.derivative_id_low),
      derivative_id_high: Number(row.derivative_id_high),
      source_sha256_low: row.source_sha256_low,
      source_sha256_high: row.source_sha256_high,
      embedding_id_low: Number(row.embedding_id_low),
      embedding_id_high: Number(row.embedding_id_high),
      embedding_model: row.embedding_model,
      embedding_algorithm_version: row.embedding_algorithm_version || row.algorithm_version,
      similarity_score: Number(row.similarity_score),
      label: row.label,
      evidence_plate_low: row.evidence_plate_low || null,
      evidence_plate_high: row.evidence_plate_high || null,
      campaign_id: Number(row.campaign_id) || null,
      review_updated_at: row.review_updated_at || row.updated_at,
      evidence_fingerprint: hashJson({
        algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
        kind: "pair_review",
        row,
      }),
    }));
    for (const batch of chunks(rows)) {
      await client.query(
        `INSERT INTO public.vehicle_reid_v2_conversion_review_evidence (
           run_id, review_id, revision, derivative_id_low, derivative_id_high,
           source_sha256_low, source_sha256_high, embedding_id_low,
           embedding_id_high, embedding_model, embedding_algorithm_version,
           similarity_score, label, evidence_plate_low, evidence_plate_high,
           campaign_id, review_updated_at, evidence_fingerprint
         ) SELECT $1, rows.review_id, rows.revision, rows.derivative_id_low,
                  rows.derivative_id_high, rows.source_sha256_low,
                  rows.source_sha256_high, rows.embedding_id_low,
                  rows.embedding_id_high, rows.embedding_model,
                  rows.embedding_algorithm_version, rows.similarity_score,
                  rows.label, rows.evidence_plate_low, rows.evidence_plate_high,
                  rows.campaign_id, rows.review_updated_at,
                  rows.evidence_fingerprint
           FROM JSONB_TO_RECORDSET($2::jsonb) AS rows(
             review_id bigint, revision integer, derivative_id_low bigint,
             derivative_id_high bigint, source_sha256_low char(64),
             source_sha256_high char(64), embedding_id_low bigint,
             embedding_id_high bigint, embedding_model varchar(100),
             embedding_algorithm_version varchar(100),
             similarity_score double precision, label varchar(24),
             evidence_plate_low text, evidence_plate_high text,
             campaign_id bigint, review_updated_at timestamptz,
             evidence_fingerprint char(64)
           )`,
        [runId, JSON.stringify(batch)]
      );
    }
  }

  async insertReadEvidence(client, runId, rawRows, projection, cropFingerprints) {
    const normalizedById = new Map(projection.reads.map((row) => [row.readId, row]));
    const rows = rawRows.map((row) => {
      const normalized = normalizedById.get(Number(row.read_id));
      const plateEvidenceFingerprint = hashJson({
        readId: normalized.readId,
        effectivePlate: normalized.effectivePlate,
        reviewStatus: normalized.reviewStatus,
        reviewRevision: normalized.reviewRevision,
        lastPlateReviewId: normalized.lastPlateReviewId,
        appliedAliasId: normalized.appliedAliasId,
      });
      const evidenceFingerprint = hashJson({
        algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
        kind: "read",
        read: {
          ...normalized,
          v1ClusterId: undefined,
          v1AssignmentStatus: undefined,
          v1AssignmentRevision: undefined,
        },
      });
      return {
        read_id: normalized.readId,
        read_event_identity: row.read_event_identity || null,
        read_timestamp: row.read_timestamp,
        read_created_at: row.read_created_at,
        camera_name: row.camera_name || null,
        observed_plate: row.observed_plate,
        effective_plate: row.effective_plate,
        normalized_effective_plate: normalized.effectivePlate || null,
        plate_review_status: normalized.reviewStatus,
        plate_review_revision: normalized.reviewRevision,
        last_plate_review_id: normalized.lastPlateReviewId,
        last_plate_review_action: row.last_plate_review_action || null,
        last_plate_review_created_at: row.last_plate_review_created_at || null,
        applied_alias_id: normalized.appliedAliasId,
        plate_evidence_fingerprint: plateEvidenceFingerprint,
        vehicle_image_status: row.vehicle_image_status || null,
        vehicle_image_queue_kind: row.vehicle_image_queue_kind || null,
        vehicle_image_error_code: row.vehicle_image_error_code || null,
        vehicle_image_path: row.vehicle_image_path || null,
        vehicle_image_source_kind: row.vehicle_image_source_kind || null,
        vehicle_image_updated_at: row.vehicle_image_updated_at || null,
        daylight_status: normalized.daylightStatus,
        canonical_link_state: normalized.canonicalLinkState,
        asset_id: normalized.assetId,
        derivative_id: normalized.derivativeId,
        embedding_id: normalized.embeddingId,
        source_read_id: Number(row.source_read_id) || null,
        source_kind: normalized.sourceKind,
        relationship: normalized.relationship,
        identity_eligible: normalized.identityEligible,
        overview_context: row.overview_context || null,
        source_path_snapshot: normalized.sourcePathSnapshot,
        source_updated_at: normalized.sourceUpdatedAt,
        link_updated_at: normalized.linkUpdatedAt,
        crop_evidence_fingerprint: normalized.derivativeId
          ? cropFingerprints.get(normalized.derivativeId) || null : null,
        evidence_fingerprint: evidenceFingerprint,
      };
    });
    for (const batch of chunks(rows)) {
      await client.query(
        `INSERT INTO public.vehicle_reid_v2_conversion_read_evidence (
           run_id, read_id, read_event_identity, read_timestamp, read_created_at,
           camera_name, observed_plate, effective_plate, normalized_effective_plate,
           plate_review_status, plate_review_revision, last_plate_review_id,
           last_plate_review_action, last_plate_review_created_at, applied_alias_id,
           plate_evidence_fingerprint, vehicle_image_status,
           vehicle_image_queue_kind, vehicle_image_error_code, vehicle_image_path,
           vehicle_image_source_kind, vehicle_image_updated_at, daylight_status,
           canonical_link_state, asset_id, derivative_id, embedding_id,
           source_read_id, source_kind, relationship, identity_eligible,
           overview_context, source_path_snapshot, source_updated_at,
           link_updated_at, crop_evidence_fingerprint, evidence_fingerprint
         ) SELECT $1, rows.read_id, rows.read_event_identity,
                  rows.read_timestamp, rows.read_created_at, rows.camera_name,
                  rows.observed_plate, rows.effective_plate,
                  rows.normalized_effective_plate, rows.plate_review_status,
                  rows.plate_review_revision, rows.last_plate_review_id,
                  rows.last_plate_review_action, rows.last_plate_review_created_at,
                  rows.applied_alias_id, rows.plate_evidence_fingerprint,
                  rows.vehicle_image_status, rows.vehicle_image_queue_kind,
                  rows.vehicle_image_error_code, rows.vehicle_image_path,
                  rows.vehicle_image_source_kind, rows.vehicle_image_updated_at,
                  rows.daylight_status, rows.canonical_link_state, rows.asset_id,
                  rows.derivative_id, rows.embedding_id, rows.source_read_id,
                  rows.source_kind, rows.relationship, rows.identity_eligible,
                  rows.overview_context, rows.source_path_snapshot,
                  rows.source_updated_at, rows.link_updated_at,
                  rows.crop_evidence_fingerprint, rows.evidence_fingerprint
           FROM JSONB_TO_RECORDSET($2::jsonb) AS rows(
             read_id integer, read_event_identity varchar(80),
             read_timestamp timestamptz, read_created_at timestamptz,
             camera_name varchar(120), observed_plate varchar(10),
             effective_plate varchar(10), normalized_effective_plate varchar(32),
             plate_review_status varchar(24), plate_review_revision integer,
             last_plate_review_id bigint, last_plate_review_action varchar(24),
             last_plate_review_created_at timestamptz, applied_alias_id bigint,
             plate_evidence_fingerprint char(64), vehicle_image_status varchar(20),
             vehicle_image_queue_kind varchar(20), vehicle_image_error_code varchar(80),
             vehicle_image_path text, vehicle_image_source_kind varchar(40),
             vehicle_image_updated_at timestamptz, daylight_status varchar(12),
             canonical_link_state varchar(16), asset_id bigint, derivative_id bigint,
             embedding_id bigint, source_read_id integer, source_kind varchar(40),
             relationship varchar(24), identity_eligible boolean,
             overview_context varchar(12), source_path_snapshot text,
             source_updated_at timestamptz, link_updated_at timestamptz,
             crop_evidence_fingerprint char(64), evidence_fingerprint char(64)
           )`,
        [runId, JSON.stringify(batch)]
      );
    }
  }

  async insertV1Comparisons(client, runId, rawRows) {
    const rows = rawRows.map((row) => ({
      read_id: Number(row.read_id),
      v1_cluster_id: Number(row.v1_cluster_id) || null,
      v1_assignment_status: row.v1_assignment_status || null,
      v1_assignment_revision: Number(row.v1_assignment_revision) || null,
      v1_embedding_model: row.v1_embedding_model || null,
      v1_algorithm_version: row.v1_algorithm_version || null,
      comparison_fingerprint: hashJson({
        kind: "v1_observation_only",
        readId: Number(row.read_id),
        clusterId: Number(row.v1_cluster_id) || null,
        status: row.v1_assignment_status || null,
        revision: Number(row.v1_assignment_revision) || null,
        embeddingModel: row.v1_embedding_model || null,
        algorithmVersion: row.v1_algorithm_version || null,
      }),
    }));
    for (const batch of chunks(rows)) {
      await client.query(
        `INSERT INTO public.vehicle_reid_v2_conversion_v1_comparisons (
           run_id, read_id, v1_cluster_id, v1_assignment_status,
           v1_assignment_revision, v1_embedding_model, v1_algorithm_version,
           comparison_fingerprint
         ) SELECT $1, rows.read_id, rows.v1_cluster_id,
                  rows.v1_assignment_status, rows.v1_assignment_revision,
                  rows.v1_embedding_model, rows.v1_algorithm_version,
                  rows.comparison_fingerprint
           FROM JSONB_TO_RECORDSET($2::jsonb) AS rows(
             read_id integer, v1_cluster_id bigint,
             v1_assignment_status varchar(20), v1_assignment_revision integer,
             v1_embedding_model varchar(80), v1_algorithm_version varchar(80),
             comparison_fingerprint char(64)
           )`,
        [runId, JSON.stringify(batch)]
      );
    }
  }

  async insertProjectedProfiles(client, runId, projection) {
    const readCounts = new Map();
    for (const disposition of projection.dispositions) {
      if (!disposition.profileKey) continue;
      readCounts.set(disposition.profileKey, (readCounts.get(disposition.profileKey) || 0) + 1);
    }
    const profileRows = projection.profiles.map((profile) => ({
      projection_key: profile.profileKey,
      profile_kind: profile.provisional ? "provisional_singleton" : "multi_member",
      evidence_basis: profile.evidenceBasis,
      representative_derivative_id: profile.representativeDerivativeId,
      representative_embedding_id: profile.representativeEmbeddingId,
      representative_source_sha256: profile.representativeSourceSha256,
      member_count: profile.memberCount,
      read_count: readCounts.get(profile.profileKey) || 0,
      anchor_plates: profile.anchorPlates,
      camera_names: [],
      overview_contexts: [...new Set(profile.members.flatMap((member) => (
        member.overviewContexts || []
      )))].sort(),
      projection_fingerprint: hashJson({
        algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
        kind: "projected_profile",
        profile,
      }),
    }));
    const ids = new Map();
    for (const batch of chunks(profileRows)) {
      const inserted = await client.query(
        `INSERT INTO public.vehicle_reid_v2_conversion_projected_profiles (
           run_id, projection_key, profile_kind, evidence_basis,
           representative_derivative_id, representative_embedding_id,
           representative_source_sha256, member_count, read_count,
           anchor_plates, camera_names, overview_contexts,
           projection_fingerprint
         ) SELECT $1, rows.projection_key, rows.profile_kind,
                  rows.evidence_basis, rows.representative_derivative_id,
                  rows.representative_embedding_id,
                  rows.representative_source_sha256, rows.member_count,
                  rows.read_count, rows.anchor_plates, rows.camera_names,
                  rows.overview_contexts, rows.projection_fingerprint
           FROM JSONB_TO_RECORDSET($2::jsonb) AS rows(
             projection_key char(64), profile_kind varchar(24),
             evidence_basis varchar(32), representative_derivative_id bigint,
             representative_embedding_id bigint,
             representative_source_sha256 char(64), member_count integer,
             read_count integer, anchor_plates jsonb, camera_names jsonb,
             overview_contexts jsonb, projection_fingerprint char(64)
           ) RETURNING id, projection_key`,
        [runId, JSON.stringify(batch)]
      );
      (inserted.rows || []).forEach((row) => ids.set(String(row.projection_key).trim(), Number(row.id)));
    }
    const memberRows = projection.profiles.flatMap((profile) => profile.members.map((member) => ({
      projected_profile_id: ids.get(profile.profileKey),
      derivative_id: member.derivativeId,
      asset_id: member.assetId,
      embedding_id: member.embeddingId,
      crop_content_sha256: member.cropContentSha256,
      embedding_sha256: member.embeddingSha256,
      evidence_basis: member.membershipBasis,
      effective_plates: member.effectivePlates,
      member_fingerprint: hashJson({
        algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
        kind: "projected_member",
        profileKey: profile.profileKey,
        derivativeId: member.derivativeId,
        assetId: member.assetId,
        embeddingId: member.embeddingId,
        cropContentSha256: member.cropContentSha256,
        embeddingSha256: member.embeddingSha256,
        evidenceBasis: member.membershipBasis,
      }),
    })));
    for (const batch of chunks(memberRows)) {
      await client.query(
        `INSERT INTO public.vehicle_reid_v2_conversion_projected_members (
           run_id, projected_profile_id, derivative_id, asset_id, embedding_id,
           crop_content_sha256, embedding_sha256, evidence_basis,
           effective_plates, member_fingerprint
         ) SELECT $1, rows.projected_profile_id, rows.derivative_id,
                  rows.asset_id, rows.embedding_id, rows.crop_content_sha256,
                  rows.embedding_sha256, rows.evidence_basis,
                  rows.effective_plates, rows.member_fingerprint
           FROM JSONB_TO_RECORDSET($2::jsonb) AS rows(
             projected_profile_id bigint, derivative_id bigint, asset_id bigint,
             embedding_id bigint, crop_content_sha256 char(64),
             embedding_sha256 char(64), evidence_basis varchar(32),
             effective_plates jsonb, member_fingerprint char(64)
           )`,
        [runId, JSON.stringify(batch)]
      );
    }
    return ids;
  }

  async insertConflicts(client, runId, projection) {
    const componentRows = projection.conflicts.map((conflict) => ({
      conflict_key: conflict.conflictKey,
      scope: conflict.reason === "missing_evidence" ? "review" : "component",
      reason: conflict.reason,
      derivative_ids: conflict.derivativeIds || [],
      read_ids: conflict.readIds || [],
      review_ids: conflict.reviewIds || [],
      effective_plates: conflict.effectivePlates || [],
      details: conflict.details || {},
    }));
    const readRows = projection.dispositions.filter((item) => (
      item.disposition === "stale" || item.reasonCode === "ambiguous_effective_plate"
    )).map((item) => {
      const reason = item.reasonCode === "ambiguous_effective_plate"
        ? "ambiguous_effective_plates" : "stale_source_link";
      return {
        conflict_key: hashJson({
          algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM,
          kind: "read_conflict",
          readId: item.readId,
          reason,
        }),
        scope: reason === "stale_source_link" ? "source_link" : "read",
        reason,
        derivative_ids: item.derivativeId ? [item.derivativeId] : [],
        read_ids: [item.readId],
        review_ids: [],
        effective_plates: item.normalizedEffectivePlate
          ? [item.normalizedEffectivePlate] : [],
        details: { dispositionReason: item.reasonCode },
      };
    });
    for (const batch of chunks([...componentRows, ...readRows])) {
      await client.query(
        `INSERT INTO public.vehicle_reid_v2_conversion_conflicts (
           run_id, conflict_key, scope, reason, derivative_ids, read_ids,
           review_ids, effective_plates, details
         ) SELECT $1, rows.conflict_key, rows.scope, rows.reason,
                  rows.derivative_ids, rows.read_ids, rows.review_ids,
                  rows.effective_plates, rows.details
           FROM JSONB_TO_RECORDSET($2::jsonb) AS rows(
             conflict_key char(64), scope varchar(20), reason varchar(48),
             derivative_ids jsonb, read_ids jsonb, review_ids jsonb,
             effective_plates jsonb, details jsonb
           )`,
        [runId, JSON.stringify(batch)]
      );
    }
  }

  async insertReadJobs(client, runId, readRows) {
    const rows = readRows.map((row) => ({
      work_key: `project-read:${Number(row.read_id)}`,
      scope_start_id: Number(row.read_id),
      scope_end_id: Number(row.read_id),
    }));
    for (const batch of chunks(rows)) {
      await client.query(
        `INSERT INTO public.vehicle_reid_v2_conversion_jobs (
           run_id, work_key, stage, scope_start_id, scope_end_id
         ) SELECT $1, rows.work_key, 'project_reads',
                  rows.scope_start_id, rows.scope_end_id
           FROM JSONB_TO_RECORDSET($2::jsonb) AS rows(
             work_key varchar(100), scope_start_id bigint, scope_end_id bigint
           )`,
        [runId, JSON.stringify(batch)]
      );
    }
  }

  async createPreview({ actor, candidateSnapshot, batchSize = 5 } = {}) {
    const operator = actorSnapshot(actor);
    const candidateRunId = Number(candidateSnapshot?.id);
    const candidateFingerprint = String(candidateSnapshot?.fingerprint || "").trim();
    if (!Number.isSafeInteger(candidateRunId) || candidateRunId <= 0
        || !/^[0-9a-f]{64}$/.test(candidateFingerprint)) {
      throw codedError(
        "VEHICLE_REID_V2_CONVERSION_CANDIDATE_REQUIRED",
        "A refreshed immutable profile-candidate snapshot is required."
      );
    }
    return this.transaction(async (client) => {
      const active = await client.query(
        `SELECT id, source_profile_candidate_run_id,
                source_profile_candidate_fingerprint,
                profile_candidate_algorithm_version
         FROM public.vehicle_reid_v2_conversion_runs
         WHERE status IN ('previewing','ready','paused','accepted','running')
         ORDER BY id DESC LIMIT 1 FOR UPDATE`
      );
      if (active.rows?.[0]) {
        return {
          runId: Number(active.rows[0].id),
          reused: true,
          candidateRunId: Number(active.rows[0].source_profile_candidate_run_id),
          candidateFingerprint: String(
            active.rows[0].source_profile_candidate_fingerprint || ""
          ).trim(),
          candidateAlgorithmVersion: active.rows[0].profile_candidate_algorithm_version,
        };
      }

      const candidateResult = await client.query(
        `SELECT id, snapshot_fingerprint, algorithm_version,
                embedding_model, embedding_algorithm_version
         FROM public.vehicle_reid_v2_profile_candidate_runs
         WHERE id = $1
         FOR SHARE`,
        [candidateRunId]
      );
      const storedCandidate = candidateResult.rows?.[0];
      if (!storedCandidate
          || String(storedCandidate.snapshot_fingerprint || "").trim() !== candidateFingerprint
          || storedCandidate.embedding_model !== EMBEDDING_MODEL
          || storedCandidate.embedding_algorithm_version !== EMBEDDING_ALGORITHM) {
        throw codedError(
          "VEHICLE_REID_V2_CONVERSION_CANDIDATE_STALE",
          "The selected immutable profile-candidate snapshot no longer matches its stored contract."
        );
      }

      const evidence = await this.captureLiveEvidence(client);
      const shadowRepository = new VehicleReidV2ShadowRepository({ executor: client });
      const [candidateSources, candidateReviews] = await Promise.all([
        shadowRepository.listCurrentSources({ limit: MAX_SOURCES }),
        shadowRepository.listPairReviewCalibration({ limit: MAX_REVIEWS + 1 }),
      ]);
      if (candidateReviews.length > MAX_REVIEWS) {
        throw codedError(
          "VEHICLE_REID_V2_CONVERSION_REVIEW_LIMIT",
          `The pair-review inventory exceeds the ${MAX_REVIEWS.toLocaleString()}-review preview bound.`
        );
      }
      const currentCandidate = buildVehicleReidV2ProfileCandidateSnapshot({
        sourceRows: candidateSources,
        reviewRows: candidateReviews,
        embeddingModel: EMBEDDING_MODEL,
        embeddingAlgorithmVersion: EMBEDDING_ALGORITHM,
      });
      if (currentCandidate.fingerprint !== candidateFingerprint
          || storedCandidate.algorithm_version !== currentCandidate.algorithmVersion) {
        throw codedError(
          "VEHICLE_REID_V2_CONVERSION_CANDIDATE_STALE",
          "Canonical or review evidence changed after the candidate snapshot. Refresh and retry."
        );
      }
      const projection = buildVehicleReidV2ConversionProjection({
        sourceRows: evidence.sourceRows,
        reviewRows: evidence.reviewRows,
        readRows: evidence.readRows,
        embeddingModel: EMBEDDING_MODEL,
        embeddingAlgorithmVersion: EMBEDDING_ALGORITHM,
      });
      const inserted = await client.query(
        `INSERT INTO public.vehicle_reid_v2_conversion_runs (
           max_read_id, max_derivative_id, max_plate_review_id,
           max_pair_review_id, crop_kind, crop_algorithm_version,
           embedding_model, embedding_algorithm_version,
           source_profile_candidate_run_id,
           source_profile_candidate_fingerprint,
           profile_candidate_algorithm_version,
           identity_evidence_fingerprint, batch_size,
           eligible_crops, exact_current_embeddings, projected_profiles,
           projected_multi_member_profiles, projected_singleton_profiles,
           projected_members, actor_user_id, actor_username,
           actor_display_name, preview_metrics
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb
         ) RETURNING id`,
        [
          evidence.maxReadId,
          evidence.maxDerivativeId,
          evidence.maxPlateReviewId,
          evidence.maxPairReviewId,
          CROP_KIND,
          CROP_ALGORITHM,
          EMBEDDING_MODEL,
          EMBEDDING_ALGORITHM,
          candidateRunId,
          candidateFingerprint,
          storedCandidate.algorithm_version,
          projection.identityEvidenceFingerprint,
          boundedBatch(batchSize),
          projection.metrics.eligibleCrops,
          projection.metrics.exactCurrentEmbeddings,
          projection.metrics.projectedProfiles,
          projection.metrics.projectedMultiMemberProfiles,
          projection.metrics.projectedSingletonProfiles,
          projection.metrics.projectedMembers,
          operator.id,
          operator.username,
          operator.displayName,
          JSON.stringify({
            ...projection.metrics,
            previewOnly: true,
            algorithmVersion: projection.algorithmVersion,
          }),
        ]
      );
      const runId = Number(inserted.rows[0].id);
      const cropFingerprints = await this.insertCropEvidence(client, runId, projection);
      await this.insertReviewEvidence(client, runId, evidence.reviewRows);
      await this.insertReadEvidence(
        client, runId, evidence.readRows, projection, cropFingerprints
      );
      await this.insertV1Comparisons(client, runId, evidence.readRows);
      await this.insertProjectedProfiles(client, runId, projection);
      await this.insertConflicts(client, runId, projection);
      await this.insertReadJobs(client, runId, evidence.readRows);
      await client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs
         SET phase = 'project_reads', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'previewing' AND phase = 'freeze'`,
        [runId]
      );
      await audit(client, {
        actor: operator,
        eventType: "vehicle.reid_v2_conversion_preview_started",
        resourceId: runId,
        metadata: {
          maxReadId: evidence.maxReadId,
          eligibleCrops: projection.metrics.eligibleCrops,
          projectedProfiles: projection.metrics.projectedProfiles,
          candidateRunId,
          candidateFingerprint,
          identityEvidenceFingerprint: projection.identityEvidenceFingerprint,
          authoritativeWrites: 0,
        },
      });
      if (evidence.readRows.length === 0) {
        await this.finalizeIfComplete(client, runId, operator);
      }
      return {
        runId,
        reused: false,
        candidateRunId,
        candidateFingerprint,
        candidateAlgorithmVersion: storedCandidate.algorithm_version,
      };
    }, {
      isolation: "REPEATABLE READ",
      sessionAdvisoryLock: "vehicle_reid_v2_conversion_preview",
    });
  }

  async frozenProjectionInputs(client, runId, readIds = null) {
    const sourceResult = await client.query(
      `SELECT crops.derivative_id, crops.asset_id, crops.derivative_kind,
              crops.crop_algorithm_version, crops.asset_source_sha256,
              crops.crop_content_sha256, crops.crop_content_sha256 AS content_sha256,
              crops.crop_storage_path, crops.embedding_id,
              crops.embedding_model, crops.embedding_algorithm_version,
              crops.embedding_source_sha256, crops.embedding_sha256,
              crops.embedding_dimensions, crops.representative_read_id,
              crops.representative_read_id AS read_id,
              crops.representative_source_kind,
              crops.representative_source_kind AS source_kind,
              crops.representative_source_path,
              crops.representative_source_updated_at::text,
              crops.representative_link_updated_at::text,
              crops.effective_plates, crops.overview_contexts,
              representative.camera_name, representative.overview_context,
              related.effective_plate_evidence,
              ARRAY(SELECT JSONB_ARRAY_ELEMENTS_TEXT(crops.effective_plates))
                AS plate_numbers
       FROM public.vehicle_reid_v2_conversion_crop_evidence crops
       LEFT JOIN public.vehicle_reid_v2_conversion_read_evidence representative
         ON representative.run_id = crops.run_id
        AND representative.read_id = crops.representative_read_id
       JOIN LATERAL (
         SELECT COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
                  'plate', reads.effective_plate,
                  'reviewStatus', reads.plate_review_status,
                  'reviewRevision', reads.plate_review_revision,
                  'readId', reads.read_id
                ) ORDER BY reads.read_id), '[]'::jsonb) AS effective_plate_evidence
         FROM public.vehicle_reid_v2_conversion_read_evidence reads
         WHERE reads.run_id = crops.run_id
           AND reads.derivative_id = crops.derivative_id
           AND reads.canonical_link_state = 'current'
       ) related ON TRUE
       WHERE crops.run_id = $1
       ORDER BY crops.derivative_id`,
      [runId]
    );
    const reviewResult = await client.query(
      `SELECT review_id, review_id AS id, revision, derivative_id_low,
              derivative_id_high, source_sha256_low, source_sha256_high,
              embedding_id_low, embedding_id_high, embedding_model,
              embedding_algorithm_version,
              embedding_algorithm_version AS algorithm_version,
              similarity_score, label, evidence_plate_low,
              evidence_plate_high, campaign_id,
              review_updated_at::text, review_updated_at::text AS updated_at
       FROM public.vehicle_reid_v2_conversion_review_evidence
       WHERE run_id = $1
       ORDER BY derivative_id_low, derivative_id_high, review_id`,
      [runId]
    );
    const readResult = await client.query(
      `SELECT reads.read_id, reads.read_event_identity,
              reads.read_timestamp::text, reads.read_created_at::text,
              reads.camera_name, reads.observed_plate,
              reads.effective_plate, reads.normalized_effective_plate,
              reads.plate_review_status, reads.plate_review_status AS review_status,
              reads.plate_review_revision,
              reads.plate_review_revision AS review_revision,
              reads.last_plate_review_id, reads.last_plate_review_action,
              reads.last_plate_review_created_at::text,
              reads.applied_alias_id, reads.vehicle_image_status,
              reads.vehicle_image_queue_kind, reads.vehicle_image_error_code,
              reads.vehicle_image_path, reads.vehicle_image_source_kind,
              reads.vehicle_image_updated_at::text, reads.daylight_status,
              reads.canonical_link_state, reads.asset_id, reads.derivative_id,
              reads.embedding_id, reads.source_read_id, reads.source_kind,
              reads.relationship, reads.identity_eligible, reads.overview_context,
              reads.source_path_snapshot, reads.source_updated_at::text,
              reads.link_updated_at::text,
              reads.vehicle_image_queue_kind IN ('historical','overview_backfill')
                OR reads.source_kind = 'entry_overview_history' AS historical,
              v1.v1_cluster_id, v1.v1_assignment_status,
              v1.v1_assignment_revision, v1.v1_embedding_model,
              v1.v1_algorithm_version
       FROM public.vehicle_reid_v2_conversion_read_evidence reads
       LEFT JOIN public.vehicle_reid_v2_conversion_v1_comparisons v1
         ON v1.run_id = reads.run_id AND v1.read_id = reads.read_id
       WHERE reads.run_id = $1
         AND ($2::integer[] IS NULL OR reads.read_id = ANY($2::integer[]))
       ORDER BY reads.read_id`,
      [runId, readIds]
    );
    const assetReadCountResult = await client.query(
      `SELECT asset_id, COUNT(*)::integer AS read_count
       FROM public.vehicle_reid_v2_conversion_read_evidence
       WHERE run_id = $1 AND canonical_link_state = 'current'
         AND asset_id IS NOT NULL
       GROUP BY asset_id ORDER BY asset_id`,
      [runId]
    );
    return {
      sourceRows: sourceResult.rows || [],
      reviewRows: reviewResult.rows || [],
      readRows: readResult.rows || [],
      assetReadCounts: new Map((assetReadCountResult.rows || []).map((row) => [
        Number(row.asset_id), Number(row.read_count),
      ])),
    };
  }

  async insertDispositions(
    client,
    runId,
    projection,
    profileIds,
    identityEvidenceFingerprint = projection.identityEvidenceFingerprint
  ) {
    const rows = projection.dispositions.map((item) => ({
      read_id: item.readId,
      disposition: item.disposition,
      projected_profile_id: item.profileKey ? profileIds.get(item.profileKey) : null,
      assignment_basis: item.assignmentBasis,
      profile_evidence_basis: item.profileEvidenceBasis,
      reason_code: item.reasonCode,
      asset_id: item.assetId,
      derivative_id: item.derivativeId,
      embedding_id: item.embeddingId,
      normalized_effective_plate: item.normalizedEffectivePlate,
      historical: item.historical,
      nighttime: item.nighttime,
      disposition_fingerprint: dispositionFingerprint(identityEvidenceFingerprint, item),
    }));
    if (!rows.length) return;
    await client.query(
      `INSERT INTO public.vehicle_reid_v2_conversion_read_dispositions (
         run_id, read_id, disposition, projected_profile_id,
         assignment_basis, profile_evidence_basis, reason_code, asset_id,
         derivative_id, embedding_id, normalized_effective_plate,
         historical, nighttime, disposition_fingerprint
       ) SELECT $1, rows.read_id, rows.disposition,
                rows.projected_profile_id, rows.assignment_basis,
                rows.profile_evidence_basis, rows.reason_code, rows.asset_id,
                rows.derivative_id, rows.embedding_id,
                rows.normalized_effective_plate, rows.historical,
                rows.nighttime, rows.disposition_fingerprint
         FROM JSONB_TO_RECORDSET($2::jsonb) AS rows(
           read_id integer, disposition varchar(20), projected_profile_id bigint,
           assignment_basis varchar(32), profile_evidence_basis varchar(32),
           reason_code varchar(80), asset_id bigint, derivative_id bigint,
           embedding_id bigint, normalized_effective_plate varchar(32),
           historical boolean, nighttime boolean, disposition_fingerprint char(64)
         ) ON CONFLICT (run_id, read_id) DO NOTHING`,
      [runId, JSON.stringify(rows)]
    );
  }

  async finalizeIfComplete(client, runId, actor) {
    const outstanding = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('pending','processing')
                   OR (status = 'failed' AND retryable = TRUE AND attempt_count < 3))::integer
                AS remaining,
              COUNT(*) FILTER (WHERE status = 'failed'
                   AND (retryable = FALSE OR attempt_count >= 3))::integer AS exhausted
       FROM public.vehicle_reid_v2_conversion_jobs WHERE run_id = $1`,
      [runId]
    );
    if (Number(outstanding.rows[0].remaining) > 0) return false;
    if (Number(outstanding.rows[0].exhausted) > 0) {
      await client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs
         SET status = 'failed', last_error_code = 'PREVIEW_JOB_EXHAUSTED',
             last_error_details = $2::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [runId, JSON.stringify({ exhaustedJobs: Number(outstanding.rows[0].exhausted) })]
      );
      await audit(client, {
        actor,
        eventType: "vehicle.reid_v2_conversion_preview_failed",
        resourceId: runId,
        outcome: "failed",
        metadata: {
          errorCode: "PREVIEW_JOB_EXHAUSTED",
          exhaustedJobs: Number(outstanding.rows[0].exhausted),
          authoritativeWrites: 0,
        },
      });
      return false;
    }
    const inputs = await this.frozenProjectionInputs(client, runId);
    const projection = buildVehicleReidV2ConversionProjection({
      ...inputs,
      embeddingModel: EMBEDDING_MODEL,
      embeddingAlgorithmVersion: EMBEDDING_ALGORITHM,
    });
    const run = await client.query(
      `SELECT identity_evidence_fingerprint
       FROM public.vehicle_reid_v2_conversion_runs WHERE id = $1 FOR UPDATE`,
      [runId]
    );
    if (run.rows[0].identity_evidence_fingerprint !== projection.identityEvidenceFingerprint) {
      throw codedError(
        "VEHICLE_REID_V2_CONVERSION_FROZEN_MISMATCH",
        "Frozen evidence did not reproduce its original fingerprint."
      );
    }
    const dispositionResult = await client.query(
      `SELECT dispositions.read_id, dispositions.disposition,
              dispositions.assignment_basis, dispositions.profile_evidence_basis,
              dispositions.reason_code, dispositions.asset_id,
              dispositions.derivative_id, dispositions.embedding_id,
              dispositions.normalized_effective_plate, dispositions.historical,
              dispositions.nighttime, dispositions.disposition_fingerprint,
              profiles.projection_key
       FROM public.vehicle_reid_v2_conversion_read_dispositions dispositions
       LEFT JOIN public.vehicle_reid_v2_conversion_projected_profiles profiles
         ON profiles.id = dispositions.projected_profile_id
        AND profiles.run_id = dispositions.run_id
       WHERE dispositions.run_id = $1 ORDER BY dispositions.read_id`,
      [runId]
    );
    const expectedByRead = new Map(projection.dispositions.map((item) => [item.readId, item]));
    const dispositionsCurrent = dispositionResult.rows.length === expectedByRead.size
      && dispositionResult.rows.every((row) => {
        const observed = dispositionItemFromRow(row);
        const expected = expectedByRead.get(observed.readId);
        if (!expected || hashJson(observed) !== hashJson(expected)) return false;
        const expectedFingerprint = dispositionFingerprint(
          run.rows[0].identity_evidence_fingerprint,
          expected
        );
        return String(row.disposition_fingerprint || "").trim() === expectedFingerprint;
      });
    if (!dispositionsCurrent) {
      throw codedError(
        "VEHICLE_REID_V2_CONVERSION_INCOMPLETE",
        "Frozen read dispositions do not exactly reproduce the full preview projection."
      );
    }
    const metrics = projection.metrics;
    await client.query(
      `UPDATE public.vehicle_reid_v2_conversion_runs
       SET status = 'ready', phase = 'revalidate', preview_fingerprint = $2,
           comparison_fingerprint = $3,
           assigned_reads = $4, canonical_image_assignments = $5,
           shared_asset_assignments = $6, exact_plate_only_assignments = $7,
           historical_exact_plate_assignments = $8,
           nighttime_exact_plate_assignments = $9,
           conflicted_components = $10, conflicted_reads = $11,
           unassigned_reads = $12, stale_evidence_reads = $13,
           v1_assigned_reads = $14, v1_only_reads = $15,
           v2_only_reads = $16, both_assigned_reads = $17,
           neither_assigned_reads = $18, preview_metrics = $19::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        runId,
        projection.previewFingerprint,
        hashJson({ algorithm: VEHICLE_REID_V2_CONVERSION_ALGORITHM, comparison: {
          v1AssignedReads: metrics.v1AssignedReads,
          bothAssignedReads: metrics.bothAssignedReads,
          v1OnlyReads: metrics.v1OnlyReads,
          v2OnlyReads: metrics.v2OnlyReads,
          neitherAssignedReads: metrics.neitherAssignedReads,
          exactPartitionMatches: metrics.exactPartitionMatches,
          v1ClusterSplits: metrics.v1ClusterSplits,
          projectedV2Merges: metrics.projectedV2Merges,
          sameInBothPairs: metrics.sameInBothPairs,
          v1SameV2DifferentPairs: metrics.v1SameV2DifferentPairs,
          v2SameV1DifferentPairs: metrics.v2SameV1DifferentPairs,
        } }),
        metrics.assignedReads,
        metrics.canonicalImageAssignments,
        metrics.sharedAssetAssignments,
        metrics.exactPlateOnlyAssignments,
        metrics.historicalExactPlateAssignments,
        metrics.nighttimeExactPlateAssignments,
        metrics.conflictedComponents,
        metrics.conflictedReads,
        metrics.unassignedReads,
        metrics.staleEvidenceReads,
        metrics.v1AssignedReads,
        metrics.v1OnlyReads,
        metrics.v2OnlyReads,
        metrics.bothAssignedReads,
        metrics.neitherAssignedReads,
        JSON.stringify(metrics),
      ]
    );
    await audit(client, {
      actor,
      eventType: "vehicle.reid_v2_conversion_preview_ready",
      resourceId: runId,
      metadata: {
        previewFingerprint: projection.previewFingerprint,
        identityEvidenceFingerprint: projection.identityEvidenceFingerprint,
        projectedProfiles: metrics.projectedProfiles,
        assignedReads: metrics.assignedReads,
        unassignedReads: metrics.unassignedReads,
        authoritativeWrites: 0,
      },
    });
    return true;
  }

  async processPreviewBatch({ runId, limit = 5, actor } = {}) {
    const operator = actorSnapshot(actor);
    const normalizedRunId = Number(runId);
    const batch = boundedBatch(limit);
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('vehicle_reid_v2_conversion_preview'))");
      const run = await client.query(
        `SELECT id, status, identity_evidence_fingerprint
         FROM public.vehicle_reid_v2_conversion_runs
         WHERE id = $1 FOR UPDATE`,
        [normalizedRunId]
      );
      if (!run.rows?.[0]) throw codedError("VEHICLE_REID_V2_CONVERSION_NOT_FOUND", "Preview run not found.");
      if (run.rows[0].status !== "previewing") {
        throw codedError(
          "VEHICLE_REID_V2_CONVERSION_NOT_PROCESSING",
          "Only an active preview can process another batch."
        );
      }
      const selected = await client.query(
        `SELECT id, scope_start_id AS read_id
         FROM public.vehicle_reid_v2_conversion_jobs
         WHERE run_id = $1 AND stage = 'project_reads'
           AND (status = 'pending' OR (
             status = 'failed' AND retryable = TRUE AND attempt_count < 3
             AND COALESCE(next_attempt_at, CURRENT_TIMESTAMP) <= CURRENT_TIMESTAMP
           ))
         ORDER BY scope_start_id, id
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [normalizedRunId, batch]
      );
      const jobs = selected.rows || [];
      if (!jobs.length) {
        const finalized = await this.finalizeIfComplete(client, normalizedRunId, operator);
        return { processed: 0, finalized };
      }
      const claimToken = randomUUID();
      const jobIds = jobs.map((job) => Number(job.id));
      await client.query(
        `UPDATE public.vehicle_reid_v2_conversion_jobs
         SET status = 'processing', attempt_count = attempt_count + 1,
             claim_token = $2::uuid, heartbeat_at = CURRENT_TIMESTAMP,
             processing_deadline_at = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
             next_attempt_at = NULL, error_code = NULL, error_details = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1::bigint[])`,
        [jobIds, claimToken]
      );
      await client.query("SAVEPOINT reid_v2_conversion_batch_work");
      try {
        const readIds = jobs.map((job) => Number(job.read_id));
        const inputs = await this.frozenProjectionInputs(client, normalizedRunId, readIds);
        const projection = buildVehicleReidV2ConversionProjection({
          ...inputs,
          embeddingModel: EMBEDDING_MODEL,
          embeddingAlgorithmVersion: EMBEDDING_ALGORITHM,
        });
        const profiles = await client.query(
          `SELECT id, projection_key
           FROM public.vehicle_reid_v2_conversion_projected_profiles WHERE run_id = $1`,
          [normalizedRunId]
        );
        const profileIds = new Map((profiles.rows || []).map((row) => [
          String(row.projection_key).trim(), Number(row.id),
        ]));
        await this.insertDispositions(
          client,
          normalizedRunId,
          projection,
          profileIds,
          String(run.rows[0].identity_evidence_fingerprint).trim()
        );
        await client.query(
          `UPDATE public.vehicle_reid_v2_conversion_jobs
           SET status = 'ready', processed_count = 1, claim_token = NULL,
               processing_deadline_at = NULL, heartbeat_at = CURRENT_TIMESTAMP,
               completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ANY($1::bigint[]) AND claim_token = $2::uuid`,
          [jobIds, claimToken]
        );
        const finalized = await this.finalizeIfComplete(client, normalizedRunId, operator);
        await client.query("RELEASE SAVEPOINT reid_v2_conversion_batch_work");
        return { processed: jobs.length, finalized };
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT reid_v2_conversion_batch_work");
        const errorCode = String(error?.code || "PREVIEW_BATCH_FAILED").slice(0, 80);
        const errorMessage = String(error?.message || "Preview batch failed.").slice(0, 1000);
        await client.query(
          `UPDATE public.vehicle_reid_v2_conversion_jobs
           SET status = 'failed', claim_token = NULL,
               processing_deadline_at = NULL, error_code = $3,
               error_details = $4::jsonb, next_attempt_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ANY($1::bigint[]) AND claim_token = $2::uuid`,
          [jobIds, claimToken, errorCode, JSON.stringify({ message: errorMessage })]
        );
        await audit(client, {
          actor: operator,
          eventType: "vehicle.reid_v2_conversion_preview_batch_failed",
          resourceId: normalizedRunId,
          outcome: "failed",
          metadata: { jobIds, errorCode, authoritativeWrites: 0 },
        });
        const finalized = await this.finalizeIfComplete(client, normalizedRunId, operator);
        return {
          processed: 0,
          failed: jobs.length,
          finalized,
          error: { code: errorCode, message: errorMessage },
        };
      }
    });
  }

  async setPaused({ runId, paused, actor } = {}) {
    const operator = actorSnapshot(actor);
    return this.transaction(async (client) => {
      const result = paused
        ? await client.query(
          `UPDATE public.vehicle_reid_v2_conversion_runs
           SET status = 'paused', resume_status = 'previewing',
               paused_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status = 'previewing' RETURNING id`,
          [Number(runId)]
        )
        : await client.query(
          `UPDATE public.vehicle_reid_v2_conversion_runs
           SET status = 'previewing', resume_status = NULL, paused_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status = 'paused' AND resume_status = 'previewing'
           RETURNING id`,
          [Number(runId)]
        );
      if (!result.rows?.[0]) throw codedError("VEHICLE_REID_V2_CONVERSION_STATE", "Preview state changed; refresh and retry.");
      await audit(client, {
        actor: operator,
        eventType: paused
          ? "vehicle.reid_v2_conversion_preview_paused"
          : "vehicle.reid_v2_conversion_preview_resumed",
        resourceId: runId,
      });
      return true;
    });
  }

  async cancel({ runId, actor } = {}) {
    const operator = actorSnapshot(actor);
    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle_reid_v2_conversion_preview'))"
      );
      const result = await client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs runs
         SET status = 'cancelled', resume_status = NULL,
             cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE runs.id = $1 AND runs.status IN ('previewing','ready','paused')
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_reid_v2_conversion_jobs jobs
             WHERE jobs.run_id = runs.id AND jobs.status = 'processing'
           ) RETURNING id`,
        [Number(runId)]
      );
      if (!result.rows?.[0]) throw codedError("VEHICLE_REID_V2_CONVERSION_STATE", "Preview cannot be cancelled in its current state.");
      await client.query(
        `UPDATE public.vehicle_reid_v2_conversion_jobs
         SET status = 'cancelled', retryable = FALSE, next_attempt_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE run_id = $1 AND status IN ('pending','failed')`,
        [Number(runId)]
      );
      await audit(client, {
        actor: operator,
        eventType: "vehicle.reid_v2_conversion_preview_cancelled",
        resourceId: runId,
      });
      return true;
    });
  }

  async retryJob({ jobId, actor } = {}) {
    const operator = actorSnapshot(actor);
    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle_reid_v2_conversion_preview'))"
      );
      const result = await client.query(
        `UPDATE public.vehicle_reid_v2_conversion_jobs jobs
         SET status = 'pending', attempt_count = 0,
             operator_retry_count = operator_retry_count + 1,
             retryable = TRUE, next_attempt_at = CURRENT_TIMESTAMP,
             error_code = NULL, error_details = NULL,
             updated_at = CURRENT_TIMESTAMP
         FROM public.vehicle_reid_v2_conversion_runs runs
         WHERE jobs.id = $1 AND runs.id = jobs.run_id
           AND runs.status IN ('previewing','failed')
           AND runs.phase = 'project_reads'
           AND jobs.stage = 'project_reads'
           AND jobs.status = 'failed' AND jobs.attempt_count >= 3
           AND jobs.operator_retry_count < 1
           AND NOT EXISTS (
             SELECT 1 FROM public.vehicle_reid_v2_conversion_runs newer
             WHERE newer.id > runs.id
           )
         RETURNING jobs.run_id`,
        [Number(jobId)]
      );
      if (!result.rows?.[0]) throw codedError("VEHICLE_REID_V2_CONVERSION_RETRY", "This job is not eligible for its one operator retry.");
      const runId = Number(result.rows[0].run_id);
      await client.query(
        `UPDATE public.vehicle_reid_v2_conversion_runs
         SET status = 'previewing', last_error_code = NULL,
             last_error_details = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'failed'`,
        [runId]
      );
      await audit(client, {
        actor: operator,
        eventType: "vehicle.reid_v2_conversion_preview_job_retried",
        resourceId: runId,
        metadata: { jobId: Number(jobId), boundedOperatorRetry: 1 },
      });
      return runId;
    });
  }

  async verifyCurrent({ runId, previewFingerprint, actor } = {}) {
    const operator = actorSnapshot(actor);
    const normalizedRunId = Number(runId);
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT id, status, max_read_id, identity_evidence_fingerprint,
                preview_fingerprint
         FROM public.vehicle_reid_v2_conversion_runs WHERE id = $1 FOR UPDATE`,
        [normalizedRunId]
      );
      const run = selected.rows?.[0];
      if (!run || run.status !== "ready") {
        throw codedError("VEHICLE_REID_V2_CONVERSION_STATE", "Only a ready preview can be revalidated.");
      }
      if (String(previewFingerprint || "") !== run.preview_fingerprint) {
        throw codedError("VEHICLE_REID_V2_CONVERSION_FINGERPRINT", "The submitted preview fingerprint is stale.");
      }
      const frozenAssets = await client.query(
        `SELECT ARRAY_AGG(DISTINCT asset_id ORDER BY asset_id) AS asset_ids
         FROM public.vehicle_reid_v2_conversion_crop_evidence WHERE run_id = $1`,
        [normalizedRunId]
      );
      await client.query("SAVEPOINT reid_v2_conversion_revalidation");
      let projection;
      try {
        const live = await this.captureLiveEvidence(client, {
          maxReadId: Number(run.max_read_id),
          postBoundAssetIds: frozenAssets.rows[0]?.asset_ids || [],
        });
        projection = buildVehicleReidV2ConversionProjection({
          sourceRows: live.sourceRows,
          reviewRows: live.reviewRows,
          readRows: live.readRows,
          embeddingModel: EMBEDDING_MODEL,
          embeddingAlgorithmVersion: EMBEDDING_ALGORITHM,
        });
        await client.query("RELEASE SAVEPOINT reid_v2_conversion_revalidation");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT reid_v2_conversion_revalidation");
        const errorCode = String(error?.code || "REVALIDATION_FAILED").slice(0, 80);
        const errorMessage = String(error?.message || "Preview revalidation failed.").slice(0, 1000);
        await client.query(
          `UPDATE public.vehicle_reid_v2_conversion_runs
           SET last_revalidation_status = 'failed',
               last_revalidation_fingerprint = NULL,
               last_revalidation_error_code = $2,
               last_revalidated_at = CURRENT_TIMESTAMP,
               last_error_details = $3::jsonb,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status = 'ready' AND preview_fingerprint = $4`,
          [
            normalizedRunId,
            errorCode,
            JSON.stringify({ message: errorMessage }),
            run.preview_fingerprint,
          ]
        );
        await audit(client, {
          actor: operator,
          eventType: "vehicle.reid_v2_conversion_preview_verification_failed",
          resourceId: normalizedRunId,
          outcome: "failed",
          metadata: { errorCode, authoritativeWrites: 0 },
        });
        return { current: false, failed: true, errorCode };
      }
      const current = projection.identityEvidenceFingerprint === run.identity_evidence_fingerprint
        && projection.previewFingerprint === run.preview_fingerprint;
      if (!current) {
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
          [normalizedRunId, JSON.stringify({
            expectedIdentityEvidenceFingerprint: run.identity_evidence_fingerprint,
            currentIdentityEvidenceFingerprint: projection.identityEvidenceFingerprint,
            expectedPreviewFingerprint: run.preview_fingerprint,
            currentPreviewFingerprint: projection.previewFingerprint,
          }), projection.identityEvidenceFingerprint]
        );
        await audit(client, {
          actor: operator,
          eventType: "vehicle.reid_v2_conversion_preview_stale",
          resourceId: normalizedRunId,
          outcome: "failed",
          metadata: { currentIdentityEvidenceFingerprint: projection.identityEvidenceFingerprint },
        });
        return { current: false };
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
        [normalizedRunId, projection.identityEvidenceFingerprint]
      );
      await audit(client, {
        actor: operator,
        eventType: "vehicle.reid_v2_conversion_preview_verified_current",
        resourceId: normalizedRunId,
        metadata: {
          previewFingerprint: run.preview_fingerprint,
          identityEvidenceFingerprint: projection.identityEvidenceFingerprint,
          authoritativeWrites: 0,
        },
      });
      return { current: true };
    }, {
      isolation: "REPEATABLE READ",
      sessionAdvisoryLock: "vehicle_reid_v2_conversion_preview",
    });
  }

  async getOverview() {
    const [controlResult, authorityResult, runResult] = await Promise.all([
      this.query(
        `SELECT mode, previous_mode, revision, transition_reason,
                transitioned_at::text
         FROM public.vehicle_reid_control WHERE singleton = TRUE`
      ),
      this.query(
        `SELECT (SELECT COUNT(*) FROM public.vehicle_reid_v2_profiles)::integer
                  AS profiles,
                (SELECT COUNT(*) FROM public.vehicle_reid_v2_profile_members)::integer
                  AS members,
                (SELECT COUNT(*) FROM public.vehicle_reid_v2_read_assignments)::integer
                  AS assignments`
      ),
      this.query(
        `SELECT runs.*,
                runs.created_at::text AS created_at,
                runs.updated_at::text AS updated_at,
                runs.paused_at::text AS paused_at,
                runs.cancelled_at::text AS cancelled_at,
                runs.completed_at::text AS completed_at,
                runs.stale_at::text AS stale_at,
                runs.last_revalidated_at::text AS last_revalidated_at
         FROM public.vehicle_reid_v2_conversion_runs runs
         ORDER BY id DESC LIMIT 1`
      ),
    ]);
    const run = runResult.rows?.[0] || null;
    let counts = null;
    let retryCandidates = [];
    let sampleProfiles = [];
    let conflicts = [];
    if (run) {
      const [countResult, retryResult, profileResult, conflictResult] = await Promise.all([
        this.query(
          `SELECT COUNT(*)::integer AS total,
                  COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
                  COUNT(*) FILTER (WHERE status = 'processing')::integer AS processing,
                  COUNT(*) FILTER (WHERE status = 'ready')::integer AS ready,
                  COUNT(*) FILTER (WHERE status = 'failed' AND retryable = TRUE
                    AND attempt_count < 3)::integer AS retryable,
                  COUNT(*) FILTER (WHERE status = 'failed' AND (
                    retryable = FALSE OR attempt_count >= 3))::integer AS failed
           FROM public.vehicle_reid_v2_conversion_jobs WHERE run_id = $1`,
          [Number(run.id)]
        ),
        this.query(
          `SELECT id AS job_id, scope_start_id AS read_id, attempt_count,
                  operator_retry_count, error_code,
                  error_details->>'message' AS error_message
           FROM public.vehicle_reid_v2_conversion_jobs
           WHERE run_id = $1 AND status = 'failed'
             AND stage = 'project_reads'
             AND attempt_count >= 3 AND operator_retry_count < 1
           ORDER BY scope_start_id, id LIMIT 12`,
          [Number(run.id)]
        ),
        this.query(
          `SELECT id, projection_key, profile_kind, evidence_basis,
                  representative_derivative_id, member_count, read_count,
                  anchor_plates
           FROM public.vehicle_reid_v2_conversion_projected_profiles
           WHERE run_id = $1
           ORDER BY member_count DESC, read_count DESC, id LIMIT 12`,
          [Number(run.id)]
        ),
        this.query(
          `SELECT conflict_key, scope, reason, derivative_ids, read_ids,
                  review_ids, effective_plates, details
           FROM public.vehicle_reid_v2_conversion_conflicts
           WHERE run_id = $1 ORDER BY id LIMIT 12`,
          [Number(run.id)]
        ),
      ]);
      counts = countResult.rows?.[0] || {};
      retryCandidates = retryResult.rows || [];
      sampleProfiles = profileResult.rows || [];
      conflicts = conflictResult.rows || [];
    }
    return {
      control: controlResult.rows?.[0] || null,
      authority: authorityResult.rows?.[0] || { profiles: 0, members: 0, assignments: 0 },
      latestRun: run ? { ...run, counts } : null,
      retryCandidates,
      sampleProfiles,
      conflicts,
    };
  }
}

export const vehicleReidV2ConversionRepositoryInternals = Object.freeze({
  CROP_ALGORITHM,
  CROP_KIND,
  EMBEDDING_ALGORITHM,
  EMBEDDING_MODEL,
  MAX_READS,
  MAX_SOURCES,
  actorSnapshot,
  boundedBatch,
  currentLinkPredicate,
});
