import { NextResponse } from "next/server.js";

export const SESSION_COOKIE_NAME = "session";
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

export function shouldUseSecureCookies() {
  if (process.env.ALLOW_INSECURE_DEV_COOKIES === "true") return false;
  if (process.env.NODE_ENV === "production") return true;
  return process.env.SESSION_COOKIE_SECURE === "true";
}

export function getSessionCookieOptions(overrides = {}) {
  return { httpOnly: true, secure: shouldUseSecureCookies(), sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS, ...overrides };
}
export function setSessionCookie(cookieStore, sessionId) { cookieStore.set(SESSION_COOKIE_NAME, sessionId, getSessionCookieOptions()); }
export function clearSessionCookie(cookieStore) { cookieStore.set(SESSION_COOKIE_NAME, "", getSessionCookieOptions({ maxAge: 0, expires: new Date(0) })); }
export function clearSessionCookieOnResponse(response) { response.cookies.set(SESSION_COOKIE_NAME, "", getSessionCookieOptions({ maxAge: 0, expires: new Date(0) })); return response; }
export function jsonUnauthorized(message = "Unauthorized") { return NextResponse.json({ error: message }, { status: 401 }); }
export function jsonAuthUnavailable() { return NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503 }); }
export function redirectToLogin(request, { clearCookie = false } = {}) { const response = NextResponse.redirect(new URL("/login", request.url)); return clearCookie ? clearSessionCookieOnResponse(response) : response; }
export function extractApiKey(request) {
  const url = new URL(request.url);
  if (url.searchParams.has("api_key")) return { rejectedQueryApiKey: true };
  const headerKey = request.headers.get("x-api-key");
  if (headerKey) return { apiKey: headerKey };
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return { apiKey: authorization.slice("Bearer ".length).trim() };
  return { apiKey: null };
}
export function redactUrlForLog(nextUrl) { return nextUrl.pathname; }
