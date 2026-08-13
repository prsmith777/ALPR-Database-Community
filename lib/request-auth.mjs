import { isValidSessionId } from "./session-validation.mjs";
import { getTrustedInternalUrl } from "./internal-origin.mjs";

export const AUTH_VERIFICATION_TIMEOUT_MS = 5000;
export const DEFAULT_INTEGRATION_MAX_BODY_BYTES = 32 * 1024 * 1024;

const AUTHORIZED = Object.freeze({ ok: true, status: 200 });
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const textEncoder = new TextEncoder();

function generateRequestId() {
  return globalThis.crypto.randomUUID();
}

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
  if (response.status >= 400 && response.status < 500) return unauthorized();
  if (response.status >= 500 || response.status !== 200) return unavailable();

  try {
    const body = await response.json();
    if (typeof body?.valid !== "boolean") return unavailable();
    if (!body.valid) return unauthorized();
    return {
      ...AUTHORIZED,
      passwordChangeRequired: body.mustChangePassword === true,
    };
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
  return await callVerifier("/api/verify-key", { apiKey }, fetchImpl, env);
}

export async function verifyBrowserSessionRequest(
  request,
  sessionId,
  { fetchImpl = globalThis.fetch, env = process.env } = {}
) {
  void request;
  if (!isValidSessionId(sessionId)) return unauthorized();
  return await callVerifier("/api/verify-session", { sessionId }, fetchImpl, env);
}

function requestIdFor(request) {
  const supplied = request.headers?.get?.("x-request-id")?.trim();
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : generateRequestId();
}

function responseWithRequestId(response, requestId) {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(message, status, requestId) {
  return responseWithRequestId(Response.json({ error: message }, { status }), requestId);
}

export function authenticationErrorResponse(result, requestId = generateRequestId()) {
  const message =
    result.status === 503 ? "Authentication service unavailable" : "Unauthorized";
  return errorResponse(message, result.status, requestId);
}

function positiveBodyLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_INTEGRATION_MAX_BODY_BYTES;
}

function validJsonContentType(contentType) {
  if (!contentType) return true;
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function contentTypeKind(contentType) {
  if (!contentType) return "absent";
  return validJsonContentType(contentType) ? "json" : "non_json";
}

function logInfo(logger, event, details) {
  if (typeof logger.info === "function") {
    logger.info(event, details);
  } else {
    logger.log?.(event, details);
  }
}

async function readJsonBody(request, maxBodyBytes) {
  if (typeof request.text !== "function") {
    const data = await request.json();
    return { data, rawText: null, bodyBytes: null };
  }

  let rawText;
  let bodyBytes;
  const reader = request.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    const textParts = [];
    bodyBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bodyBytes += value?.byteLength || 0;
        if (bodyBytes > maxBodyBytes) {
          await reader.cancel().catch(() => {});
          const error = new Error("Request body exceeds configured limit");
          error.code = "BODY_TOO_LARGE";
          error.bodyBytes = bodyBytes;
          throw error;
        }
        textParts.push(decoder.decode(value, { stream: true }));
      }
      textParts.push(decoder.decode());
      rawText = textParts.join("");
    } finally {
      reader.releaseLock?.();
    }
  } else {
    rawText = await request.text();
    bodyBytes = textEncoder.encode(rawText).byteLength;
    if (bodyBytes > maxBodyBytes) {
      const error = new Error("Request body exceeds configured limit");
      error.code = "BODY_TOO_LARGE";
      error.bodyBytes = bodyBytes;
      throw error;
    }
  }

  try {
    return { data: JSON.parse(rawText), rawText, bodyBytes };
  } catch (cause) {
    const error = new Error("Invalid JSON request body", { cause });
    error.code = "INVALID_JSON";
    error.rawText = rawText;
    error.bodyBytes = bodyBytes;
    throw error;
  }
}

function isPlainObject(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function bestEffort(operation, onError = null) {
  try {
    return await operation();
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      // Observability failures must not replace the integration response.
    }
    return null;
  }
}

export function createIntegrationRouteHandler(
  processAuthenticatedRequest,
  {
    authorize = authorizeIntegrationRequest,
    logger = console,
    recorder = null,
    routeName = "integration",
    integration = "unknown",
    maxBodyBytes = positiveBodyLimit(process.env.ALPR_INTEGRATION_MAX_BODY_BYTES),
  } = {}
) {
  return async function authenticatedIntegrationRoute(request) {
    const startedAt = Date.now();
    const requestId = requestIdFor(request);
    const bodyLimit = positiveBodyLimit(maxBodyBytes);
    const contentType = request.headers?.get?.("content-type") || null;
    const contentLength = Number.parseInt(
      request.headers?.get?.("content-length") || "",
      10
    );
    let receiptStarted = false;
    let receiptHandle = null;
    let outcome = {};

    const complete = async (details) => {
      if (!recorder || !receiptStarted) return;
      await bestEffort(
        () => recorder.complete({
          requestId,
          ...(receiptHandle && typeof receiptHandle === "object" ? receiptHandle : {}),
          durationMs: Date.now() - startedAt,
          ...details,
        }),
        (error) => logger.warn?.("integration_receipt_completion_failed", {
          requestId,
          integration,
          routeName,
          errorCode: error?.code || "RECEIPT_COMPLETION_FAILED",
        })
      );
    };

    const startReceipt = async ({ rawText = null, data = null, bodyBytes = null } = {}) => {
      if (!recorder || receiptStarted) return;
      const started = await bestEffort(
        () => recorder.start({
          requestId,
          integration,
          routeName,
          method: request.method || "POST",
          contentType,
          bodyBytes:
            bodyBytes ?? (Number.isFinite(contentLength) ? contentLength : null),
          rawText,
          data,
        }),
        (error) => logger.warn?.("integration_receipt_start_failed", {
          requestId,
          integration,
          routeName,
          errorCode: error?.code || "RECEIPT_START_FAILED",
        })
      );
      receiptHandle = started && typeof started === "object"
        ? started
        : started != null
          ? { receiptId: started }
          : null;
      receiptStarted = started != null;
    };

    logInfo(logger, "integration_request_arrived", {
      requestId,
      integration,
      routeName,
      method: request.method || "POST",
      contentTypeKind: contentTypeKind(contentType),
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
    });

    const authorization = await authorize(request);
    if (!authorization.ok) {
      const errorCode =
        authorization.status === 503 ? "AUTH_SERVICE_UNAVAILABLE" : "UNAUTHORIZED";
      await startReceipt();
      await complete({
        httpStatus: authorization.status,
        outcome: "request_rejected",
        errorCode,
      });
      logger.warn?.("integration_request_rejected", {
        requestId,
        integration,
        routeName,
        httpStatus: authorization.status,
        errorCode,
      });
      return authenticationErrorResponse(authorization, requestId);
    }

    if (!validJsonContentType(contentType)) {
      logger.info?.("integration_content_type_compatibility", {
        requestId,
        integration,
        routeName,
        contentTypeKind: "non_json",
      });
    }
    if (Number.isFinite(contentLength) && contentLength > bodyLimit) {
      await startReceipt({ bodyBytes: contentLength });
      await complete({
        httpStatus: 413,
        outcome: "request_rejected",
        errorCode: "BODY_TOO_LARGE",
      });
      return errorResponse("Request body too large", 413, requestId);
    }

    let parsed;
    try {
      parsed = await readJsonBody(request, bodyLimit);
      if (!isPlainObject(parsed.data)) throw new TypeError("JSON object required");
    } catch (error) {
      const status = error?.code === "BODY_TOO_LARGE" ? 413 : 400;
      await startReceipt({
        bodyBytes:
          error?.bodyBytes ??
          parsed?.bodyBytes ??
          (Number.isFinite(contentLength) ? contentLength : null),
        rawText: error?.rawText ?? parsed?.rawText ?? null,
      });
      await complete({
        httpStatus: status,
        outcome: "request_rejected",
        errorCode: error?.code || "INVALID_REQUEST_BODY",
      });
      return errorResponse(
        status === 413 ? "Request body too large" : "Invalid request body",
        status,
        requestId
      );
    }

    await startReceipt({
      bodyBytes: parsed.bodyBytes,
      rawText: parsed.rawText,
      data: parsed.data,
    });

    logInfo(logger, "integration_request_received", {
      requestId,
      integration,
      routeName,
      ...(receiptHandle?.logSummary || {}),
    });

    const context = {
      requestId,
      setOutcome(details = {}) {
        outcome = { ...outcome, ...details };
      },
    };

    try {
      const response = await processAuthenticatedRequest(parsed.data, request, context);
      await complete({ httpStatus: response.status, outcome: "completed", ...outcome });
      return responseWithRequestId(response, requestId);
    } catch (error) {
      logger.error?.("integration_request_failed", {
        requestId,
        integration,
        routeName,
        errorCode: error?.code || "UNHANDLED_ERROR",
      });
      await complete({
        ...outcome,
        httpStatus: 500,
        outcome: "failed",
        errorCode: error?.code || outcome.errorCode || "UNHANDLED_ERROR",
      });
      return errorResponse("Internal server error", 500, requestId);
    }
  };
}
