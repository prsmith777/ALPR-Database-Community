import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { formatHydrationSafeDateTime } from "../lib/hydration-safe-date.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Community Recognition Feed has no radar or speed product surface", async () => {
  const sources = await Promise.all([
    source("components/PlateTable.jsx"),
    source("components/PlateTableWrapper.jsx"),
    source("app/live_feed/page.jsx"),
    source("app/actions.js"),
    source("lib/db.js"),
    source("lib/recognition-feed-filter-preference.mjs"),
    source("lib/sql-sort.mjs"),
  ]);
  for (const value of sources) {
    assert.doesNotMatch(value, /minimumSpeed|maximumSpeed|speed_mph|radar_events|radarDirection|field="speed"/);
  }
  assert.doesNotMatch(sources[0], /Search plates or speed|Filter by Speed|Speed range/);
});

test("confidence percentages are rounded to one decimal place", async () => {
  const table = await source("components/PlateTable.jsx");
  assert.match(table, /Number\(\(numericConfidence \* 100\)\.toFixed\(1\)\)/);
  assert.doesNotMatch(table, /`\$\{numericConfidence \* 100\}%`/);
});

test("hydration-safe date formatting has a deterministic server snapshot", () => {
  assert.equal(
    formatHydrationSafeDateTime("2026-09-23T02:07:00.000Z", {
      timeZone: "UTC",
    }),
    "9/23/2026, 2:07:00 AM"
  );
});

test("affected server-rendered clients use hydration-safe timestamps", async () => {
  const paths = [
    "components/PlateTable.jsx",
    "components/FlaggedPlatesTable.jsx",
    "components/VehicleClusters.jsx",
    "components/VisualSearch.jsx",
    "app/logs/LogMessage.jsx",
    "app/logs/ReadPipelineTimeline.jsx",
    "app/logs/retention/LoggingRetentionPanel.jsx",
    "app/settings/StorageHealthCard.jsx",
    "app/settings/StorageMaintenancePanel.jsx",
  ];
  for (const path of paths) {
    assert.match(await source(path), /useHydrationSafeTimeZone/);
  }
});

test("Live Viewer polling compares against a current read id", async () => {
  const viewer = await source("components/LiveRecognitionViewer.jsx");
  assert.match(viewer, /latestPlateIdRef = useRef/);
  assert.match(viewer, /newPlate\.id !== latestPlateIdRef\.current/);
  assert.match(viewer, /useCallback\(async \(\) =>/);
});

test("dashboard hourly links expose their visible chart label", async () => {
  const dashboard = await source("app/dashboard/DashboardMetrics.jsx");
  assert.match(dashboard, /aria-label=\{`View \$\{payload\.fullLabel\} in Recognition Feed`\}/);
});
