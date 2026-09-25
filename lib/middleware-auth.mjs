import {
  authenticationErrorResponse,
  authorizeIntegrationRequest,
  verifyBrowserSessionRequest,
} from "./request-auth.mjs";
import { clearSessionCookie, SESSION_COOKIE_NAME } from "./session-cookie.mjs";
import { getTrustedInternalUrl } from "./internal-origin.mjs";

const PUBLIC_EXACT_PATHS = new Set([
  "/login",
  "/favicon.ico",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/api/check-update",
  "/api/health-check",
  "/api/verify-key",
  "/api/login-state",
  "/api/verify-session",
]);

const PUBLIC_ASSET_PREFIXES = ["/_next/", "/splash_screens/"];
const PUBLIC_ASSET_PATHS = new Set([
  "/180.png",
  "/192.png",
  "/512.png",
  "/1024.png",
  "/alpr.jpg",
  "/alpr_icon.svg",
  "/fallback.jpg",
  "/grid.svg",
  "/icon.png",
  "/icon512_maskable.png",
  "/icon512_rounded.png",
  "/placeholder.jpg",
]);

const SESSION_VERIFICATION_CACHE_MS = 2_000;
const UPDATE_STATUS_CACHE_MS = 5_000;
const MAX_SESSION_CACHE_ENTRIES = 128;

export function isIntegrationApiPath(pathname) {
  return ["/api/plate-reads", "/api/plates"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function isPublicPath(pathname) {
  return (
    PUBLIC_EXACT_PATHS.has(pathname) ||
    PUBLIC_ASSET_PATHS.has(pathname) ||
    PUBLIC_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function isApplicationApi(pathname) {
  return pathname.startsWith("/api/");
}

function isDocumentLikeRequest(request, pathname) {
  if (pathname.startsWith("/images/")) return false;
  if (request.headers.get("purpose") === "prefetch") return false;
  if (request.headers.has("next-router-prefetch")) return false;

  const destination = request.headers.get("sec-fetch-dest");
  if (!destination) return true;
  return destination === "document" || destination === "empty";
}

function isPasswordChangePath(pathname) {
  return pathname === "/settings/security" || pathname === "/api/current-access";
}

function clearInvalidSession(response) {
  clearSessionCookie(response.cookies);
  return response;
}

export function createMiddlewareHandler({
  next,
  redirect,
  json,
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now,
  sessionVerificationCacheMs = SESSION_VERIFICATION_CACHE_MS,
  updateStatusCacheMs = UPDATE_STATUS_CACHE_MS,
}) {
  const sessionVerificationCache = new Map();
  let updateStatusCache = null;

  const pruneSessionCache = () => {
    const currentTime = now();
    for (const [key, entry] of sessionVerificationCache) {
      if (!entry.pending && entry.expiresAt <= currentTime) {
        sessionVerificationCache.delete(key);
      }
    }
    while (sessionVerificationCache.size > MAX_SESSION_CACHE_ENTRIES) {
      sessionVerificationCache.delete(sessionVerificationCache.keys().next().value);
    }
  };

  const verifySession = async (request, sessionId) => {
    const cached = sessionVerificationCache.get(sessionId);
    if (cached?.pending) return await cached.pending;
    if (cached?.result && cached.expiresAt > now()) return cached.result;

    const pending = verifyBrowserSessionRequest(request, sessionId, {
      fetchImpl,
      env,
    });
    sessionVerificationCache.set(sessionId, {
      pending,
      result: null,
      expiresAt: now() + sessionVerificationCacheMs,
    });
    const result = await pending;
    if (result.ok && sessionVerificationCacheMs > 0) {
      sessionVerificationCache.set(sessionId, {
        pending: null,
        result,
        expiresAt: now() + sessionVerificationCacheMs,
      });
      pruneSessionCache();
    } else {
      sessionVerificationCache.delete(sessionId);
    }
    return result;
  };

  const readUpdateRequired = async () => {
    if (updateStatusCache?.pending) return await updateStatusCache.pending;
    if (updateStatusCache?.expiresAt > now()) return updateStatusCache.value;

    const pending = (async () => {
      const response = await fetchImpl(
        getTrustedInternalUrl("/api/check-update", env),
        { signal: AbortSignal.timeout(5000) }
      );
      if (!response.ok) return null;
      const data = await response.json();
      return data?.updateRequired === true;
    })();
    updateStatusCache = { pending, value: null, expiresAt: 0 };
    try {
      const value = await pending;
      if (value === null) {
        updateStatusCache = null;
        return null;
      }
      updateStatusCache = {
        pending: null,
        value,
        expiresAt: now() + updateStatusCacheMs,
      };
      return value;
    } catch (error) {
      updateStatusCache = null;
      throw error;
    }
  };

  return async function handleMiddleware(request) {
    const pathname = request.nextUrl.pathname;

    if (isIntegrationApiPath(pathname)) {
      const result = await authorizeIntegrationRequest(request, {
        fetchImpl,
        env,
      });
      if (!result.ok) {
        const errorResponse = authenticationErrorResponse(result);
        return json(await errorResponse.json(), { status: result.status });
      }
      return next();
    }

    if (isPublicPath(pathname) && pathname !== "/login") return next();

    const sessionId = request.cookies.get(SESSION_COOKIE_NAME)?.value || null;

    if (pathname === "/login") {
      if (!sessionId) return next();

      const result = await verifySession(request, sessionId);
      if (result.ok) {
        return redirect(
          new URL(
            result.passwordChangeRequired ? "/settings/security" : "/",
            request.url
          )
        );
      }
      if (result.status === 401) return clearInvalidSession(next());

      return next();
    }

    if (!sessionId) {
      if (isApplicationApi(pathname)) {
        return json({ error: "Unauthorized" }, { status: 401 });
      }
      return redirect(new URL("/login", request.url));
    }

    const verificationStartedAt = now();
    const result = await verifySession(request, sessionId);
    const verificationDurationMs = Math.max(0, now() - verificationStartedAt);

    if (!result.ok) {
      if (isApplicationApi(pathname)) {
        const response = json(
          {
            error:
              result.status === 503
                ? "Authentication service unavailable"
                : "Unauthorized",
          },
          { status: result.status }
        );
        return result.status === 401 ? clearInvalidSession(response) : response;
      }

      const response = redirect(new URL("/login", request.url));
      return result.status === 401 ? clearInvalidSession(response) : response;
    }

    if (result.passwordChangeRequired && !isPasswordChangePath(pathname)) {
      if (isApplicationApi(pathname)) {
        return json(
          { error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" },
          { status: 403 }
        );
      }
      return redirect(new URL("/settings/security", request.url));
    }

    let updateDurationMs = null;
    if (
      !isApplicationApi(pathname) &&
      pathname !== "/update" &&
      isDocumentLikeRequest(request, pathname)
    ) {
      try {
        const updateStartedAt = now();
        const updateRequired = await readUpdateRequired();
        updateDurationMs = Math.max(0, now() - updateStartedAt);
        if (updateRequired === true) {
          return redirect(new URL("/update", request.url));
        }
      } catch {
        console.error("Update check failed");
      }
    }

    const response = next();
    if (response?.headers?.set) {
      const timings = [`auth;dur=${verificationDurationMs}`];
      if (updateDurationMs !== null) timings.push(`update;dur=${updateDurationMs}`);
      // Middleware response headers override route response headers in Next.js.
      // Keep this timing separate so route-level Server-Timing details (for
      // example database and image I/O durations) reach the browser intact.
      response.headers.set("X-ALPR-Middleware-Timing", timings.join(", "));
    }
    return response;
  };
}
