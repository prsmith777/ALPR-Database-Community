import test from "node:test";
import assert from "node:assert/strict";

import {
  isValidCameraKey,
  normalizeCameraKey,
  normalizePlate,
} from "../lib/mqtt/plate-normalize.mjs";
import {
  damerauLevenshteinDistance,
  findBestPlateMatch,
  isCommonOcrConfusion,
} from "../lib/mqtt/fuzzy-match.mjs";
import {
  renderCameraTopic,
  validatePublishTopic,
} from "../lib/mqtt/topic-template.mjs";
import {
  isValidTimeZone,
  normalizeTimestamp,
} from "../lib/mqtt/timestamp.mjs";

test("plate and camera normalization produce stable comparison values", () => {
  assert.equal(normalizePlate(" dp-0m 90* "), "DP0M90");
  assert.equal(normalizeCameraKey("Entry LPR 1"), "entry-lpr-1");
  assert.equal(normalizeCameraKey("Road & Gate / LPR"), "road-and-gate-lpr");
  assert.equal(isValidCameraKey("entry-lpr-1"), true);
  assert.equal(isValidCameraKey("Entry LPR 1"), false);
});

test("Damerau-Levenshtein matching handles normal LPR OCR mistakes", () => {
  assert.equal(damerauLevenshteinDistance("DP0M90", "DPOM90"), 1);
  assert.equal(damerauLevenshteinDistance("DPOM9", "DPOM90"), 1);
  assert.equal(damerauLevenshteinDistance("DPOM900", "DPOM90"), 1);
  assert.equal(damerauLevenshteinDistance("DPMO90", "DPOM90"), 1);
  assert.equal(isCommonOcrConfusion("0", "O"), true);
  assert.equal(isCommonOcrConfusion("3", "8"), false);
});

test("fuzzy matching preserves the observed plate and returns the canonical plate", () => {
  const result = findBestPlateMatch(
    "DP0M90",
    [
      {
        plateNumber: "DPOM90",
        name: "Liz's Lexus",
        tags: ["Family"],
      },
    ],
    {
      fuzzyEnabled: true,
      maxDistance: 1,
      minimumPlateLength: 5,
      requireUnique: true,
      ocrAware: true,
    }
  );

  assert.equal(result.status, "fuzzy");
  assert.equal(result.observedPlate, "DP0M90");
  assert.equal(result.matchedPlateNumber, "DPOM90");
  assert.equal(result.distance, 1);
  assert.equal(result.quality, "strong");
  assert.equal(result.candidate.name, "Liz's Lexus");
});

test("exact matches always win without being labeled fuzzy", () => {
  const result = findBestPlateMatch("ABC-123", ["ABC123", "ABC128"]);

  assert.equal(result.status, "exact");
  assert.equal(result.matchedPlateNumber, "ABC123");
  assert.equal(result.distance, 0);
});

test("OCR-aware ranking prefers a common character confusion at equal distance", () => {
  const result = findBestPlateMatch("DP0M90", ["DPOM90", "DPXM90"], {
    maxDistance: 1,
    requireUnique: true,
    ocrAware: true,
  });

  assert.equal(result.status, "fuzzy");
  assert.equal(result.matchedPlateNumber, "DPOM90");
});

test("ambiguous fuzzy matches are rejected when a unique winner is required", () => {
  const result = findBestPlateMatch("ABC129", ["ABC123", "ABC128"], {
    maxDistance: 1,
    requireUnique: true,
    ocrAware: false,
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.matchedPlateNumber, "");
  assert.equal(result.candidates.length, 2);
});

test("short plates do not fuzzy-match by default", () => {
  const result = findBestPlateMatch("ABC1", ["ABC2"], {
    maxDistance: 1,
    minimumPlateLength: 5,
  });

  assert.equal(result.status, "none");
  assert.equal(result.reason, "observation-too-short");
});

test("camera topics are generated from editable templates", () => {
  assert.equal(
    renderCameraTopic({
      baseTopic: "Blue Iris/ALPR/",
      template: "{base_topic}/{camera_key}",
      cameraKey: "entry-lpr-1",
      cameraName: "Entry LPR 1",
    }),
    "Blue Iris/ALPR/entry-lpr-1"
  );

  assert.equal(
    renderCameraTopic({
      baseTopic: "alpr",
      template: "{base_topic}/cameras/{camera_key}/state",
      cameraKey: "entry-lpr-1",
      cameraName: "Entry LPR 1",
    }),
    "alpr/cameras/entry-lpr-1/state"
  );

  assert.equal(
    renderCameraTopic({
      baseTopic: "ignored",
      template: "{base_topic}/{camera_key}",
      cameraKey: "entry-lpr-1",
      cameraName: "Entry LPR 1",
      topicOverride: "property/vehicles/front-driveway",
    }),
    "property/vehicles/front-driveway"
  );
});

test("publish topics reject wildcards and unsupported template fields", () => {
  assert.throws(() => validatePublishTopic("alpr/+/state"), /wildcards/);
  assert.throws(
    () =>
      renderCameraTopic({
        baseTopic: "alpr",
        template: "{base_topic}/{unknown}",
        cameraKey: "entry-lpr-1",
        cameraName: "Entry LPR 1",
      }),
    /Unsupported MQTT topic field/
  );
});

test("timezone-aware timestamps format explicitly for America/Denver", () => {
  const result = normalizeTimestamp("2026-07-16T21:03:37.800Z", {
    timeZone: "America/Denver",
    hour12: true,
  });

  assert.equal(result.timestamp, "2026-07-16T21:03:37.800Z");
  assert.equal(result.timestampEpoch, 1784235817800);
  assert.match(result.timestampLocal, /^7\/16\/2026, 3:03:37\.800 PM$/);
  assert.equal(result.source, "provided");
  assert.equal(result.inputHadTimezone, true);
});

test("timezone-free Blue Iris timestamps are interpreted in the configured zone", () => {
  const summer = normalizeTimestamp("7/16/2026, 3:03:37.800 PM", {
    timeZone: "America/Denver",
  });
  const winter = normalizeTimestamp("1/16/2026, 3:03:37 PM", {
    timeZone: "America/Denver",
  });

  assert.equal(summer.timestamp, "2026-07-16T21:03:37.800Z");
  assert.equal(winter.timestamp, "2026-01-16T22:03:37.000Z");
  assert.equal(summer.inputHadTimezone, false);
});

test("invalid timestamps use an explicit server-receipt fallback", () => {
  const result = normalizeTimestamp("not-a-time", {
    timeZone: "America/Denver",
    now: () => new Date("2026-07-16T22:00:00.000Z"),
  });

  assert.equal(result.timestamp, "2026-07-16T22:00:00.000Z");
  assert.equal(result.timestampLocal, "7/16/2026, 4:00:00 PM");
  assert.equal(result.source, "server-receipt-fallback");
});

test("invalid IANA timezones are rejected", () => {
  assert.equal(isValidTimeZone("America/Denver"), true);
  assert.equal(isValidTimeZone("Mountain Time Somewhere"), false);
  assert.throws(
    () => normalizeTimestamp("2026-07-16T21:03:37Z", { timeZone: "Bad/Zone" }),
    /Invalid IANA timezone/
  );
});
