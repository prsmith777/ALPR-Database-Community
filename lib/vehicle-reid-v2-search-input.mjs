export function parseVehicleReidV2SearchId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return Object.freeze({ present: false, valid: true, value: null });
  if (!/^[1-9]\d*$/.test(raw)) {
    return Object.freeze({ present: true, valid: false, value: null });
  }
  const parsed = Number(raw);
  const valid = Number.isSafeInteger(parsed) && parsed > 0;
  return Object.freeze({
    present: true,
    valid,
    value: valid ? parsed : null,
  });
}
