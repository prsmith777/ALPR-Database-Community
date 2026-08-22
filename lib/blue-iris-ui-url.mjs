export function buildBlueIrisUiUrl(host, path) {
  const rawHost = String(host || "").trim();
  const rawPath = String(path || "").trim();
  if (!rawHost || !rawPath) return "";
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(rawPath)) return "";

  const base = /^[a-z][a-z\d+.-]*:\/\//i.test(rawHost)
    ? rawHost
    : `http://${rawHost}`;

  try {
    const normalizedBase = base.endsWith("/") ? base : `${base}/`;
    return new URL(rawPath.replace(/^\/+/, ""), normalizedBase).toString();
  } catch {
    return "";
  }
}

export function buildBlueIrisTimelinePath(camera, timestamp) {
  const cameraName = String(camera || "").trim();
  const date = new Date(timestamp || "");
  if (!cameraName || Number.isNaN(date.getTime())) return "";
  const query = new URLSearchParams({
    tab: "timeline",
    cam: cameraName,
    timeline: String(date.getTime()),
    maximize: "1",
  });
  return `ui3.htm?${query.toString()}`;
}

export function withBlueIrisCamera(path, camera) {
  const rawPath = String(path || "").trim();
  const cameraName = String(camera || "").trim();
  if (!rawPath || !cameraName || /^[a-z][a-z\d+.-]*:\/\//i.test(rawPath)) {
    return rawPath;
  }

  const hashIndex = rawPath.indexOf("#");
  const hash = hashIndex >= 0 ? rawPath.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? rawPath.slice(0, hashIndex) : rawPath;
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex < 0) return rawPath;

  const pathname = withoutHash.slice(0, queryIndex);
  const query = new URLSearchParams(withoutHash.slice(queryIndex + 1));
  query.set("cam", cameraName);
  return `${pathname}?${query.toString()}${hash}`;
}

export function buildBlueIrisPlatePlaybackPath(path, camera, timestamp) {
  const rawPath = String(path || "").trim();
  const cameraName = String(camera || "").trim();
  if (!rawPath || !cameraName || /^[a-z][a-z\d+.-]*:\/\//i.test(rawPath)) return "";

  const cameraPath = withBlueIrisCamera(rawPath, cameraName);
  try {
    const recording = new URL(cameraPath, "http://blue-iris.local/")
      .searchParams.get("rec")
      ?.split("-", 1)[0]
      ?.replace(/^@/, "");
    if (recording && /^[1-9]\d*$/.test(recording)) return cameraPath;
  } catch {
    return "";
  }

  // Some Blue Iris actions emit ALERT_CLIP=0 even though ALERT_PATH contains
  // a valid offset. UI3 interprets rec=0-offset as recording @0 and falls
  // back to the clips list, so open the plate camera timeline instead.
  return buildBlueIrisTimelinePath(cameraName, timestamp);
}
