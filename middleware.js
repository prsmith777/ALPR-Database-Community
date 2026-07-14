import { NextResponse } from "next/server.js";
import {
  logSafeRequest,
  getSessionCookieDeleteOptions,
} from "./lib/security.js";
import {
  getHeaderApiKey,
  hasQueryApiKey,
  isProtectedApiPath,
  jsonAuthError,
  verificationFailureStatus,
  SESSION_VERIFY_TIMEOUT_MS,
  API_KEY_VERIFY_TIMEOUT_MS,
} from "./lib/authz.js";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|grid.svg).*)"],
  runtime: "nodejs",
};

const publicPaths = [
  "/_next",
  "/favicon.ico",
  "/api/plate-reads",
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

function clearSession(response) {
  response.cookies.set("session", "", getSessionCookieDeleteOptions());
  return response;
}

function redirectToLogin(request) {
  return clearSession(NextResponse.redirect(new URL("/login", request.url)));
}

function apiAuthError(status, message) {
  return jsonAuthError(status, message);
}

async function verifyApiKeyWithService(request, apiKey) {
  const response = await fetch(new URL("/api/verify-key", request.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
    signal: AbortSignal.timeout(API_KEY_VERIFY_TIMEOUT_MS),
  });

  if (!response.ok) {
    return { valid: false, status: verificationFailureStatus(response.status) };
  }

  const result = await response.json();
  return {
    valid: result?.valid === true,
    status: result?.valid === true ? 200 : 401,
  };
}

async function verifySessionWithService(request, sessionId) {
  const response = await fetch(new URL("/api/verify-session", request.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(SESSION_VERIFY_TIMEOUT_MS),
  });

  if (!response.ok) {
    return { valid: false, status: verificationFailureStatus(response.status) };
  }

  const result = await response.json();
  return {
    valid: result?.valid === true,
    status: result?.valid === true ? 200 : 401,
  };
}

export async function middleware(request) {
  logSafeRequest(request);

  const pathname = request.nextUrl.pathname;

  if (hasQueryApiKey(request.url)) {
    return isProtectedApiPath(pathname)
      ? apiAuthError(401, "Query-string API keys are not accepted")
      : redirectToLogin(request);
  }

  if (isProtectedApiPath(pathname)) {
    const apiKey = getHeaderApiKey(request.headers);
    if (apiKey) {
      try {
        const result = await verifyApiKeyWithService(request, apiKey);
        if (result.valid) {
          return NextResponse.next();
        }
        return apiAuthError(
          result.status,
          result.status === 503
            ? "Authentication service unavailable"
            : "Unauthorized",
        );
      } catch (error) {
        console.error("API key verification failed");
        return apiAuthError(503, "Authentication service unavailable");
      }
    }
  }

  if (publicPaths.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const sessionId = request.cookies.get("session")?.value || null;

  if (pathname === "/login") {
    if (!sessionId) return NextResponse.next();

    try {
      const result = await verifySessionWithService(request, sessionId);
      if (result.valid) {
        return NextResponse.redirect(new URL("/", request.url));
      }
      return clearSession(NextResponse.next());
    } catch (error) {
      console.error("Session verification failed on login page");
      return clearSession(NextResponse.next());
    }
  }

  if (!sessionId) {
    return isProtectedApiPath(pathname)
      ? apiAuthError(401, "Unauthorized")
      : redirectToLogin(request);
  }

  try {
    const result = await verifySessionWithService(request, sessionId);
    if (!result.valid) {
      return isProtectedApiPath(pathname)
        ? apiAuthError(
            result.status,
            result.status === 503
              ? "Authentication service unavailable"
              : "Unauthorized",
          )
        : redirectToLogin(request);
    }
  } catch (error) {
    console.error("Session verification failed in middleware");
    return isProtectedApiPath(pathname)
      ? apiAuthError(503, "Authentication service unavailable")
      : redirectToLogin(request);
  }

  if (!pathname.startsWith("/api/")) {
    try {
      const updateResponse = await fetch(
        new URL("/api/check-update", request.url),
        {
          signal: AbortSignal.timeout(5000),
        },
      );
      if (updateResponse.ok) {
        const updateData = await updateResponse.json();
        if (updateData.updateRequired) {
          return NextResponse.redirect(new URL("/update", request.url));
        }
      }
    } catch (error) {
      console.error("Update check error:", error);
    }
  }

  return NextResponse.next();
}
