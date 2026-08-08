import assert from "node:assert/strict";
import test from "node:test";

import { assessDirectionPixels } from "../lib/direction-image-eligibility.mjs";

test("monochrome nighttime frames are unavailable for direction", () => {
  const pixels = Buffer.alloc(24 * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const value = 35 + (offset % 30);
    pixels[offset] = value;
    pixels[offset + 1] = value + 2;
    pixels[offset + 2] = value - 2;
  }
  assert.deepEqual(assessDirectionPixels(pixels), {
    eligible: false,
    evaluated: true,
    monochrome: true,
    monochromeRatio: 1,
    reason: "monochrome_night_capture",
  });
});

test("color daytime frames remain eligible for direction", () => {
  const pixels = Buffer.from([
    200, 40, 20,
    30, 170, 45,
    20, 60, 210,
    190, 150, 25,
  ]);
  const result = assessDirectionPixels(pixels);
  assert.equal(result.eligible, true);
  assert.equal(result.monochrome, false);
  assert.equal(result.reason, null);
});
