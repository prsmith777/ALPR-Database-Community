import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DASHBOARD_FILTER_PREFERENCE_STORAGE_KEY,
  readDashboardFilterPreference,
  writeDashboardFilterPreference,
} from "../lib/dashboard-filter-preference.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    values,
  };
}

test("dashboard filter preferences persist multiple cameras and the time frame", () => {
  const storage = memoryStorage();
  const written = writeDashboardFilterPreference(
    {
      cameras: ["Street LPR", "Driveway LPR", "Street LPR"],
      timeFrame: "30d",
    },
    storage
  );

  assert.deepEqual(written, {
    cameras: ["Street LPR", "Driveway LPR"],
    timeFrame: "30d",
  });
  assert.deepEqual(readDashboardFilterPreference(storage), written);
  assert.equal(
    storage.values.has(DASHBOARD_FILTER_PREFERENCE_STORAGE_KEY),
    true
  );
});

test("missing, malformed, and unsupported preferences use dashboard defaults", () => {
  const storage = memoryStorage();
  assert.deepEqual(readDashboardFilterPreference(storage), {
    cameras: [],
    timeFrame: "24h",
  });

  storage.setItem(DASHBOARD_FILTER_PREFERENCE_STORAGE_KEY, "not-json");
  assert.deepEqual(readDashboardFilterPreference(storage), {
    cameras: [],
    timeFrame: "24h",
  });

  storage.setItem(
    DASHBOARD_FILTER_PREFERENCE_STORAGE_KEY,
    JSON.stringify({ cameras: ["all", ""], timeFrame: "90d" })
  );
  assert.deepEqual(readDashboardFilterPreference(storage), {
    cameras: [],
    timeFrame: "24h",
  });
});

test("dashboard restores preferences before querying and drops removed cameras", async () => {
  const dashboard = await readFile(
    new URL("../app/dashboard/DashboardMetrics.jsx", import.meta.url),
    "utf8"
  );

  assert.match(dashboard, /readDashboardFilterPreference\(\)/);
  assert.match(dashboard, /writeDashboardFilterPreference\(\{/);
  assert.match(dashboard, /if \(!preferencesReady\) return undefined/);
  assert.match(dashboard, /current\.filter\(\(camera\) => availableCameraSet\.has\(camera\)\)/);
});
