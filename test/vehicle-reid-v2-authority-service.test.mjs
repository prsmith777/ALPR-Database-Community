import assert from "node:assert/strict";
import test from "node:test";
import { VehicleReidV2AuthorityService } from "../lib/vehicle-reid-v2-authority-service.mjs";

test("profile review passes the authenticated actor through for merges and withdrawals", async () => {
  const actor = { id: 7, username: "reviewer", displayName: "Reviewer" };
  for (const result of [{ merged: true, split: false }, { merged: false, split: true }]) {
    const service = new VehicleReidV2AuthorityService({ repository: {
      async mergeProfilesByReview(input) {
        assert.deepEqual(input, { reviewId: 42, actor });
        return result;
      },
    } });
    assert.deepEqual(await service.mergeProfilesByReview({ reviewId: 42, actor }), result);
  }
});
