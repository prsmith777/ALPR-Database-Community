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
