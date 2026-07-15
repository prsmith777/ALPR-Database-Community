import crypto from "crypto";

export function timingSafeCompareSecrets(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }

  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (providedBytes.length !== expectedBytes.length) return false;

  return crypto.timingSafeEqual(providedBytes, expectedBytes);
}
