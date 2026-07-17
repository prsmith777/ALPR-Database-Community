const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_PLATE_CHARACTERS = /[^A-Z0-9]/g;
const NON_CAMERA_KEY_CHARACTERS = /[^a-z0-9]+/g;

/**
 * Convert an OCR plate value into a stable comparison form.
 * Historical evidence should continue storing the original OCR value; this
 * normalized value is only for matching and rule evaluation.
 */
export function normalizePlate(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toUpperCase()
    .replace(NON_PLATE_CHARACTERS, "");
}

/**
 * Generate a suggested stable MQTT key from a Blue Iris camera name.
 * Camera keys are stored separately from display names so renaming a camera
 * does not silently create a new MQTT topic.
 */
export function normalizeCameraKey(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(NON_CAMERA_KEY_CHARACTERS, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
}

export function isValidCameraKey(value) {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(
    String(value ?? "")
  );
}
