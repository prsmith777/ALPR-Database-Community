import assert from "node:assert/strict";
import test from "node:test";

import {
  elapsedMilliseconds,
  LIVE_FEED_PERFORMANCE_BUFFER,
  LIVE_FEED_PERFORMANCE_LIMIT,
  recordLiveFeedPerformance,
} from "../lib/live-feed-performance.mjs";

test("live-feed performance metrics retain a bounded diagnostic buffer", () => {
  const target = {};
  const entries = [];
  const logger = { info: (_label, entry) => entries.push(entry) };

  for (let index = 0; index < LIVE_FEED_PERFORMANCE_LIMIT + 5; index += 1) {
    recordLiveFeedPerformance(
      { metric: "viewer_navigation", durationMs: index + 0.04, sequence: index },
      { target, logger, recordedAt: "2026-08-07T00:00:00.000Z" }
    );
  }

  assert.equal(target[LIVE_FEED_PERFORMANCE_BUFFER].length, LIVE_FEED_PERFORMANCE_LIMIT);
  assert.equal(target[LIVE_FEED_PERFORMANCE_BUFFER][0].sequence, 5);
  assert.equal(target[LIVE_FEED_PERFORMANCE_BUFFER].at(-1).durationMs, 104);
  assert.equal(entries.length, LIVE_FEED_PERFORMANCE_LIMIT + 5);
});

test("elapsed live-feed timing rejects invalid clocks and rounds valid durations", () => {
  assert.equal(elapsedMilliseconds(10, 13.456), 3.5);
  assert.equal(elapsedMilliseconds(13, 10), null);
  assert.equal(elapsedMilliseconds("invalid", 10), null);
});
