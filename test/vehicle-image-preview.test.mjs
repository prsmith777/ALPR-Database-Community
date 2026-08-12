import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQuickLookImages,
  getVehiclePreviewCropStyle,
  selectQuickLookOverview,
} from "../lib/vehicle-image-preview.mjs";

const validOverview = (overrides = {}) => ({
  id: "overview-read",
  thumbnail_path: "plate.jpg",
  vehicle_image_path: "vehicle.jpg",
  vehicle_image_status: "ready",
  vehicle_image_source_kind: "overview_primary",
  vehicle_image_detection_box: {
    left: 0.25,
    top: 0.2,
    right: 0.75,
    bottom: 0.8,
  },
  vehicle_image_width: 2688,
  vehicle_image_height: 1520,
  ...overrides,
});

const plateImages = () => Array.from({ length: 4 }, (_, index) => ({
  id: `plate-read-${index + 1}`,
  thumbnail_path: `plate-${index + 1}.jpg`,
  timestamp: `2026-08-10T12:00:0${index}Z`,
}));

test("vehicle preview crop focuses a normalized detection box without distorting the source", () => {
  const style = getVehiclePreviewCropStyle(
    { left: 0.4, top: 0.3, right: 0.6, bottom: 0.7 },
    2688,
    1520
  );

  assert.equal(style.position, "absolute");
  assert.ok(Number.parseFloat(style.width) > 100);
  assert.ok(Number.parseFloat(style.height) > 100);
  assert.ok(Number.parseFloat(style.left) < 0);
  assert.ok(Number.parseFloat(style.top) < 0);
  const renderedAspect =
    (16 / 9)
    * (Number.parseFloat(style.width) / Number.parseFloat(style.height));
  assert.ok(Math.abs(renderedAspect - 2688 / 1520) < 0.001);
});

test("vehicle preview crop remains inside the source at an image edge", () => {
  const style = getVehiclePreviewCropStyle(
    { left: 0.01, top: 0.2, right: 0.35, bottom: 0.8 },
    2688,
    1520
  );

  assert.equal(style.left, "0%");
  assert.ok(Number.parseFloat(style.width) > 100);
});

test("vehicle preview crop safely falls back for missing or invalid metadata", () => {
  assert.equal(getVehiclePreviewCropStyle(null, 2688, 1520), null);
  assert.equal(
    getVehiclePreviewCropStyle(
      { left: 0.7, top: 0.2, right: 0.4, bottom: 0.8 },
      2688,
      1520
    ),
    null
  );
  assert.equal(
    getVehiclePreviewCropStyle(
      { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 },
      0,
      1520
    ),
    null
  );
});

for (const sourceKind of [
  "overview_primary",
  "entry_overview_primary",
  "entry_overview_route_fallback",
  "entry_overview_history",
  "overview_pair_share",
  "overview_fallback",
]) {
  test(`Quick Look accepts ready ${sourceKind} images with valid crop metadata`, () => {
    const overview = validOverview({ vehicle_image_source_kind: sourceKind });
    const selection = selectQuickLookOverview([overview]);

    assert.equal(selection?.image, overview);
    assert.ok(selection?.cropStyle);
  });
}

test("Quick Look prefers a ready Entry Overview image over other overview-family sources", () => {
  const fallback = validOverview({
    id: "fallback",
    vehicle_image_path: "fallback.jpg",
    vehicle_image_source_kind: "overview_fallback",
  });
  const shared = validOverview({
    id: "shared",
    vehicle_image_path: "shared.jpg",
    vehicle_image_source_kind: "overview_pair_share",
  });
  const entry = validOverview({
    id: "entry",
    vehicle_image_path: "entry.jpg",
    vehicle_image_source_kind: "entry_overview_primary",
  });

  assert.equal(
    selectQuickLookOverview([fallback, shared, entry])?.image,
    entry
  );
});

test("Quick Look chooses Entry Overview over a newer plate-camera fallback", () => {
  const legacyFallback = validOverview({
    id: "legacy-entry-lpr",
    vehicle_image_path: "legacy-entry-lpr.jpg",
    vehicle_image_source_kind: "entry_lpr_fallback",
  });
  const entry = validOverview({
    id: "entry-overview",
    vehicle_image_path: "entry-overview.jpg",
    vehicle_image_source_kind: "entry_overview_primary",
  });

  assert.equal(
    selectQuickLookOverview([legacyFallback, entry])?.image,
    entry
  );
});

test("Quick Look crop metadata comes from the same row as its selected path", () => {
  const street = validOverview({
    id: "street",
    vehicle_image_path: "street.jpg",
    vehicle_image_source_kind: "overview_primary",
    vehicle_image_detection_box: {
      left: 0.05,
      top: 0.15,
      right: 0.45,
      bottom: 0.75,
    },
    vehicle_image_width: 1920,
    vehicle_image_height: 1080,
  });
  const entry = validOverview({
    id: "entry",
    vehicle_image_path: "entry.jpg",
    vehicle_image_source_kind: "entry_overview_primary",
    vehicle_image_detection_box: {
      left: 0.55,
      top: 0.2,
      right: 0.95,
      bottom: 0.8,
    },
    vehicle_image_width: 2688,
    vehicle_image_height: 1520,
  });
  const selection = selectQuickLookOverview([street, entry]);

  assert.equal(selection?.image.vehicle_image_path, "entry.jpg");
  assert.deepEqual(
    selection?.cropStyle,
    getVehiclePreviewCropStyle(
      entry.vehicle_image_detection_box,
      entry.vehicle_image_width,
      entry.vehicle_image_height
    )
  );
});

for (const [label, overrides] of [
  ["pending status", { vehicle_image_status: "pending" }],
  ["missing status", { vehicle_image_status: null }],
  ["plate-camera fallback source", { vehicle_image_source_kind: "entry_lpr_fallback" }],
  ["missing path", { vehicle_image_path: null }],
  ["missing detection box", { vehicle_image_detection_box: null }],
  ["out-of-range detection box", {
    vehicle_image_detection_box: {
      left: -0.1,
      top: 0.2,
      right: 0.7,
      bottom: 0.8,
    },
  }],
  ["inverted detection box", {
    vehicle_image_detection_box: {
      left: 0.7,
      top: 0.2,
      right: 0.4,
      bottom: 0.8,
    },
  }],
  ["missing width", { vehicle_image_width: null }],
  ["zero height", { vehicle_image_height: 0 }],
]) {
  test(`Quick Look rejects ${label}`, () => {
    assert.equal(selectQuickLookOverview([validOverview(overrides)]), null);
  });
}

test("Quick Look preserves the original fourth plate tile when crop metadata is invalid", () => {
  const originals = plateImages();
  const invalid = validOverview({ vehicle_image_detection_box: null });
  const quickLook = buildQuickLookImages(
    originals,
    selectQuickLookOverview([invalid])
  );

  assert.equal(quickLook[3], originals[3]);
  assert.equal(quickLook[3].isOverview, undefined);
});

test("Quick Look preserves the original fourth plate tile after the overview path fails", () => {
  const originals = plateImages();
  const overview = validOverview({ vehicle_image_path: "missing-vehicle.jpg" });
  const selection = selectQuickLookOverview([overview], {
    failedPaths: new Set([overview.vehicle_image_path]),
  });
  const quickLook = buildQuickLookImages(originals, selection);

  assert.equal(selection, null);
  assert.equal(quickLook[3], originals[3]);
  assert.equal(quickLook[3].thumbnail_path, "plate-4.jpg");
});

test("Quick Look advances to the next eligible overview when the preferred URL fails", () => {
  const entry = validOverview({
    vehicle_image_path: "missing-entry.jpg",
    vehicle_image_source_kind: "entry_overview_primary",
  });
  const street = validOverview({
    id: "street",
    vehicle_image_path: "available-street.jpg",
    vehicle_image_source_kind: "overview_primary",
  });
  const selection = selectQuickLookOverview([entry, street], {
    failedPaths: [entry.vehicle_image_path],
  });

  assert.equal(selection?.image, street);
});

test("Quick Look replaces only the original fourth tile with the selected crop", () => {
  const originals = plateImages();
  const selection = selectQuickLookOverview([
    validOverview({ vehicle_image_source_kind: "entry_overview_primary" }),
  ]);
  const quickLook = buildQuickLookImages(originals, selection);

  assert.equal(quickLook.length, 4);
  assert.deepEqual(quickLook.slice(0, 3), originals.slice(0, 3));
  assert.equal(quickLook[3].isOverview, true);
  assert.equal(quickLook[3].vehicle_image_path, "vehicle.jpg");
  assert.equal(quickLook[3].overviewCropStyle, selection.cropStyle);
});

test("Quick Look uses a ready historical Entry Overview crop only in tile four", () => {
  const originals = plateImages();
  const historicalEntry = validOverview({
    id: "entry-history",
    vehicle_image_path: "entry-history.jpg",
    vehicle_image_source_kind: "entry_overview_history",
    vehicle_image_detection_box: {
      left: 0.52,
      top: 0.18,
      right: 0.94,
      bottom: 0.82,
    },
    vehicle_image_width: 2688,
    vehicle_image_height: 1520,
  });
  const selection = selectQuickLookOverview([historicalEntry]);
  const quickLook = buildQuickLookImages(originals, selection);

  assert.equal(selection?.image, historicalEntry);
  assert.deepEqual(quickLook.slice(0, 3), originals.slice(0, 3));
  assert.equal(quickLook[3].isOverview, true);
  assert.equal(quickLook[3].vehicle_image_path, "entry-history.jpg");
  assert.equal(quickLook[3].vehicle_image_source_kind, "entry_overview_history");
  assert.deepEqual(
    quickLook[3].overviewCropStyle,
    getVehiclePreviewCropStyle(
      historicalEntry.vehicle_image_detection_box,
      historicalEntry.vehicle_image_width,
      historicalEntry.vehicle_image_height
    )
  );
});

test("Quick Look leaves all plate tiles unchanged when no eligible overview exists", () => {
  const originals = plateImages();
  const quickLook = buildQuickLookImages(originals, null);

  assert.equal(quickLook, originals);
  assert.deepEqual(quickLook, originals);
});

test("Quick Look does not displace a plate tile when fewer than four reads exist", () => {
  const originals = plateImages().slice(0, 3);
  const selection = selectQuickLookOverview([validOverview()]);
  const quickLook = buildQuickLookImages(originals, selection);

  assert.equal(quickLook, originals);
  assert.equal(quickLook.some((image) => image.isOverview), false);
});
