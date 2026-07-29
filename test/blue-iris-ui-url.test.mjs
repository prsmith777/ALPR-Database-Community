import assert from "node:assert/strict";
import test from "node:test";

import { buildBlueIrisUiUrl } from "../lib/blue-iris-ui-url.mjs";

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
