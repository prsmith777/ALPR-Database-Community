const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const OVERVIEW_ASSET_SOURCE_KINDS = Object.freeze([
  "overview_primary",
  "entry_overview_primary",
  "overview_fallback",
  "overview_pair_share",
  "entry_overview_route_fallback",
  "entry_overview_history",
]);

const SOURCE_KIND_DETAILS = new Map([
  ["overview_primary", {
    overviewContext: "street",
    relationship: "primary",
    identityEligible: true,
  }],
  ["entry_overview_primary", {
    overviewContext: "entry",
    relationship: "primary",
    identityEligible: true,
  }],
  ["overview_fallback", {
    overviewContext: "street",
    relationship: "fallback",
    identityEligible: true,
  }],
  ["overview_pair_share", {
    overviewContext: "street",
    relationship: "shared",
    identityEligible: true,
  }],
  ["entry_overview_route_fallback", {
    overviewContext: "entry",
    relationship: "display_fallback",
    identityEligible: false,
  }],
  ["entry_overview_history", {
    overviewContext: "entry",
    relationship: "history",
    identityEligible: true,
  }],
]);

function text(value) {
  return String(value ?? "").trim();
}

export function overviewAssetCandidateReason(read) {
  if (!read) return "read_missing";
  if (read.vehicle_image_status !== "ready") return "vehicle_image_not_ready";
  if (!text(read.vehicle_image_path)) return "vehicle_image_path_missing";
  if (!SOURCE_KIND_DETAILS.has(text(read.vehicle_image_source_kind))) {
    return "source_kind_not_eligible";
  }
  return null;
}

export function isOverviewAssetCandidate(read) {
  return overviewAssetCandidateReason(read) == null;
}

export function overviewAssetSourceDetails(sourceKind) {
  const details = SOURCE_KIND_DETAILS.get(text(sourceKind));
  return details ? { ...details } : null;
}

export function canonicalVehicleImageAssetPath(contentSha256) {
  const hash = text(contentSha256);
  if (!SHA256_PATTERN.test(hash)) {
    const error = new Error("Vehicle image asset identity must be a lowercase SHA-256 digest");
    error.code = "INVALID_VEHICLE_IMAGE_ASSET_HASH";
    throw error;
  }
  return `derived/vehicle-assets/${hash.slice(0, 2)}/${hash}.jpg`;
}

export function overviewSourceCameraName(read) {
  const metadata = read?.vehicle_image_selection_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  for (const candidate of [
    metadata.sourceCameraName,
    metadata.sourceSelection?.sourceCameraName,
    metadata.payloadSelection?.sourceCameraName,
  ]) {
    const name = text(candidate);
    if (name) return name;
  }
  return null;
}
