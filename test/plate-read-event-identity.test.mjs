import assert from "node:assert/strict";
import test from "node:test";

import { createPlateReadEventIdentity } from "../lib/plate-read-event-identity.mjs";

test("plate-read event identities are stable for the same canonical event", () => {
  const first = createPlateReadEventIdentity({
    plateNumber: "dpom90",
    timestamp: "2026-07-17T15:30:45.250Z",
    cameraName: "Entry LPR 1",
  });
  const second = createPlateReadEventIdentity({
    plateNumber: "DPOM90",
    timestamp: new Date("2026-07-17T15:30:45.250Z"),
    cameraName: "Entry LPR 1",
  });

  assert.equal(first, second);
  assert.match(first, /^plate-read-v1:[a-f0-9]{64}$/);
  assert.ok(first.length <= 80);
});

test("different cameras and timestamps produce independent event identities", () => {
  const base = {
    plateNumber: "DPOM90",
    timestamp: "2026-07-17T15:30:45.250Z",
    cameraName: "Entry LPR 1",
  };

  assert.notEqual(
    createPlateReadEventIdentity(base),
    createPlateReadEventIdentity({ ...base, cameraName: "Entry LPR 2" })
  );
  assert.notEqual(
    createPlateReadEventIdentity(base),
    createPlateReadEventIdentity({
      ...base,
      timestamp: "2026-07-17T15:30:45.251Z",
    })
  );
});

test("invalid event identity inputs are rejected", () => {
  assert.throws(
    () => createPlateReadEventIdentity({ timestamp: new Date() }),
    /Plate number cannot be empty/
  );
  assert.throws(
    () =>
      createPlateReadEventIdentity({
        plateNumber: "ABC123",
        timestamp: "not-a-date",
      }),
    /timestamp must be a valid date/
  );
});
