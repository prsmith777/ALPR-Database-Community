import { createRequire } from "node:module";

import builtReleaseMetadata from "./built-release-metadata.mjs";
import { HELP_MANUAL } from "./help-manual.mjs";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

export const CURRENT_RELEASE_NOTES = Object.freeze({
  title: "August 10, 2026 Entry Overview primary Vehicle Views",
  publishedAt: "2026-08-10",
  items: Object.freeze([
    "Added plate-anchored daytime Entry Overview Vehicle Views by reusing the proven read-owned Blue Iris timeline-export lifecycle. Entry Overview is explicitly bound to Cam143, and Entry LPR 1/2 Entering and Exiting mappings retain independent measured timing profiles.",
    "Added a separate preview-first Entry Overview history campaign for retained Entry LPR reads. Administrators can use direction-independent Cam143 anchors and exact date bounds, then advance resumable work in batches of 1, 5, or 25 behind live traffic. Legacy plate-camera views remain visible until a validated full-resolution Cam143 replacement commits atomically; existing Cam143 views are preserved.",
    "Recent Captures Quick Look now chooses only ready overview-derived images with valid detected-vehicle crop metadata, prefers direct Entry Overview evidence, restores the original plate tile if an overview cannot load, and places both timestamp and Overview captions in compact bottom-right badges.",
    "Entry results use distinct provenance and are excluded from Street companion sharing. Known nighttime reads are not queued and make no Blue Iris calls; missing, duplicate, or mismatched Entry camera bindings fail closed before an export starts.",
    "Blue Iris initialization is now lazy and a claimed read is token-safely released into bounded retry if initialization fails. A Blue Iris outage backs off at the normal worker interval instead of cycling through queued reads every second.",
    "Entry LPR driveway route fallback remains a separate shadow-first layer and continues using corroborating Entry LPR captures in this release. Reusing a validated Cam143 primary view as its payload remains a later, separately reviewed enhancement.",
    "Corrected daytime Vehicle Views so each mapped Street LPR read directly retrieves Street Overview at its configured signed timing offset, samples 61 positions over six seconds, follows the target track nearest the calculated anchor, and refuses ambiguous competing vehicles without requiring a Street Overview motion action.",
    "Normal new reads save the selected Street Overview frame directly to their originating read. Monochrome nighttime reads remain Unavailable nighttime and make no timeline requests; Entry LPR driveway fallback remains a separate follow-up after primary-path validation.",
    "Promoted validated daytime Blue Iris ordered zone crossings to the displayed and notification direction source for new reads, with Vehicle ReID fallback, explicit Unavailable nighttime handling for monochrome captures, and no historical rewrite.",
    "Resolved five known dependency vulnerabilities by updating brace-expansion, ip-address, and postcss to fixed releases.",
    "Live host-maintenance requests with automatic status updates, configurable manual image-retirement grace, separate application and worker-image protection, conservative Docker layer-store reclaim receipts, and a bounded read-only host-storage snapshot for Docker and verified backup totals.",
    "Production-active, fail-closed, no-input manual database-backup control plane, gated on the reviewed database-backup-create-v1 worker capability, with automatic pending-status refresh and a manual fallback.",
    "Live Feed review with remembered Plate or Vehicle view, previous and next navigation across result pages, Confirm and Next for the next unconfirmed read, cursor-safe corrections, and aligned fixed-width action columns.",
    "Configurable storage thresholds, category breakdowns, maintenance status, rate-limited alerts, and confirmed derived-orphan cleanup previews.",
    "Default-off Administrator-approved automatic cleanup for reconciliation-confirmed derived orphans, with hard caps, provenance, circuit-breaker recovery, and read-only PostgreSQL maintenance statistics.",
    "Unified notification rules with dedicated MQTT, Pushover, email, and signed-webhook integrations.",
    "Plate review with correction history, aliases, review-status filters, continuous plate-focused zoom, and exact-read links from Known Plates.",
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
