import { isValidSessionId } from "./session-validation.mjs";
import { getTrustedInternalUrl } from "./internal-origin.mjs";

export const AUTH_VERIFICATION_TIMEOUT_MS = 5000;

const AUTHORIZED = Object.freeze({ ok: true, status: 200 });

function unauthorized() {
  return { ok: false, status: 401 };
}

function unavailable() {
  return { ok: false, status: 503 };
}

function containsQueryCredential(request) {
  const url = new URL(request.url);
  return [...url.searchParams.keys()].some(
    (name) => name.toLowerCase().replace(/[-_]/g, "") === "apikey"
  );
}

function extractApiCredential(request) {
  const headerKey = request.headers.get("x-api-key")?.trim();
  if (headerKey) return headerKey;

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function readStrictVerificationResponse(response) {
  if (response.status >= 400 && response.status < 500) {
    return unauthorized();
  }

  if (response.status >= 500 || response.status !== 200) {
    return unavailable();
  }

  try {
    const body = await response.json();
    if (typeof body?.valid !== "boolean") return unavailable();
    return body.valid ? AUTHORIZED : unauthorized();
  } catch {
    return unavailable();
  }
}

async function callVerifier(pathname, body, fetchImpl, env) {
  try {
    const response = await fetchImpl(getTrustedInternalUrl(pathname, env), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTH_VERIFICATION_TIMEOUT_MS),
    });
    return await readStrictVerificationResponse(response);
  } catch {
    return unavailable();
  }
}

export async function authorizeIntegrationRequest(
  request,
  { fetchImpl = globalThis.fetch, env = process.env } = {}
) {
  if (containsQueryCredential(request)) return unauthorized();

  const apiKey = extractApiCredential(request);
  if (!apiKey) return unauthorized();

  return await callVerifier(
    "/api/verify-key",
    { apiKey },
    fetchImpl,
    env
  );
}

export async function verifyBrowserSessionRequest(
  request,
  sessionId,
  { fetchImpl = globalThis.fetch, env = process.env } = {}
) {
  void request;
  if (!isValidSessionId(sessionId)) return unauthorized();

  return await callVerifier(
    "/api/verify-session",
    { sessionId },
    fetchImpl,
    env
  );
}

export function authenticationErrorResponse(result) {
  const message =
    result.status === 503
      ? "Authentication service unavailable"
      : "Unauthorized";
  return Response.json({ error: message }, { status: result.status });
}

export function createIntegrationRouteHandler(
  processAuthenticatedRequest,
  {
    authorize = authorizeIntegrationRequest,
    logger = console,
  } = {}
) {
  return async function authenticatedIntegrationRoute(request) {
    const authorization = await authorize(request);
    if (!authorization.ok) return authenticationErrorResponse(authorization);

    logger.log("Received authenticated plate-read request");

    let data;
    try {
      data = await request.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    try {
      return await processAuthenticatedRequest(data, request);
    } catch {
      logger.error("Plate-read processing failed");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
