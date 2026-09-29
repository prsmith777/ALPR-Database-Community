import { createRequire } from "node:module";

import builtReleaseMetadata from "./built-release-metadata.mjs";
import { HELP_MANUAL } from "./help-manual.mjs";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

export const CURRENT_RELEASE_NOTES = Object.freeze({
  title: "Resilient Community updates",
  publishedAt: "2026-09-29",
  items: Object.freeze([
    "Retry bounded transient DNS, timeout, connection, rate-limit, and server failures while downloading the checksum-pinned OpenVINO runtime.",
    "Automatically restore the exact previous release and application when an update fails before database migration begins.",
    "Leave the unchanged database in place during that automatic recovery and preserve the recorded failure and rollback artifacts for diagnosis.",
    "Add regressions for the observed DNS-download failure and prior-application recovery path.",
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
