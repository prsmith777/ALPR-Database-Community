const key = value => String(value || "").trim().toLowerCase();

// A display name may be shared; only an unambiguous alias is auto-selected.
export function resolveBlueIrisCamera(cameras, alias) {
  const matches = cameras.filter(camera => key(camera.id) === key(alias) || key(camera.name) === key(alias));
  return matches.length === 1 ? matches[0] : null;
}

export function readMatchTolerance(value = 3) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) throw new Error("ALPR read tolerance must be between 1 and 30 seconds.");
  return seconds;
}
