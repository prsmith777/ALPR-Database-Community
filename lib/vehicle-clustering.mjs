import { cosineSimilarity, decodeVehicleEmbedding } from "./vehicle-reid.mjs";

export const VEHICLE_CLUSTER_ALGORITHM = "vehicle-reid-shadow-cluster-v1";
export const DEFAULT_CLUSTER_SIMILARITY = 0.9;
export const DEFAULT_CLUSTER_MARGIN = 0.03;

export function chooseShadowCluster({
  embedding,
  candidates = [],
  minimumSimilarity = DEFAULT_CLUSTER_SIMILARITY,
  minimumMargin = DEFAULT_CLUSTER_MARGIN,
} = {}) {
  const source = embedding instanceof Float32Array ? embedding : decodeVehicleEmbedding(embedding);
  if (!source) return { decision: "seed", clusterId: null, similarity: null, margin: null };
  const ranked = candidates.map((candidate) => {
    const target = candidate.embedding instanceof Float32Array
      ? candidate.embedding
      : decodeVehicleEmbedding(candidate.vehicle_embedding ?? candidate.embedding);
    return target ? {
      clusterId: Number(candidate.cluster_id ?? candidate.clusterId),
      similarity: cosineSimilarity(source, target),
    } : null;
  }).filter((candidate) => candidate && Number.isSafeInteger(candidate.clusterId) && Number.isFinite(candidate.similarity))
    .sort((left, right) => right.similarity - left.similarity);
  const best = ranked[0];
  if (!best) return { decision: "seed", clusterId: null, similarity: null, margin: null };
  const margin = best.similarity - (ranked[1]?.similarity ?? 0);
  if (best.similarity < minimumSimilarity || margin < minimumMargin) {
    return {
      decision: "seed",
      clusterId: null,
      similarity: Number(best.similarity.toFixed(6)),
      margin: Number(margin.toFixed(6)),
    };
  }
  return {
    decision: "suggest",
    clusterId: best.clusterId,
    similarity: Number(best.similarity.toFixed(6)),
    margin: Number(margin.toFixed(6)),
  };
}

export function normalizeClusterReviewDecision(value) {
  const decision = String(value || "").trim().toLowerCase();
  if (!new Set(["confirm", "separate"]).has(decision)) {
    const error = new Error("Choose Confirm vehicle or Different vehicle.");
    error.code = "INVALID_VEHICLE_CLUSTER_REVIEW";
    throw error;
  }
  return decision;
}
