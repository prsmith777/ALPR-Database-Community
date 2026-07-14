import { extractApiKey } from "./security.js";
import { verifyApiKey, verifySession } from "./auth.js";

export async function requireApiKey(request) {
  const { apiKey, rejectedQueryApiKey } = extractApiKey(request);
  if (rejectedQueryApiKey) return { ok: false, status: 401, reason: "query" };
  if (!apiKey) return { ok: false, status: 401, reason: "missing" };
  const valid = await verifyApiKey(apiKey);
  return valid ? { ok: true } : { ok: false, status: 401, reason: "invalid" };
}

export async function requireSession(sessionId) {
  if (!sessionId) return { ok: false, status: 401, reason: "missing" };
  try {
    const valid = await verifySession(sessionId);
    return valid ? { ok: true } : { ok: false, status: 401, reason: "invalid" };
  } catch (error) {
    console.error("Session verification failed");
    return { ok: false, status: 503, reason: "unavailable" };
  }
}
