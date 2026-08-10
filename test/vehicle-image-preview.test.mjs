import test from "node:test";
import assert from "node:assert/strict";

import { getVehiclePreviewCropStyle } from "../lib/vehicle-image-preview.mjs";

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
