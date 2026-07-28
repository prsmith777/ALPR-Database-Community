function textOrNull(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function parseBlueIrisAlertPointer({ clip, path, camera } = {}) {
  const alertClip = textOrNull(clip);
  const alertPath = textOrNull(path);
  const cameraName = textOrNull(camera);
  const rawOffset = alertPath?.split(".")[2] ?? null;
  const numericOffset = Number(rawOffset);
  const offsetMs = rawOffset !== null && Number.isFinite(numericOffset)
    ? Math.max(0, Math.trunc(numericOffset))
    : null;

  let playbackPath = null;
  if (alertClip && alertPath && cameraName && rawOffset) {
    const recordingId = alertClip.replace(/^@/, "");
    playbackPath = `ui3.htm?rec=${encodeURIComponent(recordingId)}-${encodeURIComponent(rawOffset)}&cam=${encodeURIComponent(cameraName)}`;
  }

  return {
    alertClip,
    alertPath,
    offsetMs,
    playbackPath,
  };
}

export const blueIrisAlertPointerInternals = Object.freeze({ textOrNull });
