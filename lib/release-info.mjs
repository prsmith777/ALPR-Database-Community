import { createRequire } from "node:module";

import builtReleaseMetadata from "./built-release-metadata.mjs";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

export const CURRENT_RELEASE_NOTES = Object.freeze({
  title: "July 25, 2026 release line",
  publishedAt: "2026-07-25",
  items: Object.freeze([
    "Unified notification rules with dedicated MQTT, Pushover, email, and signed-webhook integrations.",
    "Faster plate review with correction history, aliases, review-status filters, and continuous plate-focused zoom.",
    "Read-only Storage Health, scheduled retention previews, and bounded resumable filesystem reconciliation.",
    "Vehicle ReID visual search with resumable indexing, camera crop profiles, and calibration feedback.",
    "Read-only release metadata for the installed version, commit-pinned image, release channel, and local notes.",
  ]),
});

function boundedText(value, fallback, maxLength = 80) {
  const text = String(value ?? "").trim();
  if (!text || /[\r\n\0]/.test(text)) return fallback;
  return text.slice(0, maxLength);
}

export function normalizeReleaseSha(value) {
  const sha = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

export function releaseShaFromImage(value) {
  const image = String(value ?? "").trim();
  const match = image.match(/:([0-9a-f]{7,40})$/i);
  return normalizeReleaseSha(match?.[1]);
}

export function getReleaseInfo(
  env = process.env,
  buildMetadata = builtReleaseMetadata
) {
  const explicitSha = normalizeReleaseSha(env.ALPR_RELEASE_SHA);
  const imageSha = releaseShaFromImage(
    env.ALPR_RELEASE_IMAGE || env.ALPR_APP_IMAGE
  );
  const builtSha = normalizeReleaseSha(buildMetadata?.gitSha);

  return {
    version: boundedText(packageJson.version, "unknown", 40),
    gitSha: explicitSha || imageSha || builtSha || null,
    channel: boundedText(
      env.ALPR_RELEASE_CHANNEL,
      boundedText(buildMetadata?.channel, "self-hosted", 40),
      40
    ),
    source: explicitSha
      ? "environment"
      : imageSha
        ? "commit-pinned image"
        : builtSha
          ? "built commit"
          : "not provided",
    notes: CURRENT_RELEASE_NOTES,
    readOnly: true,
  };
}

export const releaseInfoInternals = Object.freeze({ boundedText });
