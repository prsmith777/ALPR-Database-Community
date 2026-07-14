import { NextResponse } from "next/server.js";
import { getSessionCookieDeletionOptions } from "./lib/session-cookie.js";

const API_KEY_ROUTES = ["/api/plate-reads", "/api/plates"];
const PUBLIC_PATHS = [
  "/_next",
  "/favicon.ico",
  "/api/verify-session",
  "/api/health-check",
  "/api/verify-key",
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

function isApiKeyRoute(pathname) {
  return API_KEY_ROUTES.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

function isPublicPath(pathname) {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

function getApiCredential(request) {
  if (request.nextUrl.searchParams.has("api_key")) {
    return { rejected: true, apiKey: null };
  }

  const headerApiKey = request.headers.get("x-api-key");
  if (headerApiKey) {
    return { rejected: false, apiKey: headerApiKey };
  }

  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return { rejected: false, apiKey: bearerMatch[1] };
  }

  return { rejected: false, apiKey: null };
}

async function authorizeApiKeyRequest(request) {
  const { rejected, apiKey } = getApiCredential(request);
  if (rejected || !apiKey) {
    return { ok: false, status: 401 };
  }

  try {
    const response = await fetch(new URL("/api/verify-key", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return { ok: false, status: response.status >= 500 ? 503 : 401 };
    }

    const result = await response.json();
    return result?.valid ? { ok: true, status: 200 } : { ok: false, status: 401 };
  } catch (error) {
    console.error("API authentication temporarily unavailable");
    return { ok: false, status: 503 };
  }
}

function authJsonResponse(auth) {
  return NextResponse.json(
    {
      error:
        auth.status === 503
          ? "Authentication temporarily unavailable"
          : "Unauthorized",
    },
    { status: auth.status }
  );
}

function clearSessionCookie(response) {
  response.cookies.set(
    "session",
    "",
    getSessionCookieDeletionOptions()
  );
  return response;
}

async function verifyBrowserSession(request) {
  const sessionCookie = request.cookies.get("session");
  const sessionId = sessionCookie?.value;

  console.log("Checking browser session");

  if (!sessionId) {
    return { ok: false, status: 401, clearCookie: false };
  }

  try {
    const response = await fetch(new URL("/api/verify-session", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status >= 500 ? 503 : 401,
        clearCookie: response.status < 500,
      };
    }

    const result = await response.json();
    if (!result || typeof result.valid !== "boolean") {
      return { ok: false, status: 503, clearCookie: false };
    }

    return result.valid
      ? { ok: true, status: 200, clearCookie: false }
      : { ok: false, status: 401, clearCookie: true };
  } catch (error) {
    console.error("Session verification temporarily unavailable");
    return { ok: false, status: 503, clearCookie: false };
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|grid.svg).*)"],
  runtime: "nodejs",
};

export async function middleware(request) {
  console.log(`${request.method} ${request.nextUrl.pathname}`);

  const { pathname } = request.nextUrl;

  if (isApiKeyRoute(pathname)) {
    const auth = await authorizeApiKeyRequest(request);
    return auth.ok ? NextResponse.next() : authJsonResponse(auth);
  }

  if (request.nextUrl.searchParams.has("api_key")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (pathname === "/login") {
    const auth = await verifyBrowserSession(request);
    if (auth.ok) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    const response = NextResponse.next();
    return auth.clearCookie ? clearSessionCookie(response) : response;
  }

  const auth = await verifyBrowserSession(request);
  if (!auth.ok) {
    if (pathname.startsWith("/api/")) {
      const response = authJsonResponse(auth);
      return auth.clearCookie ? clearSessionCookie(response) : response;
    }

    const response = NextResponse.redirect(new URL("/login", request.url));
    return auth.clearCookie ? clearSessionCookie(response) : response;
  }

  if (!pathname.startsWith("/api/")) {
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
      console.error("Update check temporarily unavailable");
    }
  }

  return NextResponse.next();
}
