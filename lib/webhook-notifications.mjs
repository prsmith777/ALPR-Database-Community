import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

function deliveryError(message, { retryable = true, code = "" } = {}) {
  const error = new Error(message);
  error.retryable = retryable;
  if (code) error.code = code;
  return error;
}

export function normalizeWebhookUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2048) throw new Error("Enter a valid webhook URL");
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("Enter a valid webhook URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("Webhook URLs must use HTTP(S), cannot contain credentials, and cannot contain a fragment");
  }
  return url;
}

function ipv4Parts(address) {
  return address.split(".").map(Number);
}

export function classifyAddress(address) {
  const candidate = String(address ?? "").trim().replace(/^\[|\]$/g, "").split("%")[0];
  const version = isIP(candidate);
  if (version === 4) {
    const [a, b, c] = ipv4Parts(candidate);
    if (a === 127 || a === 0) return "forbidden";
    if (a === 169 && b === 254) return "forbidden";
    if (a === 192 && (b === 0 || (b === 88 && c === 99))) return "forbidden";
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return "forbidden";
    if (a === 203 && b === 0 && c === 113) return "forbidden";
    if (a >= 224) return "forbidden";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    if (a === 100 && b >= 64 && b <= 127) return "private";
    return "public";
  }
  if (version === 6) {
    const normalized = candidate.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice(7);
      if (isIP(mapped) === 4) return classifyAddress(mapped);
      const parts = mapped.split(":");
      if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
        const high = Number.parseInt(parts[0], 16);
        const low = Number.parseInt(parts[1], 16);
        return classifyAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
    }
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return "forbidden";
    if (normalized.startsWith("ff") || normalized.startsWith("2001:db8:")) return "forbidden";
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "private";
    return "public";
  }
  return "hostname";
}

async function resolveWebhookDestination(value, config = {}, lookupImpl = lookup) {
  const url = normalizeWebhookUrl(value);
  if (url.protocol === "http:" && !config.allow_http) {
    throw deliveryError("HTTP webhook targets are disabled; use HTTPS or explicitly allow HTTP", { retryable: false, code: "WEBHOOK_HTTP_DISABLED" });
  }
  const literalClass = classifyAddress(url.hostname);
  const addresses = literalClass === "hostname"
    ? await lookupImpl(url.hostname, { all: true, verbatim: true })
    : [{
        address: url.hostname.replace(/^\[|\]$/g, ""),
        family: isIP(url.hostname.replace(/^\[|\]$/g, "")),
      }];
  if (addresses.length === 0) throw deliveryError("Webhook hostname did not resolve", { retryable: true, code: "WEBHOOK_DNS_EMPTY" });
  for (const candidate of addresses) {
    const classification = classifyAddress(candidate.address);
    if (classification === "forbidden") {
      throw deliveryError("Webhook target resolves to a forbidden loopback, link-local, or special-use address", { retryable: false, code: "WEBHOOK_TARGET_FORBIDDEN" });
    }
    if (classification === "private" && !config.allow_private_networks) {
      throw deliveryError("Private-network webhook targets are disabled", { retryable: false, code: "WEBHOOK_PRIVATE_DISABLED" });
    }
  }
  return {
    url,
    address: {
      address: addresses[0].address,
      family: Number(addresses[0].family) || isIP(addresses[0].address),
    },
  };
}

export async function validateWebhookDestination(value, config = {}) {
  return (await resolveWebhookDestination(value, config)).url;
}

export function webhookConfigurationState(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    configured: Boolean(String(config.signing_secret ?? "").trim()),
  };
}

function pinnedWebhookRequest({ url, address, body, headers, timeoutMs, requestImpl } = {}) {
  return new Promise((resolve, reject) => {
    const requester = requestImpl || (url.protocol === "https:" ? httpsRequest : httpRequest);
    const request = requester(url, {
      method: "POST",
      headers,
      servername: url.protocol === "https:" ? url.hostname : undefined,
      lookup(_hostname, _options, callback) {
        callback(null, address.address, address.family);
      },
    }, (response) => {
      response.resume();
      resolve({
        status: Number(response.statusCode) || 0,
        headers: {
          get(name) {
            const value = response.headers?.[String(name).toLowerCase()];
            return Array.isArray(value) ? value[0] : value;
          },
        },
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error("Webhook request timed out"), { code: "WEBHOOK_TIMEOUT" }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

export async function sendWebhookNotification({
  config = {},
  payload = {},
  fetchImpl = null,
  lookupImpl = lookup,
  requestImpl = null,
} = {}) {
  const state = webhookConfigurationState(config);
  if (!state.enabled) throw deliveryError("Webhook notifications are disabled", { retryable: true, code: "WEBHOOK_DISABLED" });
  if (!state.configured) throw deliveryError("Webhook signing secret is not configured", { retryable: true, code: "WEBHOOK_NOT_CONFIGURED" });
  const destination = await resolveWebhookDestination(payload.url, config, lookupImpl);
  const { url } = destination;
  const body = JSON.stringify(payload.body || {});
  const signature = createHmac("sha256", String(config.signing_secret)).update(body).digest("hex");
  const timeoutSeconds = Math.max(2, Math.min(30, Number(config.timeout_seconds) || 10));
  let response;
  try {
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent": "ALPR-Database-Community/notification-webhook",
      "X-ALPR-Event-ID": String(payload.eventId || "manual-test").slice(0, 255),
      "X-ALPR-Signature": `sha256=${signature}`,
      "Idempotency-Key": String(payload.idempotencyKey || payload.eventId || "manual-test").slice(0, 255),
    };
    response = fetchImpl
      ? await fetchImpl(url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutSeconds * 1000),
          headers,
          body,
        })
      : await pinnedWebhookRequest({
          url,
          address: destination.address,
          body,
          headers,
          timeoutMs: timeoutSeconds * 1000,
          requestImpl,
        });
  } catch (cause) {
    throw deliveryError(String(cause?.message || "Webhook request failed").slice(0, 2000), {
      retryable: true,
      code: String(cause?.code || "WEBHOOK_NETWORK_ERROR"),
    });
  }
  if (response.status >= 200 && response.status < 300) {
    return {
      status: response.status,
      requestId: String(response.headers.get("x-request-id") || "").slice(0, 500),
    };
  }
  const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
  throw deliveryError(`Webhook returned HTTP ${response.status}`, {
    retryable,
    code: `WEBHOOK_HTTP_${response.status}`,
  });
}

export const webhookNotificationInternals = Object.freeze({
  deliveryError,
  ipv4Parts,
  pinnedWebhookRequest,
  resolveWebhookDestination,
});
