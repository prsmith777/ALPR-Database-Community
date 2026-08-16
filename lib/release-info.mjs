import { createRequire } from "node:module";

import builtReleaseMetadata from "./built-release-metadata.mjs";
import { HELP_MANUAL } from "./help-manual.mjs";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

export const CURRENT_RELEASE_NOTES = Object.freeze({
  title: "August 16, 2026 stratified ReID v2 evaluation",
  publishedAt: "2026-08-16",
  items: Object.freeze([
    "ReID v2 Shadow now includes a read-only stratified evaluation of the audited Same vehicle, Different vehicle, and Unsure pair labels. It reports counts and label-specific score ranges by fixed cosine band, camera pair, Overview context, effective-plate evidence, and local daytime or overnight period.",
    "The evaluation identifies a bounded descriptive list of underrepresented camera/time and overlapping-score cases for the next targeted review sample. It applies and recommends no threshold, writes no profile, cluster, or vehicle assignment, and does not call Plate Recognizer or another external provider.",
    "ReID v2 Shadow now displays the stored LPR plate capture, effective and observed plate text, camera, timestamp, and direction for every current read directly linked to each canonical Overview asset.",
    "A separately labeled companion section shows a different asset's LPR read only when the existing conservative shadow vehicle-event correlation currently links the observations. Plate or direction disagreements are warned visibly; all of this evidence remains review-only and does not change similarity, order, labels, profiles, or assignments.",
    "Added ReID v2 Shadow under Vehicle Intelligence as a read-only comparison surface for current canonical crop embeddings. It performs a bounded local cosine scan, shows deterministic nearest-neighbor ranks and margins, and creates no profile, cluster, threshold, review label, or vehicle assignment.",
    "Plate text, current v1 grouping, crop color, and crop body type are displayed separately as human review evidence and never affect candidate inclusion, score, or order. Current source revision checks exclude stale and display-only fallback evidence, shared canonical images count once, and no Plate Recognizer or other external-provider call is made.",
    "Added provider-neutral canonical crop embeddings as immutable 512-value local vectors owned by canonical vehicle crop derivatives. Each model and algorithm version is stored at most once per crop, with exact source and output hashes and no additional image file.",
    "Administrators can run an exact preview and admit 1, 5, 25, or 250 embeddings at a time under Vehicle Setup > Processing. Confirmation reruns inference and revalidates the crop bytes, dimensions, current identity evidence, model, and exact preview output before insertion; pause, cancellation, restart recovery, and one bounded operator retry are included.",
    "The embedding worker remains campaign-only. The read-only ReID v2 Shadow consumer does not create a cluster, profile, vehicle assignment, direction, shadow event, notification, Plate Recognizer result, or other external-provider behavior.",
    "Removed the saved-pixel Overview framing audit and operator repair campaign after production review showed many historical flags were non-actionable camera or environmental limits and the bounded canaries did not produce an acceptable replacement. The audit UI, repair actions, worker claims, repair export path, and repair-only target selector are gone.",
    "A forward migration restores any interrupted repair-owned read to its frozen prior ready state, cancels remaining repair work, and retains old run and job rows only as inert audit history. Existing Vehicle Views and prior repair outcomes are not deleted.",
    "Normal live Overview acquisition and final-frame validation remain active. Canonical Overview assets and crops, Vehicle ReID, shadow correlation, notifications, and external-provider behavior are unchanged.",
    "Added default-off automatic canonical vehicle cropping for newly cataloged identity-eligible Overview assets after the initial operator campaign completes. The durable low-priority worker processes one asset at a time, revalidates the exact source and detection evidence, and reuses the existing immutable crop pipeline.",
    "Administrators can enable, disable, monitor, and retry automatic crop work under Vehicle Setup > Processing. Manual crop campaigns remain mutually exclusive, source changes fail closed, cleanup protection is unchanged, and no ReID, event, attribute, notification, or external-provider behavior is enabled.",
    "Added operator-controlled canonical vehicle crops for current identity-eligible Overview assets. Preview freezes the exact source, evidence link, detector box, and encoded crop metadata without writing files; explicit 1, 5, 25, or 250-asset batches revalidate and publish immutable content-addressed JPEG derivatives.",
    "Storage reporting counts unique physical crop bytes, and cleanup plus bounded reconciliation protect every registered crop path. Full Overview images remain retained; current ReID, shadow events, attributes, notifications, and external enrichment remain unchanged.",
    "Added default-off provider-neutral shadow vehicle-event correlation for current canonical Overview evidence. It proposes only conservative two-read Entry or Street events, prefers exact shared assets, fails closed on direction, timing, context, camera, plate, or ambiguity conflicts, and retires proposals whose source revision changes.",
    "Administrators can enable, disable, inspect, and manually advance the bounded low-priority shadow worker under Vehicle Setup > Processing. Shadow events remain evidence only: they do not gate ingestion, alter Vehicle Views or current ReID, create clusters or attributes, send notifications, or call Plate Recognizer or another external provider.",
    "Added default-off automatic local cataloging for eligible Overview images that become ready after a completed operator campaign. The durable bounded queue pauses for operator campaigns, revalidates the current read before exact SHA-256 publication, and never blocks existing Vehicle View readiness.",
    "Administrators can enable or disable automatic cataloging under Vehicle Setup > Processing, inspect pending and terminal work, and retry one listed operational failure once. No Plate Recognizer, external provider, ReID v2, cluster, or attribute work is performed.",
    "Storage Health now includes observed recurring canonical-copy growth only while automatic cataloging is enabled. Canonical cleanup protection and archival zero-link retention remain unchanged.",
    "Administrators can preview and repair pre-fix reads whose complete Blue Iris 6 composite trigger remains in one retained accepted ingress receipt. Exact batches are limited to 250 reads, revalidated against the unchanged camera mapping and never-started overview state, audited, and queued without replaying historical notifications.",
    "Blue Iris 6 composite &TYPE values now retain their complete sanitized ingress evidence while a valid leading ordered crossing such as Motion_A>B is extracted for mapped daytime direction and Vehicle View processing. Conflicting crossings and unsafe values still fail closed.",
    "Added read-only logging growth health plus Administrator-controlled incident snapshots and exact preview-first retention. Incident evidence is byte-bounded, append-only, digest-protected, and can preserve one request, read, or seven-day window across retained operational logs, receipts, read timelines, and hot or archived audit rows.",
    "Retention schedules remain hard-disabled. A 15-minute one-time preview is actor-bound and exposes exact candidate IDs; typed execution revalidates and locks that set, verifies old audit events in the immutable partitioned archive before hot-table release, and removes only the confirmed expired receipt IDs.",
    "Bounded Docker json-file rotation now covers PostgreSQL in both database Compose variants. Normal live System Logs polling continues to read only the active application file, while a manual incident snapshot can correlate evidence across retained rotations.",
    "System Logs now preserves sanitized structured fields and supports newest-first server-side filtering, correlation searches, date ranges, pagination, refresh, expandable details, request-ID copy, and active-file usage without returning credentials, plates, images, payloads, or paths.",
    "Accepted Blue Iris text/plain JSON is now informational rather than warning activity. Background MQTT and file-storage diagnostics use the bounded operational logger, broker credentials remain redacted, routine console noise is removed, and MQTT avoids Node's deprecated legacy URL parser.",
    "Improved the rare Street-to-driveway fallback so two matching Entry LPR reads remain preferred, while a single Entry read may qualify only with authoritative matching Blue Iris direction, bounded route timing, acceptable plate identity, a ready daytime Entry Overview/Cam143 payload, and no competing plausible event.",
    "Added guarded one-edit OCR matching for plates of at least five characters. Exact matches and dual-camera evidence score higher; conflicting direction, short fuzzy plates, nighttime evidence, and ambiguous events still fail closed, and Cam143 never establishes plate identity.",
    "Corrected the generic no-vehicle overlay so it no longer incorrectly labels a Cam143 overview outcome as a legacy plate-camera failure.",
    "Added an operator-selected 250-read Entry Overview history batch for validated campaigns. The worker still processes one clip at a time, live Vehicle Views remain first in line, and pause, cancellation, retry, and stable export safeguards remain unchanged. Existing runs can widen without recreating their frozen preview.",
    "Added plate-anchored daytime Entry Overview Vehicle Views by reusing the proven read-owned Blue Iris timeline-export lifecycle. Entry Overview is explicitly bound to Cam143, and Entry LPR 1/2 Entering and Exiting mappings retain independent measured timing profiles.",
    "Added a separate preview-first Entry Overview history campaign for retained Entry LPR reads. Administrators can use direction-independent Cam143 anchors and exact date bounds, then advance resumable work in batches of 1, 5, 25, or 250 behind live traffic. Legacy plate-camera views remain visible until a validated full-resolution Cam143 replacement commits atomically; existing Cam143 views are preserved.",
    "Recent Captures Quick Look now chooses only ready overview-derived images with valid detected-vehicle crop metadata, prefers direct Entry Overview evidence, restores the original plate tile if an overview cannot load, and places both timestamp and Overview captions in compact bottom-right badges.",
    "Entry results use distinct provenance and are excluded from Street companion sharing. Known nighttime reads are not queued and make no Blue Iris calls; missing, duplicate, or mismatched Entry camera bindings fail closed before an export starts.",
    "Blue Iris initialization is now lazy and a claimed read is token-safely released into bounded retry if initialization fails. A Blue Iris outage backs off at the normal worker interval instead of cycling through queued reads every second.",
    "Entry LPR driveway route fallback remains a separate shadow-first layer. Route matching and Cam143 payload use must both be Active before a validated image may be copied; the overview image never establishes identity or creates a missing Street read.",
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
