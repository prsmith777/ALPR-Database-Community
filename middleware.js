import { NextResponse } from "next/server.js";
import {
  clearSessionCookieOnResponse,
  jsonAuthUnavailable,
  jsonUnauthorized,
  redactUrlForLog,
  redirectToLogin,
  extractApiKey,
} from "./lib/security.js";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|grid.svg).*)"],
  runtime: "nodejs",
};

const publicPaths = [
  "/_next",
  "/favicon.ico",
  "/api/verify-session",
  "/api/health-check",
  "/api/verify-key",
  "/api/verify-whitelist",
  "/api/check-update",
  "/api/test",
  "/update",
  "/180.png",
  "/512.png",
  "/192.png",
  "/1024.png",
  "/grid.svg",
  "/manifest.webmanifest",
];

const apiKeyProtectedPaths = ["/api/plate-reads", "/api/plates"];

function isApiRequest(pathname) {
  return pathname.startsWith("/api/");
}

async function verifySessionViaApi(request, sessionId) {
  if (!sessionId) return { ok: false, status: 401 };
  try {
    const response = await fetch(new URL("/api/verify-session", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { ok: false, status: response.status >= 500 ? 503 : 401 };
    const result = await response.json();
    if (result?.valid === true) return { ok: true };
    if (result?.valid === false) return { ok: false, status: 401 };
    return { ok: false, status: 503 };
  } catch (error) {
    console.error("Session verification request failed");
    return { ok: false, status: 503 };
  }
}

async function verifyApiKeyViaApi(request) {
  const { rejectedQueryApiKey } = extractApiKey(request);
  if (rejectedQueryApiKey) return { ok: false, status: 401 };
  try {
    const headers = new Headers();
    const headerKey = request.headers.get("x-api-key");
    const authorization = request.headers.get("authorization");
    if (headerKey) headers.set("x-api-key", headerKey);
    if (authorization) headers.set("authorization", authorization);
    const response = await fetch(new URL("/api/verify-key", request.url), {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { ok: false, status: response.status >= 500 ? 503 : 401 };
    const result = await response.json();
    return result?.valid === true ? { ok: true } : { ok: false, status: 401 };
  } catch (error) {
    console.error("API key verification request failed");
    return { ok: false, status: 503 };
  }
}

async function maybeCheckUpdate(request) {
  try {
    const updateResponse = await fetch(new URL("/api/check-update", request.url), {
      signal: AbortSignal.timeout(5000),
    });
    if (updateResponse.ok) {
      const updateData = await updateResponse.json();
      if (updateData.updateRequired) {
        return NextResponse.redirect(new URL("/update", request.url));
      }
    }
  } catch (error) {
    console.error("Update check failed");
  }
  return null;
}

async function maybeAllowWhitelistedIp(request) {
  try {
    const isWhitelistedIpResponse = await fetch(
      new URL("/api/verify-whitelist", request.url),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: request.ip,
          headers: Object.fromEntries(request.headers),
        }),
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!isWhitelistedIpResponse.ok) return false;
    const parsed = await isWhitelistedIpResponse.json();
    return parsed.allowed === true;
  } catch (error) {
    console.error("IP whitelist check failed");
    return false;
  }
}

export async function middleware(request) {
  const pathname = request.nextUrl.pathname;
  console.log(`${request.method} ${redactUrlForLog(request.nextUrl)}`);

  if (apiKeyProtectedPaths.some((path) => pathname.startsWith(path))) {
    const result = await verifyApiKeyViaApi(request);
    if (!result.ok) return result.status === 503 ? jsonAuthUnavailable() : jsonUnauthorized("Unauthorized");
    return NextResponse.next();
  }

  if (publicPaths.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const sessionId = request.cookies.get("session")?.value;

  if (pathname === "/login") {
    if (!sessionId) return NextResponse.next();
    const session = await verifySessionViaApi(request, sessionId);
    if (session.ok) return NextResponse.redirect(new URL("/", request.url));
    const response = NextResponse.next();
    if (session.status === 401) clearSessionCookieOnResponse(response);
    return response;
  }

  if (!sessionId) {
    if (await maybeAllowWhitelistedIp(request)) return NextResponse.next();
    return isApiRequest(pathname) ? jsonUnauthorized("Unauthorized") : redirectToLogin(request);
  }

  const session = await verifySessionViaApi(request, sessionId);
  if (!session.ok) {
    if (isApiRequest(pathname)) {
      const response = session.status === 503 ? jsonAuthUnavailable() : jsonUnauthorized("Unauthorized");
      if (session.status === 401) clearSessionCookieOnResponse(response);
      return response;
    }
    if (session.status === 503) {
      return new Response("Authentication temporarily unavailable", { status: 503 });
    }
    return redirectToLogin(request, { clearCookie: true });
  }

  if (!isApiRequest(pathname)) {
    const updateRedirect = await maybeCheckUpdate(request);
    if (updateRedirect) return updateRedirect;
  }

  return NextResponse.next();
}
