import { createRequire } from "node:module";

import builtReleaseMetadata from "./built-release-metadata.mjs";
import { HELP_MANUAL } from "./help-manual.mjs";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

export const CURRENT_RELEASE_NOTES = Object.freeze({
  title: "July 29, 2026 release line",
  publishedAt: "2026-07-29",
  items: Object.freeze([
    "Configurable storage thresholds, category breakdowns, maintenance status, rate-limited alerts, and confirmed derived-orphan cleanup previews.",
    "Default-off Administrator-approved automatic cleanup for reconciliation-confirmed derived orphans, with hard caps, provenance, circuit-breaker recovery, and read-only PostgreSQL maintenance statistics.",
    "Unified notification rules with dedicated MQTT, Pushover, email, and signed-webhook integrations.",
    "Faster plate review with correction history, aliases, review-status filters, and continuous plate-focused zoom.",
    "Storage Health with scheduled retention previews, bounded reconciliation, guarded maintenance controls, and alerting.",
    "Vehicle ReID visual search with resumable indexing, camera crop profiles, and calibration feedback.",
    "Configurable vehicle direction with audited front/rear calibration, historical backfill, and reviewable results.",
    "Automatic local coarse vehicle type with confidence and OpenVINO model provenance.",
    "Reviewable vehicle profiles with explicit, audited plate associations.",
    "Read-only Blue Iris timeline correlation with bounded local best-vehicle-frame selection and one retained JPEG per matched read.",
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
    manualVersion: boundedText(HELP_MANUAL.manualVersion, "unknown", 40),
    manualUpdatedAt: boundedText(HELP_MANUAL.updatedAt, "unknown", 80),
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
