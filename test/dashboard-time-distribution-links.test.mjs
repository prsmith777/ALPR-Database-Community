import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDashboardFeedHref,
  buildTimeDistributionHref,
  getDashboardTimeWindow,
  normalizeDashboardTimeZone,
} from "../lib/dashboard-time-distribution.mjs";

const NOW = new Date("2026-08-10T05:30:00.000Z");

test("dashboard time windows cover every selectable range", () => {
  const expectedDurations = new Map([
    ["24h", 24 * 60 * 60 * 1000],
    ["3d", 3 * 24 * 60 * 60 * 1000],
    ["7d", 7 * 24 * 60 * 60 * 1000],
    ["30d", 30 * 24 * 60 * 60 * 1000],
  ]);

  for (const [timeFrame, expectedDuration] of expectedDurations) {
    const { startDate, endDate } = getDashboardTimeWindow(timeFrame, NOW);
    assert.equal(endDate.toISOString(), NOW.toISOString());
    assert.equal(endDate.getTime() - startDate.getTime(), expectedDuration);
  }

  const allTime = getDashboardTimeWindow("all", NOW);
  assert.equal(allTime.startDate.toISOString(), "1970-01-01T00:00:00.000Z");
  assert.equal(allTime.endDate.toISOString(), NOW.toISOString());
});

test("every dashboard time-distribution link preserves its graph query", () => {
  for (const timeFrame of ["24h", "3d", "7d", "30d", "all"]) {
    const { startDate, endDate } = getDashboardTimeWindow(timeFrame, NOW);
    const href = buildTimeDistributionHref({
      hour: 22,
      timeFrame,
      startDate,
      endDate,
      timeZone: "America/Denver",
      cameras: ["Street LPR", "Driveway LPR"],
    });
    const url = new URL(href, "http://alpr.test");

    assert.equal(url.pathname, "/live_feed");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("timestampFrom"), startDate.toISOString());
    assert.equal(url.searchParams.get("timestampTo"), endDate.toISOString());
    assert.equal(url.searchParams.get("hourFrom"), "22");
    assert.equal(url.searchParams.get("hourTo"), "22");
    assert.equal(url.searchParams.get("timeZone"), "America/Denver");
    assert.equal(url.searchParams.get("timeFrame"), timeFrame);
    assert.deepEqual(url.searchParams.getAll("camera"), [
      "Street LPR",
      "Driveway LPR",
    ]);
  }
});

test("all-camera links omit a camera filter and invalid zones fail closed to UTC", () => {
  const href = buildTimeDistributionHref({
    hour: 0,
    timeFrame: "24h",
    startDate: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
    endDate: NOW,
    timeZone: "America/Denver",
    cameras: [],
  });
  const url = new URL(href, "http://alpr.test");
  assert.equal(url.searchParams.has("camera"), false);
  assert.equal(url.searchParams.get("hourFrom"), "0");
  assert.equal(url.searchParams.get("hourTo"), "0");
  assert.notEqual(url.searchParams.get("hourFrom"), "6");
  assert.equal(normalizeDashboardTimeZone("Bad/Zone"), "UTC");
});

test("Top Plates links preserve the page-wide time and multi-camera filters", () => {
  const { startDate, endDate } = getDashboardTimeWindow("7d", NOW);
  const href = buildDashboardFeedHref({
    search: "ABC123",
    timeFrame: "7d",
    startDate,
    endDate,
    timeZone: "America/Denver",
    cameras: ["Street LPR", "Driveway LPR"],
  });
  const url = new URL(href, "http://alpr.test");

  assert.equal(url.searchParams.get("search"), "ABC123");
  assert.equal(url.searchParams.get("matchMode"), "off");
  assert.equal(url.searchParams.get("timestampFrom"), startDate.toISOString());
  assert.equal(url.searchParams.get("timestampTo"), endDate.toISOString());
  assert.equal(url.searchParams.has("hourFrom"), false);
  assert.deepEqual(url.searchParams.getAll("camera"), [
    "Street LPR",
    "Driveway LPR",
  ]);
});

test("dashboard metric links preserve their result mode, time window, and cameras", () => {
  const { startDate, endDate } = getDashboardTimeWindow("30d", NOW);

  for (const metric of ["totalReads", "uniqueVehicles", "newVehicles"]) {
    const href = buildDashboardFeedHref({
      metric,
      timeFrame: "30d",
      startDate,
      endDate,
      timeZone: "America/Denver",
      cameras: ["Street LPR", "Driveway LPR"],
    });
    const url = new URL(href, "http://alpr.test");

    assert.equal(url.searchParams.get("dashboardMetric"), metric);
    assert.equal(url.searchParams.get("timestampFrom"), startDate.toISOString());
    assert.equal(url.searchParams.get("timestampTo"), endDate.toISOString());
    assert.deepEqual(url.searchParams.getAll("camera"), [
      "Street LPR",
      "Driveway LPR",
    ]);
  }
});

test("Tag Distribution links preserve the tag, time window, and cameras", () => {
  const { startDate, endDate } = getDashboardTimeWindow("7d", NOW);
  const href = buildDashboardFeedHref({
    tags: ["Family", "Suspicious"],
    timeFrame: "7d",
    startDate,
    endDate,
    timeZone: "America/Denver",
    cameras: ["Street LPR", "Driveway LPR"],
  });
  const url = new URL(href, "http://alpr.test");

  assert.deepEqual(url.searchParams.getAll("tag"), ["Family", "Suspicious"]);
  assert.equal(url.searchParams.get("timestampFrom"), startDate.toISOString());
  assert.equal(url.searchParams.get("timestampTo"), endDate.toISOString());
  assert.deepEqual(url.searchParams.getAll("camera"), [
    "Street LPR",
    "Driveway LPR",
  ]);
});

test("vehicle dashboard metrics and drill-downs use corrected plate identities", async () => {
  const [database, reviewRepository] = await Promise.all([
    readFile(new URL("../lib/db.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/plate-review-repository.mjs", import.meta.url), "utf8"),
  ]);
  const metricsQuery = database.slice(
    database.indexOf("export async function getMetrics"),
    database.indexOf("export async function manageKnownPlate")
  );

  assert.match(metricsQuery, /COUNT\(DISTINCT plate_number\) as unique_plates/);
  assert.match(metricsQuery, /SELECT COUNT\(DISTINCT plate_number\) as new_plates_count/);
  assert.match(
    metricsQuery,
    /total_plates AS \([\s\S]*?COUNT\(DISTINCT plate_number\) as total_plates_count[\s\S]*?FROM plate_reads/
  );
  assert.doesNotMatch(metricsQuery, /observed_plate/);
  assert.match(database, /pr_metric\.plate_number = pr\.plate_number/);
  assert.match(database, /pr_before\.plate_number = pr\.plate_number/);
  assert.match(reviewRepository, /UPDATE public\.plate_reads SET plate_number = \$2/);
});

test("Top Plates quick look uses an available overview only in its fourth tile", async () => {
  const [dashboard, database] = await Promise.all([
    readFile(new URL("../app/dashboard/DashboardMetrics.jsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/db.js", import.meta.url), "utf8"),
  ]);
  const previewQuery = database.slice(
    database.indexOf("export async function getPlateImagePreviews"),
    database.indexOf("export async function backfillOccurrenceCounts")
  );

  assert.match(previewQuery, /vehicle_image_path/);
  assert.match(previewQuery, /ORDER BY timestamp DESC\s+LIMIT 4/);
  assert.match(dashboard, /const overviewImage = images\.find\(\(image\) => image\.vehicle_image_path\)/);
  assert.match(dashboard, /index === 3 && overviewImage/);
  assert.match(dashboard, /quickLookImages\.map/);
  assert.match(dashboard, /img\.isOverview\s+\? `\/images\/\$\{img\.vehicle_image_path\}`/);
  assert.match(dashboard, /img\.isOverview\s+\? "Overview"/);
});

test("Tag Distribution slices and legend entries link to Recognition Feed", async () => {
  const [dashboard, tagDistribution] = await Promise.all([
    readFile(new URL("../app/dashboard/DashboardMetrics.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dashboard/TagDistribution.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /const tagHref = \(tag\) =>/);
  assert.match(dashboard, /getTagHref=\{tagHref\}/);
  assert.match(dashboard, /totalHref=\{tagDistributionTotalHref\}/);
  assert.match(tagDistribution, /router\.push\(getTagHref\(category\)\)/);
  assert.match(tagDistribution, /href=\{getTagHref\(item\.category\)\}/);
  assert.match(tagDistribution, /View \$\{item\.category\} plate reads in Recognition Feed/);
  assert.match(tagDistribution, /View all tagged plate reads in Recognition Feed/);
  assert.match(tagDistribution, /event\.key === "Enter" \|\| event\.key === " "/);
});

test("Recognition Feed applies dashboard timestamps and the browser-local hour", async () => {
  const [cameraSelector, dashboard, page, actions, database] = await Promise.all([
    readFile(new URL("../app/dashboard/CameraSelect.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dashboard/DashboardMetrics.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/live_feed/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/db.js", import.meta.url), "utf8"),
  ]);

  assert.match(cameraSelector, /MultiSelectFilter/);
  assert.match(cameraSelector, /allLabel=\{loading \? "Loading cameras…" : "All cameras"\}/);
  assert.match(dashboard, /selectedCameras/);
  assert.match(dashboard, /getDashboardMetrics\(timeZone, startDate, endDate, selectedCameras\)/);
  assert.match(dashboard, /cameras=\{selectedCameras\}/);
  assert.match(dashboard, /topPlateHref\(plate\.plate\)/);
  assert.match(dashboard, /href=\{metricHref\("totalReads"\)\}/);
  assert.match(dashboard, /href=\{metricHref\("uniqueVehicles"\)\}/);
  assert.match(dashboard, /href=\{metricHref\("newVehicles"\)\}/);
  assert.doesNotMatch(dashboard, /getTimezoneOffset/);
  assert.match(dashboard, /buildTimeDistributionHref/);
  assert.match(page, /timestampRange: dashboardTimestampRange/);
  assert.match(page, /normalizeDashboardTimeZone/);
  assert.match(page, /dashboardMetric/);
  assert.match(actions, /timestampRange,/);
  assert.match(actions, /timeZone,/);
  assert.match(actions, /getMetrics\(startDate, endDate, selectedCameras\)/);
  assert.match(actions, /normalizeDashboardCameraNames\(cameraNames\)/);
  assert.match(actions, /dashboardMetric,/);
  assert.match(database, /camera_name = ANY\(\$3::text\[\]\)/);
  assert.match(database, /camera_name = ANY\(\$4::text\[\]\)/);
  assert.match(database, /pr\.timestamp AT TIME ZONE \$\{timeZoneParameter\}/);
  assert.match(database, /filters\.timestampRange\.from/);
  assert.match(database, /timestamp with time zone/);
  assert.match(database, /DASHBOARD_VEHICLE_RESULT_MODES/);
});
