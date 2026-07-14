export const SESSION_VERIFY_TIMEOUT_MS = 5000;
export const API_KEY_VERIFY_TIMEOUT_MS = 5000;

export function getBearerApiKey(headers) {
  const value = headers.get("authorization");
  if (!value || !value.toLowerCase().startsWith("bearer ")) return null;
  return value.slice(7).trim() || null;
}

export function getHeaderApiKey(headers) {
  return headers.get("x-api-key") || getBearerApiKey(headers);
}

export function hasQueryApiKey(url) {
  return new URL(url).searchParams.has("api_key");
}

export function isApiRoute(pathname) {
  return pathname.startsWith("/api/");
}

export function jsonAuthError(status, message) {
  return Response.json({ error: message }, { status });
}

export function isProtectedApiPath(pathname) {
  return (
    isApiRoute(pathname) &&
    ![
      "/api/plate-reads",
      "/api/verify-session",
      "/api/health-check",
      "/api/verify-key",
      "/api/check-update",
      "/api/test",
    ].some((path) => pathname.startsWith(path))
  );
}

export function verificationFailureStatus(responseStatus) {
  return responseStatus >= 500 ? 503 : 401;
}
