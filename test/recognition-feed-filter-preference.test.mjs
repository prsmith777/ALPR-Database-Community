import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RECOGNITION_FEED_FILTER_PREFERENCE_COOKIE_NAME,
  RECOGNITION_FEED_FILTER_PREFERENCE_STORAGE_KEY,
  hasExplicitRecognitionFeedFilterState,
  hasRecognitionFeedFilterPreference,
  normalizeRecognitionFeedFilterPreference,
  readRecognitionFeedFilterCookiePreference,
  readRecognitionFeedFilterPreference,
  recognitionFeedFilterPreferenceFromSearchParams,
  recognitionFeedFilterPreferenceToSearchParams,
  writeRecognitionFeedFilterPreference,
} from "../lib/recognition-feed-filter-preference.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    values,
  };
}

test("Recognition Feed preferences round-trip every stable filter and sort option", () => {
  const params = new URLSearchParams([
    ["search", " HYA2D4 "],
    ["tag", "resident"],
    ["tag", "visitor"],
    ["dateFrom", "Sat Aug 01 2026"],
    ["dateTo", "Sat Aug 22 2026"],
    ["hourFrom", "7"],
    ["hourTo", "18"],
    ["camera", "Street LPR 1"],
    ["camera", "Street LPR 2"],
    ["reviewStatus", "unreviewed"],
    ["direction", "Eastbound"],
    ["minimumSpeed", "10"],
    ["maximumSpeed", "45.5"],
    ["sortField", "speed"],
    ["sortDirection", "asc"],
  ]);

  const preference = recognitionFeedFilterPreferenceFromSearchParams(params);
  assert.deepEqual(preference, {
    search: "HYA2D4",
    tags: ["resident", "visitor"],
    dateFrom: "2026-08-01",
    dateTo: "2026-08-22",
    hourFrom: "7",
    hourTo: "18",
    cameras: ["Street LPR 1", "Street LPR 2"],
    reviewStatuses: ["unreviewed"],
    directions: ["Eastbound"],
    minimumSpeed: "10",
    maximumSpeed: "45.5",
    sortField: "speed",
    sortDirection: "asc",
  });
  assert.deepEqual(
    recognitionFeedFilterPreferenceFromSearchParams(
      recognitionFeedFilterPreferenceToSearchParams(preference)
    ),
    preference
  );
  assert.equal(hasRecognitionFeedFilterPreference(preference), true);
});

test("Recognition Feed preferences reject malformed values and preserve explicit drill-down precedence", () => {
  const preference = normalizeRecognitionFeedFilterPreference({
    dateFrom: "bad",
    dateTo: "also bad",
    hourFrom: -1,
    hourTo: 100,
    reviewStatuses: ["confirmed", "invalid"],
    minimumSpeed: -5,
    maximumSpeed: 500,
    sortField: "DROP TABLE",
    sortDirection: "sideways",
  });

  assert.deepEqual(preference.reviewStatuses, ["confirmed"]);
  assert.equal(preference.dateFrom, "");
  assert.equal(preference.hourFrom, "");
  assert.equal(preference.minimumSpeed, "");
  assert.equal(preference.maximumSpeed, "");
  assert.equal(preference.sortField, "timestamp");
  assert.equal(preference.sortDirection, "desc");
  assert.equal(hasRecognitionFeedFilterPreference(preference), true);

  assert.equal(
    hasExplicitRecognitionFeedFilterState(
      new URLSearchParams("timestampFrom=2026-08-01&readId=42&page=2")
    ),
    true
  );
  assert.equal(
    hasExplicitRecognitionFeedFilterState(new URLSearchParams("camera=Street+LPR+1")),
    true
  );
});

test("ascending timestamp sort restores both the field and direction", () => {
  const params = recognitionFeedFilterPreferenceToSearchParams({
    sortField: "timestamp",
    sortDirection: "asc",
  });
  assert.equal(params.get("sortField"), "timestamp");
  assert.equal(params.get("sortDirection"), "asc");
});

test("Recognition Feed preferences survive browser and application restarts through storage and a cookie", () => {
  const storage = memoryStorage();
  const documentRef = { cookie: "" };
  const written = writeRecognitionFeedFilterPreference(
    {
      cameras: ["Street LPR 1"],
      directions: ["Eastbound"],
      minimumSpeed: "12",
    },
    storage,
    documentRef
  );

  assert.deepEqual(readRecognitionFeedFilterPreference(storage), written);
  assert.equal(
    storage.values.has(RECOGNITION_FEED_FILTER_PREFERENCE_STORAGE_KEY),
    true
  );
  assert.match(
    documentRef.cookie,
    new RegExp(`^${RECOGNITION_FEED_FILTER_PREFERENCE_COOKIE_NAME}=`)
  );
  const encodedCookieValue = documentRef.cookie
    .split(";", 1)[0]
    .split("=", 2)[1];
  assert.deepEqual(
    readRecognitionFeedFilterCookiePreference({
      get: () => ({ value: encodedCookieValue }),
    }),
    written
  );
});

test("Recognition Feed restores saved state before querying and keeps explicit links authoritative", async () => {
  const [page, wrapper, table] = await Promise.all([
    readFile(new URL("../app/live_feed/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/PlateTableWrapper.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/PlateTable.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /readRecognitionFeedFilterCookiePreference/);
  assert.match(page, /hasExplicitRecognitionFeedFilterState/);
  assert.match(page, /redirect\(`\/live_feed\?\$\{savedQuery\}`\)/);
  assert.match(wrapper, /writeRecognitionFeedFilterPreference/);
  assert.match(wrapper, /recognitionFeedFilterPreferenceFromSearchParams/);

  const activeFilterSummary = table.slice(
    table.indexOf("{/* Active filters display */}"),
    table.indexOf("{/* Table - Desktop view and Mobile cards */}")
  );
  const clearFiltersImplementation = table.slice(
    table.indexOf("const clearFilters = () =>"),
    table.indexOf("const formatConfidence")
  );
  assert.match(activeFilterSummary, /\) && \(/);
  assert.match(activeFilterSummary, /onClick=\{clearFilters\}/);
  assert.match(activeFilterSummary, />\s*Clear filters\s*<\/Button>/);
  assert.doesNotMatch(
    clearFiltersImplementation,
    /pageSize/,
    "clearing filters must preserve the independently saved rows-per-page preference"
  );
});
