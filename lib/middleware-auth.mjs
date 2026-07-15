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
  "/api/verify-session",
]);

const PUBLIC_ASSET_PREFIXES = ["/_next/", "/splash_screens/"];
const PUBLIC_ASSET_PATHS = new Set([
  "/180.png",
  "/192.png",
  "/512.png",
  "/1024.png",
  "/grid.svg",
]);

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
}) {
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

      const result = await verifyBrowserSessionRequest(request, sessionId, {
        fetchImpl,
        env,
      });
      if (result.ok) return redirect(new URL("/", request.url));
      if (result.status === 401) return clearInvalidSession(next());

      return next();
    }

    if (!sessionId) {
      if (isApplicationApi(pathname)) {
        return json({ error: "Unauthorized" }, { status: 401 });
      }
      return redirect(new URL("/login", request.url));
    }

    const result = await verifyBrowserSessionRequest(request, sessionId, {
      fetchImpl,
      env,
    });

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

    if (!isApplicationApi(pathname) && pathname !== "/update") {
      try {
        const updateResponse = await fetchImpl(
          getTrustedInternalUrl("/api/check-update", env),
          { signal: AbortSignal.timeout(5000) }
        );
        if (updateResponse.ok) {
          const updateData = await updateResponse.json();
          if (updateData?.updateRequired === true) {
            return redirect(new URL("/update", request.url));
          }
        }
      } catch {
        console.error("Update check failed");
      }
    }

    return next();
  };
}
