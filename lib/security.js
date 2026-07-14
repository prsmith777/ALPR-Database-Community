export const SESSION_COOKIE_NAME = "session";
export const SESSION_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

export function isSecureSessionCookieEnabled() {
  return process.env.SESSION_COOKIE_SECURE === "true";
}

export function getSessionCookieOptions(overrides = {}) {
  return {
    httpOnly: true,
    secure: isSecureSessionCookieEnabled(),
    sameSite: "lax",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    path: "/",
    ...overrides,
  };
}

export function getSessionCookieDeleteOptions() {
  return getSessionCookieOptions({ maxAge: 0 });
}

const SECRET_QUERY_PARAMS = new Set([
  "api_key",
  "apikey",
  "apiKey",
  "key",
  "token",
  "session",
  "sessionId",
]);

export function sanitizeUrlForLog(input) {
  const url = new URL(input, "http://localhost");
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_PARAMS.has(key)) {
      url.searchParams.set(key, "[REDACTED]");
    }
  }
  return `${url.pathname}${url.search}`;
}

export function logSafeRequest(request) {
  console.log(`${request.method} ${sanitizeUrlForLog(request.url)}`);
}
