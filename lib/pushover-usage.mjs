const PUSHOVER_LIMITS_URL = "https://api.pushover.net/1/apps/limits.json";

function requiredNonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Pushover returned an invalid ${name}`);
  }
  return number;
}

function normalizePushoverError(payload, fallback) {
  const errors = payload?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((error) => String(error)).join("; ");
  }
  if (errors && typeof errors === "object") {
    const messages = Object.values(errors).flat().map((error) => String(error));
    if (messages.length > 0) return messages.join("; ");
  }
  return fallback;
}

export async function fetchPushoverUsage({
  token,
  fetchImpl = fetch,
  signal,
} = {}) {
  const normalizedToken = String(token ?? "").trim();
  if (!normalizedToken) {
    throw new Error("Configure a Pushover application token to view usage");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Pushover usage fetch implementation is required");
  }

  const url = new URL(PUSHOVER_LIMITS_URL);
  url.searchParams.set("token", normalizedToken);

  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "ALPR-Database-Community/0.1.9",
    },
    cache: "no-store",
    signal,
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Pushover usage request failed with HTTP ${response.status}`);
  }

  if (!response.ok || Number(payload?.status) !== 1) {
    throw new Error(
      normalizePushoverError(
        payload,
        `Pushover usage request failed with HTTP ${response.status}`
      )
    );
  }

  const limit = requiredNonNegativeInteger(payload.limit, "monthly limit");
  const remaining = requiredNonNegativeInteger(
    payload.remaining,
    "remaining-message count"
  );
  const reset = requiredNonNegativeInteger(payload.reset, "reset timestamp");
  const boundedRemaining = Math.min(remaining, limit);
  const used = Math.max(0, limit - boundedRemaining);

  return {
    limit,
    remaining: boundedRemaining,
    used,
    percentUsed: limit === 0 ? 100 : Math.min(100, (used / limit) * 100),
    resetAt: new Date(reset * 1000).toISOString(),
    requestId: String(payload.request ?? ""),
    scope: "account",
  };
}

export const pushoverUsageInternals = Object.freeze({
  PUSHOVER_LIMITS_URL,
  normalizePushoverError,
  requiredNonNegativeInteger,
});
