export const VEHICLE_DISTINCTIVE_FEATURE_PROVIDER = "human-review";
export const VEHICLE_DISTINCTIVE_FEATURE_MODEL = "distinctive-features-v1";

export const VEHICLE_DISTINCTIVE_FEATURES = Object.freeze([
  { key: "roof_rack", label: "Roof rack" },
  { key: "cargo_box", label: "Roof cargo box" },
  { key: "rear_bike_rack", label: "Rear bike rack" },
  { key: "ladder_rack", label: "Ladder or utility rack" },
  { key: "toolbox", label: "Truck-bed toolbox" },
  { key: "trailer", label: "Trailer" },
  { key: "rear_spare_tire", label: "Rear spare tire" },
  { key: "bumper_sticker", label: "Bumper sticker" },
  { key: "window_sticker", label: "Window sticker or decal" },
  { key: "racing_stripe", label: "Stripe or wrap" },
  { key: "aftermarket_wheels", label: "Aftermarket wheels" },
  { key: "body_kit", label: "Body kit or aftermarket trim" },
  { key: "visible_damage", label: "Visible body damage" },
  { key: "missing_hubcap", label: "Missing hubcap" },
  { key: "temporary_plate", label: "Temporary or paper plate" },
  { key: "covered_plate", label: "Covered or obstructed plate" },
]);

const featureKeys = new Set(VEHICLE_DISTINCTIVE_FEATURES.map((feature) => feature.key));

export function normalizeDistinctiveFeatures(values) {
  if (!Array.isArray(values)) {
    const error = new Error("Distinctive vehicle features must be a list.");
    error.code = "INVALID_VEHICLE_DISTINCTIVE_FEATURES";
    throw error;
  }
  const normalized = [...new Set(values.map((value) => String(value || "").trim().toLowerCase()))]
    .filter(Boolean);
  if (normalized.some((value) => !featureKeys.has(value))) {
    const error = new Error("Choose only supported distinctive vehicle features.");
    error.code = "INVALID_VEHICLE_DISTINCTIVE_FEATURES";
    throw error;
  }
  return normalized;
}

export function distinctiveFeatureLabel(key) {
  return VEHICLE_DISTINCTIVE_FEATURES.find((feature) => feature.key === key)?.label || key;
}
