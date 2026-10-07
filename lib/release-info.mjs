import packageJson from "../package.json" with { type: "json" };

import builtReleaseMetadata from "./built-release-metadata.mjs";
import { HELP_MANUAL } from "./help-manual.mjs";

export const CURRENT_RELEASE_NOTES = Object.freeze({
  title: "Reliable Windows update retries",
  publishedAt: "2026-10-06",
  items: Object.freeze([
    "Retry interrupted Windows updates without deleting existing release files or changing the active application during staging.",
    "Stop Setup on update errors and verify the expected running release before reporting a successful installation.",
    "Install stable Windows Community updates from Settings > Software Updates, with download progress, automatic recovery backup, restart, validation, acceptance and rollback.",
    "Run graphical Setup once to update an existing Windows installation in place and enable browser updates, preserving passwords, API key, records, images and settings.",
    "Recover the previous release automatically after an unsuccessful Windows update and retain accepted backups when another release arrives.",
    "Correct a PowerShell 5.1 process-result bug that falsely reported successful Windows migration backups as failed.",
    "Install natively on Windows 10 22H2 x64 or Windows 11 x64 with automatic application and database services.",
    "Restore retained Windows data after reinstall with a verified recovery backup, preserving records, images, passwords, API keys, settings, and network preferences.",
    "Choose a recorded LPR camera or separate overview camera as the whole-vehicle image source for each saved travel direction.",
    "Reject plate-only, clipped, ambiguous, and monochrome LPR frames before they become ReID evidence.",
    "Move a verified logical database, images, settings, and authentication backup from Linux or Windows into an empty native Windows installation.",
    "Show component download percentages and animated progress during Windows setup and removal; retain the source and verified backup for recovery.",
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
