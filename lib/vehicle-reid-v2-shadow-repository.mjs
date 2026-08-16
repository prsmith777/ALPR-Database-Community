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
             FILTER (WHERE assignments.cluster_id IS NOT NULL) AS cluster_ids
    FROM public.vehicle_image_asset_reads links
    JOIN public.plate_reads reads ON reads.id = links.read_id
    LEFT JOIN public.vehicle_cluster_assignments assignments
      ON assignments.read_id = reads.id
    WHERE links.asset_id = derivatives.asset_id
      AND ${currentLinkPredicate()}
  ) related ON TRUE
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
  plate_numbers, camera_names, cluster_ids, color_status, color_value,
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
}

export const vehicleReidV2ShadowRepositoryInternals = Object.freeze({
  CURRENT_SOURCES_CTE,
  MAX_SCAN_SOURCES,
  currentLinkPredicate,
  positiveLimit,
});
