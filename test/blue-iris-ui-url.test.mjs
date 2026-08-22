import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBlueIrisTimelinePath,
  buildBlueIrisUiUrl,
  withBlueIrisCamera,
} from "../lib/blue-iris-ui-url.mjs";

test("Blue Iris UI URLs accept saved hosts with or without a scheme", () => {
  const path = "ui3.htm?rec=14638483532154750-919666&cam=Street%20LPR%202";

  assert.equal(
    buildBlueIrisUiUrl("192.168.0.167:81", path),
    "http://192.168.0.167:81/ui3.htm?rec=14638483532154750-919666&cam=Street%20LPR%202"
  );
  assert.equal(
    buildBlueIrisUiUrl("http://192.168.0.167:81/", `/${path}`),
    "http://192.168.0.167:81/ui3.htm?rec=14638483532154750-919666&cam=Street%20LPR%202"
  );
});

test("Blue Iris UI URLs reject incomplete inputs", () => {
  assert.equal(buildBlueIrisUiUrl("", "ui3.htm"), "");
  assert.equal(buildBlueIrisUiUrl("192.168.0.167:81", ""), "");
  assert.equal(buildBlueIrisUiUrl("192.168.0.167:81", "https://example.com/ui3.htm"), "");
});

test("vehicle-view playback targets the overview camera at the captured frame time", () => {
  const path = buildBlueIrisTimelinePath(
    "Cam149",
    "2026-08-22T18:20:31.456Z"
  );

  assert.equal(
    path,
    "ui3.htm?tab=timeline&cam=Cam149&timeline=1787422831456&maximize=1"
  );
  assert.equal(
    buildBlueIrisUiUrl("192.168.0.167:81", path),
    "http://192.168.0.167:81/ui3.htm?tab=timeline&cam=Cam149&timeline=1787422831456&maximize=1"
  );
  assert.equal(buildBlueIrisTimelinePath("", "2026-08-22T18:20:31.456Z"), "");
  assert.equal(buildBlueIrisTimelinePath("Entry Overview", "invalid"), "");
});

test("saved alert playback paths replace display names with Blue Iris short camera IDs", () => {
  assert.equal(
    withBlueIrisCamera(
      "ui3.htm?rec=14638483532154750-919666&cam=Street%20LPR%202",
      "Cam146",
    ),
    "ui3.htm?rec=14638483532154750-919666&cam=Cam146",
  );
  assert.equal(withBlueIrisCamera("ui3.htm?tab=clips", "Cam146"), "ui3.htm?tab=clips&cam=Cam146");
  assert.equal(withBlueIrisCamera("", "Cam146"), "");
});
