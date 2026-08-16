import {
  VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
  VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE,
  VEHICLE_ASSET_COLOR_ATTRIBUTE,
} from "./vehicle-asset-attribute-contract.mjs";
import {
  VEHICLE_ASSET_EMBEDDING_ALGORITHM,
  VEHICLE_ASSET_EMBEDDING_MODEL,
} from "./vehicle-asset-embedding-contract.mjs";
import {
  VEHICLE_IMAGE_CROP_ALGORITHM,
  VEHICLE_IMAGE_CROP_KIND,
} from "./vehicle-image-crop.mjs";
import { VehicleReidV2ReviewError } from "./vehicle-reid-v2-review.mjs";

const MAX_SCAN_SOURCES = 10_000;

function positiveLimit(value) {
  const parsed = Number.parseInt(String(value ?? MAX_SCAN_SOURCES), 10);
  return Math.min(MAX_SCAN_SOURCES, Math.max(1, parsed || MAX_SCAN_SOURCES));
}

function currentLinkPredicate(links = "links", reads = "reads") {
  return `${links}.identity_eligible = TRUE
    AND ${reads}.vehicle_image_status = 'ready'
    AND ${reads}.vehicle_image_path = ${links}.source_path_snapshot
    AND ${reads}.vehicle_image_source_kind = ${links}.source_kind
    AND ${reads}.vehicle_image_updated_at IS NOT DISTINCT FROM ${links}.source_updated_at`;
}

const CURRENT_SOURCES_CTE = `WITH current_sources AS (
  SELECT derivatives.id AS derivative_id,
         derivatives.asset_id,
         derivatives.storage_path,
         derivatives.content_sha256,
         derivatives.image_width,
         derivatives.image_height,
         derivatives.created_at::text AS derivative_created_at,
         embeddings.id AS embedding_id,
         embeddings.embedding,
         embeddings.model_name,
         embeddings.algorithm_version AS embedding_algorithm_version,
         evidence.read_id,
         evidence.plate_number,
         evidence.observed_plate,
         evidence.camera_name,
         evidence.read_timestamp,
         evidence.overview_context,
         evidence.source_kind,
         related.plate_numbers,
         related.camera_names,
         related.cluster_ids,
         related.lpr_evidence,
         companions.lpr_evidence AS companion_lpr_evidence,
         color.status AS color_status,
         color.attribute_value AS color_value,
         color.confidence AS color_confidence,
         body.status AS body_type_status,
         body.attribute_value AS body_type_value,
         body.confidence AS body_type_confidence
  FROM public.vehicle_image_derivatives derivatives
  JOIN public.vehicle_asset_embeddings embeddings
    ON embeddings.derivative_id = derivatives.id
   AND embeddings.model_name = $3
   AND embeddings.algorithm_version = $4
   AND embeddings.source_sha256 = derivatives.content_sha256
  JOIN LATERAL (
    SELECT links.read_id,
           reads.plate_number,
           reads.observed_plate,
           reads.camera_name,
           reads.timestamp::text AS read_timestamp,
           links.overview_context,
           links.source_kind
    FROM public.vehicle_image_asset_reads links
    JOIN public.plate_reads reads ON reads.id = links.read_id
    WHERE links.asset_id = derivatives.asset_id
      AND ${currentLinkPredicate()}
    ORDER BY reads.timestamp DESC, links.read_id DESC
    LIMIT 1
  ) evidence ON TRUE
  JOIN LATERAL (
    SELECT ARRAY_AGG(DISTINCT reads.plate_number ORDER BY reads.plate_number)
             AS plate_numbers,
           ARRAY_AGG(DISTINCT reads.camera_name ORDER BY reads.camera_name)
             FILTER (WHERE reads.camera_name IS NOT NULL) AS camera_names,
           ARRAY_AGG(DISTINCT assignments.cluster_id ORDER BY assignments.cluster_id)
             FILTER (WHERE assignments.cluster_id IS NOT NULL) AS cluster_ids,
           COALESCE(
             JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
               'readId', reads.id,
               'plateNumber', reads.plate_number,
               'observedPlate', reads.observed_plate,
               'imagePath', NULLIF(BTRIM(reads.image_path), ''),
               'thumbnailPath', NULLIF(BTRIM(reads.thumbnail_path), ''),
               'cameraName', reads.camera_name,
               'timestamp', reads.timestamp::text,
               'directionLabel', CASE
                 WHEN reads.bi_trigger_direction_status = 'ready'
                   THEN reads.bi_trigger_direction_label
                 WHEN direction.status = 'ready' THEN direction.direction_label
                 ELSE NULL
               END,
               'directionSource', CASE
                 WHEN reads.bi_trigger_direction_status = 'ready' THEN 'blue_iris'
                 WHEN direction.status = 'ready' THEN 'reid_v1'
                 ELSE NULL
               END,
               'reviewStatus', reads.review_status,
               'sourceKind', links.source_kind,
               'relationship', links.relationship
             )),
             '[]'::jsonb
           ) AS lpr_evidence
    FROM public.vehicle_image_asset_reads links
    JOIN public.plate_reads reads ON reads.id = links.read_id
    LEFT JOIN public.vehicle_cluster_assignments assignments
      ON assignments.read_id = reads.id
    LEFT JOIN public.vehicle_direction_observations direction
      ON direction.read_id = reads.id
    WHERE links.asset_id = derivatives.asset_id
      AND ${currentLinkPredicate()}
  ) related ON TRUE
  JOIN LATERAL (
    SELECT COALESCE(
             JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
               'readId', companion_reads.id,
               'plateNumber', companion_reads.plate_number,
               'observedPlate', companion_reads.observed_plate,
               'imagePath', NULLIF(BTRIM(companion_reads.image_path), ''),
               'thumbnailPath', NULLIF(BTRIM(companion_reads.thumbnail_path), ''),
               'cameraName', companion_reads.camera_name,
               'timestamp', companion_reads.timestamp::text,
               'directionLabel', CASE
                 WHEN companion_reads.bi_trigger_direction_status = 'ready'
                   THEN companion_reads.bi_trigger_direction_label
                 WHEN companion_direction.status = 'ready'
                   THEN companion_direction.direction_label
                 ELSE NULL
               END,
               'directionSource', CASE
                 WHEN companion_reads.bi_trigger_direction_status = 'ready'
                   THEN 'blue_iris'
                 WHEN companion_direction.status = 'ready' THEN 'reid_v1'
                 ELSE NULL
               END,
               'reviewStatus', companion_reads.review_status,
               'sourceKind', companion_links.source_kind,
               'relationship', 'shadow_event_companion',
               'eventId', events.id,
               'correlationClass', events.correlation_class
             )),
             '[]'::jsonb
           ) AS lpr_evidence
    FROM public.vehicle_image_asset_reads direct_links
    JOIN public.plate_reads direct_reads ON direct_reads.id = direct_links.read_id
    JOIN public.vehicle_event_reads direct_event
      ON direct_event.read_id = direct_reads.id
     AND direct_event.asset_id = direct_links.asset_id
     AND direct_event.active = TRUE
     AND direct_event.read_camera_name = direct_reads.camera_name
     AND direct_event.read_timestamp = direct_reads.timestamp
     AND direct_event.effective_plate_snapshot = direct_reads.plate_number
     AND direct_event.direction_status_snapshot
           IS NOT DISTINCT FROM direct_reads.bi_trigger_direction_status
     AND direct_event.direction_label_snapshot
           IS NOT DISTINCT FROM direct_reads.bi_trigger_direction_label
     AND direct_event.source_kind_snapshot = direct_links.source_kind
     AND direct_event.source_path_snapshot = direct_links.source_path_snapshot
     AND direct_event.source_updated_at_snapshot
           IS NOT DISTINCT FROM direct_links.source_updated_at
    JOIN public.vehicle_events events
      ON events.id = direct_event.event_id AND events.status = 'shadow'
    JOIN public.vehicle_event_reads companion_event
      ON companion_event.event_id = events.id
     AND companion_event.active = TRUE
     AND companion_event.read_id <> direct_event.read_id
    JOIN public.vehicle_image_asset_reads companion_links
      ON companion_links.read_id = companion_event.read_id
     AND companion_links.asset_id = companion_event.asset_id
    JOIN public.plate_reads companion_reads
      ON companion_reads.id = companion_links.read_id
     AND companion_event.read_camera_name = companion_reads.camera_name
     AND companion_event.read_timestamp = companion_reads.timestamp
     AND companion_event.effective_plate_snapshot = companion_reads.plate_number
     AND companion_event.direction_status_snapshot
           IS NOT DISTINCT FROM companion_reads.bi_trigger_direction_status
     AND companion_event.direction_label_snapshot
           IS NOT DISTINCT FROM companion_reads.bi_trigger_direction_label
     AND companion_event.source_kind_snapshot = companion_links.source_kind
     AND companion_event.source_path_snapshot = companion_links.source_path_snapshot
     AND companion_event.source_updated_at_snapshot
           IS NOT DISTINCT FROM companion_links.source_updated_at
    LEFT JOIN public.vehicle_direction_observations companion_direction
      ON companion_direction.read_id = companion_reads.id
    WHERE direct_links.asset_id = derivatives.asset_id
      AND ${currentLinkPredicate("direct_links", "direct_reads")}
      AND ${currentLinkPredicate("companion_links", "companion_reads")}
      AND companion_links.asset_id <> derivatives.asset_id
  ) companions ON TRUE
  LEFT JOIN public.vehicle_asset_attribute_observations color
    ON color.derivative_id = derivatives.id
   AND color.attribute_key = $6
   AND color.provider = $7
   AND color.model_version = $8
   AND color.algorithm_version = $5
   AND color.source_sha256 = derivatives.content_sha256
  LEFT JOIN public.vehicle_asset_attribute_observations body
    ON body.derivative_id = derivatives.id
   AND body.attribute_key = $9
   AND body.provider = $10
   AND body.model_version = $11
   AND body.algorithm_version = $5
   AND body.source_sha256 = derivatives.content_sha256
  WHERE derivatives.derivative_kind = $1
    AND derivatives.algorithm_version = $2
)`;

const SOURCE_COLUMNS = `derivative_id, asset_id, storage_path, content_sha256,
  image_width, image_height, derivative_created_at, embedding_id, embedding,
  model_name, embedding_algorithm_version, read_id, plate_number,
  observed_plate, camera_name, read_timestamp, overview_context, source_kind,
  plate_numbers, camera_names, cluster_ids, lpr_evidence,
  companion_lpr_evidence, color_status, color_value,
  color_confidence, body_type_status, body_type_value, body_type_confidence`;

function contractValues() {
  return [
    VEHICLE_IMAGE_CROP_KIND,
    VEHICLE_IMAGE_CROP_ALGORITHM,
    VEHICLE_ASSET_EMBEDDING_MODEL,
    VEHICLE_ASSET_EMBEDDING_ALGORITHM,
    VEHICLE_ASSET_ATTRIBUTE_ALGORITHM,
    VEHICLE_ASSET_COLOR_ATTRIBUTE.attributeKey,
    VEHICLE_ASSET_COLOR_ATTRIBUTE.provider,
    VEHICLE_ASSET_COLOR_ATTRIBUTE.modelVersion,
    VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE.attributeKey,
    VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE.provider,
    VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE.modelVersion,
  ];
}

export class VehicleReidV2ShadowRepository {
  constructor({ pool, executor = null } = {}) {
    if (!pool && !executor) {
      throw new Error("ReID v2 shadow repository requires a database executor");
    }
    this.pool = pool;
    this.executor = executor;
  }

  query(text, values = []) {
    return (this.executor || this.pool).query(text, values);
  }

  async listCurrentSources({ limit = MAX_SCAN_SOURCES } = {}) {
    const bounded = positiveLimit(limit);
    const result = await this.query(
      `${CURRENT_SOURCES_CTE}
       SELECT ${SOURCE_COLUMNS}, COUNT(*) OVER()::bigint AS total_sources
       FROM current_sources
       ORDER BY read_timestamp::timestamptz DESC, derivative_id DESC
       LIMIT $12`,
      [...contractValues(), bounded]
    );
    return result.rows || [];
  }

  async getCurrentSource(derivativeId) {
    const normalized = Number(derivativeId);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) return null;
    const result = await this.query(
      `${CURRENT_SOURCES_CTE}
       SELECT ${SOURCE_COLUMNS}
       FROM current_sources
       WHERE derivative_id = $12
       LIMIT 1`,
      [...contractValues(), normalized]
    );
    return result.rows?.[0] || null;
  }

  async listPairReviewsForSource({
    sourceDerivativeId,
    candidateDerivativeIds = [],
    modelName = VEHICLE_ASSET_EMBEDDING_MODEL,
    algorithmVersion = VEHICLE_ASSET_EMBEDDING_ALGORITHM,
  } = {}) {
    const source = Number(sourceDerivativeId);
    const candidates = [...new Set(candidateDerivativeIds.map(Number).filter((value) => (
      Number.isSafeInteger(value) && value > 0 && value !== source
    )))];
    if (!Number.isSafeInteger(source) || source < 1 || !candidates.length) return [];
    const result = await this.query(
      `SELECT CASE WHEN derivative_id_low = $1 THEN derivative_id_high
                   ELSE derivative_id_low END AS candidate_derivative_id,
              id, derivative_id_low, derivative_id_high, similarity_score,
              embedding_model, algorithm_version, label, revision, updated_at,
              actor_username, actor_display_name, campaign_id
       FROM public.vehicle_reid_v2_pair_reviews
       WHERE embedding_model = $2 AND algorithm_version = $3
         AND ((derivative_id_low = $1 AND derivative_id_high = ANY($4::bigint[]))
           OR (derivative_id_high = $1 AND derivative_id_low = ANY($4::bigint[])))`,
      [source, modelName, algorithmVersion, candidates]
    );
    return result.rows || [];
  }

  async listPairReviewCalibration({
    modelName = VEHICLE_ASSET_EMBEDDING_MODEL,
    algorithmVersion = VEHICLE_ASSET_EMBEDDING_ALGORITHM,
  } = {}) {
    const result = await this.query(
      `SELECT reviews.derivative_id_low, reviews.derivative_id_high,
              reviews.label, reviews.similarity_score,
              reviews.evidence_context_low, reviews.evidence_context_high,
              reviews.evidence_camera_low, reviews.evidence_camera_high,
              reviews.evidence_plate_low, reviews.evidence_plate_high,
              reviews.campaign_id,
              low_reads.timestamp::text AS evidence_timestamp_low,
              high_reads.timestamp::text AS evidence_timestamp_high,
              COALESCE(settings.local_timezone, 'America/Denver')
                AS evaluation_time_zone
       FROM public.vehicle_reid_v2_pair_reviews reviews
       LEFT JOIN public.plate_reads low_reads
         ON low_reads.id = reviews.evidence_read_id_low
       LEFT JOIN public.plate_reads high_reads
         ON high_reads.id = reviews.evidence_read_id_high
       LEFT JOIN public.mqtt_settings settings ON settings.id = 1
       WHERE reviews.embedding_model = $1 AND reviews.algorithm_version = $2
       ORDER BY reviews.updated_at DESC, reviews.id DESC`,
      [modelName, algorithmVersion]
    );
    return result.rows || [];
  }

  async savePairReview({
    derivativeIdLow,
    derivativeIdHigh,
    sourceLow,
    sourceHigh,
    similarityScore,
    label,
    actor,
    campaignId = null,
  }) {
    const connected = Boolean(this.pool?.connect);
    const client = connected ? await this.pool.connect() : this.executor;
    if (!client?.query) throw new Error("ReID v2 pair review requires a database client");
    try {
      if (connected) await client.query("BEGIN");
      const pairIdentity = `${derivativeIdLow}:${derivativeIdHigh}:${VEHICLE_ASSET_EMBEDDING_MODEL}:${VEHICLE_ASSET_EMBEDDING_ALGORITHM}`;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle_reid_v2_pair_review'), hashtext($1))",
        [pairIdentity]
      );
      const currentResult = await client.query(
        `${CURRENT_SOURCES_CTE}
         SELECT ${SOURCE_COLUMNS}
         FROM current_sources
         WHERE derivative_id = ANY($12::bigint[])
         ORDER BY derivative_id`,
        [...contractValues(), [derivativeIdLow, derivativeIdHigh]]
      );
      const current = new Map((currentResult.rows || []).map((row) => [Number(row.derivative_id), row]));
      const actualLow = current.get(Number(derivativeIdLow));
      const actualHigh = current.get(Number(derivativeIdHigh));
      const exact = actualLow && actualHigh
        && Number(actualLow.embedding_id) === Number(sourceLow.embedding_id)
        && Number(actualHigh.embedding_id) === Number(sourceHigh.embedding_id)
        && actualLow.content_sha256 === sourceLow.content_sha256
        && actualHigh.content_sha256 === sourceHigh.content_sha256
        && actualLow.model_name === VEHICLE_ASSET_EMBEDDING_MODEL
        && actualHigh.model_name === VEHICLE_ASSET_EMBEDDING_MODEL
        && actualLow.embedding_algorithm_version === VEHICLE_ASSET_EMBEDDING_ALGORITHM
        && actualHigh.embedding_algorithm_version === VEHICLE_ASSET_EMBEDDING_ALGORITHM;
      if (!exact) {
        throw new VehicleReidV2ReviewError(
          "VEHICLE_REID_V2_REVIEW_SOURCE_CHANGED",
          "One of these canonical crops is no longer current. Refresh before reviewing it."
        );
      }

      const previousResult = await client.query(
        `SELECT id, label, revision
         FROM public.vehicle_reid_v2_pair_reviews
         WHERE derivative_id_low = $1 AND derivative_id_high = $2
           AND embedding_model = $3 AND algorithm_version = $4
         FOR UPDATE`,
        [derivativeIdLow, derivativeIdHigh,
          VEHICLE_ASSET_EMBEDDING_MODEL, VEHICLE_ASSET_EMBEDDING_ALGORITHM]
      );
      const previous = previousResult.rows?.[0] || null;
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0
        ? Number(actor.id)
        : null;
      const actorUsername = String(actor?.username || "legacy-admin").slice(0, 64);
      const actorDisplayName = String(actor?.displayName || "Legacy Administrator").slice(0, 120);
      const normalizedCampaignId = Number.isSafeInteger(Number(campaignId))
        && Number(campaignId) > 0 ? Number(campaignId) : null;
      if (normalizedCampaignId) {
        const campaignResult = await client.query(
          `SELECT id, status, target_human_reviews, frozen_max_derivative_id,
                  embedding_model, algorithm_version
           FROM public.vehicle_reid_v2_review_campaigns
           WHERE id = $1
           FOR UPDATE`,
          [normalizedCampaignId]
        );
        const campaign = campaignResult.rows?.[0];
        if (
          !campaign
          || campaign.status !== "active"
          || campaign.embedding_model !== VEHICLE_ASSET_EMBEDDING_MODEL
          || campaign.algorithm_version !== VEHICLE_ASSET_EMBEDDING_ALGORITHM
          || derivativeIdLow > Number(campaign.frozen_max_derivative_id)
          || derivativeIdHigh > Number(campaign.frozen_max_derivative_id)
        ) {
          throw new VehicleReidV2ReviewError(
            "VEHICLE_REID_V2_REVIEW_CAMPAIGN_CHANGED",
            "This review campaign is no longer active for the selected crops. Refresh before continuing."
          );
        }
      }
      const result = await client.query(
        `INSERT INTO public.vehicle_reid_v2_pair_reviews (
           derivative_id_low, derivative_id_high,
           source_sha256_low, source_sha256_high,
           embedding_id_low, embedding_id_high,
           embedding_model, algorithm_version, similarity_score, label,
           evidence_read_id_low, evidence_read_id_high,
           evidence_plate_low, evidence_plate_high,
           evidence_camera_low, evidence_camera_high,
           evidence_context_low, evidence_context_high,
           actor_user_id, actor_username, actor_display_name, campaign_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18,
           $19::bigint, $20, $21, $22::bigint
         )
         ON CONFLICT (derivative_id_low, derivative_id_high, embedding_model, algorithm_version)
         DO UPDATE SET
           label = EXCLUDED.label,
           actor_user_id = EXCLUDED.actor_user_id,
           actor_username = EXCLUDED.actor_username,
           actor_display_name = EXCLUDED.actor_display_name,
           campaign_id = EXCLUDED.campaign_id,
           revision = public.vehicle_reid_v2_pair_reviews.revision + 1,
           updated_at = CURRENT_TIMESTAMP
         RETURNING id, derivative_id_low, derivative_id_high,
                   similarity_score, embedding_model, algorithm_version,
                   label, revision, updated_at, actor_username, actor_display_name,
                   campaign_id`,
        [
          derivativeIdLow,
          derivativeIdHigh,
          actualLow.content_sha256,
          actualHigh.content_sha256,
          Number(actualLow.embedding_id),
          Number(actualHigh.embedding_id),
          VEHICLE_ASSET_EMBEDDING_MODEL,
          VEHICLE_ASSET_EMBEDDING_ALGORITHM,
          Number(Number(similarityScore).toFixed(6)),
          label,
          Number(actualLow.read_id),
          Number(actualHigh.read_id),
          actualLow.plate_number || null,
          actualHigh.plate_number || null,
          actualLow.camera_name || null,
          actualHigh.camera_name || null,
          actualLow.overview_context,
          actualHigh.overview_context,
          actorId,
          actorUsername,
          actorDisplayName,
          normalizedCampaignId,
        ]
      );
      const saved = result.rows?.[0];
      await client.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id,
           outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.reid_v2_pair_review',
                   'vehicle_reid_v2_pair_review', $2, 'succeeded', $3::jsonb)`,
        [actorId, String(saved.id), JSON.stringify({
          derivativeIdLow,
          derivativeIdHigh,
          modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
          algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
          similarityScore: Number(Number(similarityScore).toFixed(6)),
          previousLabel: previous?.label || null,
          label,
          revision: Number(saved.revision),
          campaignId: normalizedCampaignId,
        })]
      );
      if (normalizedCampaignId) {
        await client.query(
          `UPDATE public.vehicle_reid_v2_review_campaigns campaigns
           SET status = 'completed',
               completed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE campaigns.id = $1 AND campaigns.status = 'active'
             AND (
               SELECT COUNT(*)
               FROM public.vehicle_reid_v2_pair_reviews reviews
               WHERE reviews.campaign_id = campaigns.id
             ) >= campaigns.target_human_reviews`,
          [normalizedCampaignId]
        );
      }
      if (connected) await client.query("COMMIT");
      return saved;
    } catch (error) {
      if (connected) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (connected) client.release();
    }
  }

  async getLatestReviewCampaign() {
    const result = await this.query(
      `SELECT campaigns.id, campaigns.status, campaigns.target_human_reviews,
              campaigns.frozen_max_derivative_id, campaigns.embedding_model,
              campaigns.algorithm_version, campaigns.actor_username,
              campaigns.actor_display_name, campaigns.created_at::text,
              campaigns.completed_at::text, campaigns.cancelled_at::text,
              COUNT(reviews.id)::bigint AS human_reviews
       FROM public.vehicle_reid_v2_review_campaigns campaigns
       LEFT JOIN public.vehicle_reid_v2_pair_reviews reviews
         ON reviews.campaign_id = campaigns.id
       GROUP BY campaigns.id
       ORDER BY (campaigns.status = 'active') DESC, campaigns.id DESC
       LIMIT 1`
    );
    return result.rows?.[0] || null;
  }

  async createReviewCampaign({
    frozenMaxDerivativeId,
    targetHumanReviews = 500,
    actor,
  } = {}) {
    const maximum = Number(frozenMaxDerivativeId);
    const target = Math.min(500, Math.max(1, Number(targetHumanReviews) || 500));
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new VehicleReidV2ReviewError(
        "VEHICLE_REID_V2_REVIEW_CAMPAIGN_EMPTY",
        "No current canonical crop inventory is available for a review campaign."
      );
    }
    const connected = Boolean(this.pool?.connect);
    const client = connected ? await this.pool.connect() : this.executor;
    if (!client?.query) throw new Error("ReID v2 review campaign requires a database client");
    try {
      if (connected) await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('vehicle_reid_v2_review_campaign'))"
      );
      const active = await client.query(
        `SELECT id FROM public.vehicle_reid_v2_review_campaigns
         WHERE status = 'active' ORDER BY id DESC LIMIT 1 FOR UPDATE`
      );
      if (active.rows?.[0]) {
        const existing = await client.query(
          `SELECT campaigns.id, campaigns.status, campaigns.target_human_reviews,
                  campaigns.frozen_max_derivative_id, campaigns.embedding_model,
                  campaigns.algorithm_version, campaigns.actor_username,
                  campaigns.actor_display_name, campaigns.created_at::text,
                  campaigns.completed_at::text, campaigns.cancelled_at::text,
                  COUNT(reviews.id)::bigint AS human_reviews
           FROM public.vehicle_reid_v2_review_campaigns campaigns
           LEFT JOIN public.vehicle_reid_v2_pair_reviews reviews
             ON reviews.campaign_id = campaigns.id
           WHERE campaigns.id = $1
           GROUP BY campaigns.id`,
          [Number(active.rows[0].id)]
        );
        if (connected) await client.query("COMMIT");
        return existing.rows?.[0] || null;
      }
      const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0
        ? Number(actor.id) : null;
      const actorUsername = String(actor?.username || "legacy-admin").slice(0, 64);
      const actorDisplayName = String(actor?.displayName || "Legacy Administrator").slice(0, 120);
      const inserted = await client.query(
        `INSERT INTO public.vehicle_reid_v2_review_campaigns (
           target_human_reviews, frozen_max_derivative_id,
           embedding_model, algorithm_version,
           actor_user_id, actor_username, actor_display_name
         ) VALUES ($1, $2, $3, $4, $5::bigint, $6, $7)
         RETURNING id`,
        [target, maximum, VEHICLE_ASSET_EMBEDDING_MODEL,
          VEHICLE_ASSET_EMBEDDING_ALGORITHM, actorId, actorUsername, actorDisplayName]
      );
      const campaignId = Number(inserted.rows?.[0]?.id);
      await client.query(
        `INSERT INTO public.audit_events (
           actor_user_id, source, event_type, resource_type, resource_id,
           outcome, metadata
         ) VALUES ($1::bigint, 'browser', 'vehicle.reid_v2_review_campaign_started',
                   'vehicle_reid_v2_review_campaign', $2, 'succeeded', $3::jsonb)`,
        [actorId, String(campaignId), JSON.stringify({
          targetHumanReviews: target,
          frozenMaxDerivativeId: maximum,
          modelName: VEHICLE_ASSET_EMBEDDING_MODEL,
          algorithmVersion: VEHICLE_ASSET_EMBEDDING_ALGORITHM,
        })]
      );
      const created = await client.query(
        `SELECT campaigns.id, campaigns.status, campaigns.target_human_reviews,
                campaigns.frozen_max_derivative_id, campaigns.embedding_model,
                campaigns.algorithm_version, campaigns.actor_username,
                campaigns.actor_display_name, campaigns.created_at::text,
                campaigns.completed_at::text, campaigns.cancelled_at::text,
                COUNT(reviews.id)::bigint AS human_reviews
         FROM public.vehicle_reid_v2_review_campaigns campaigns
         LEFT JOIN public.vehicle_reid_v2_pair_reviews reviews
           ON reviews.campaign_id = campaigns.id
         WHERE campaigns.id = $1
         GROUP BY campaigns.id`,
        [campaignId]
      );
      if (connected) await client.query("COMMIT");
      return created.rows?.[0] || null;
    } catch (error) {
      if (connected) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (connected) client.release();
    }
  }
}

export const vehicleReidV2ShadowRepositoryInternals = Object.freeze({
  CURRENT_SOURCES_CTE,
  MAX_SCAN_SOURCES,
  currentLinkPredicate,
  positiveLimit,
});
