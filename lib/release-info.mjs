import packageJson from "../package.json" with { type: "json" };

import builtReleaseMetadata from "./built-release-metadata.mjs";
import { HELP_MANUAL } from "./help-manual.mjs";

export const CURRENT_RELEASE_NOTES = Object.freeze({
  title: "Reliable upgrades, Blue Iris setup and Home Assistant displays",
  publishedAt: "2026-11-02",
  items: Object.freeze([
    "Apply only pending database migrations, verify their checksums, and adopt existing completion markers without replaying historical cleanup.",
    "Preserve Blue Iris v2 direction observations and expose them to current-direction queries while retaining backup, row-count validation and rollback.",
    "Bind ALPR camera aliases to explicit Blue Iris recording short IDs, refresh camera inventory in setup, and use the saved binding in automatic vehicle processing.",
    "Show separate Blue Iris alert and ALPR read tolerances and require an explicit image owner when several ALPR reads match.",
    "Create revocable, expiring, camera-scoped read-only Home Assistant display links with exact parent-origin restrictions; retire the inactive IP login-bypass controls.",
    "Update User Guide 3.28, release and installation guidance. Existing installations use their normal update workflow without manual SQL or an intermediate release.",
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

export function getReleaseInfo(env = process.env, buildMetadata = builtReleaseMetadata) {
  const explicitSha = normalizeReleaseSha(env.ALPR_RELEASE_SHA);
  const imageSha = releaseShaFromImage(env.ALPR_RELEASE_IMAGE || env.ALPR_APP_IMAGE);
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
