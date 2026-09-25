import assert from "node:assert/strict";
import test from "node:test";

import {
  addSseClient,
  liveFeedEventStateForTest,
  publishPlateReadChanges,
  removeSseClient,
  resetLiveFeedEventStateForTest,
} from "../lib/sse.js";

test("Live Feed events normalize read ids and fan out one revision", () => {
  resetLiveFeedEventStateForTest();
  const messages = [];
  const clientId = addSseClient((message) => messages.push(message));

  const revision = publishPlateReadChanges([7, "8", 7, 0, "bad"], "ingested");

  assert.equal(revision, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^id: 1\nevent: plate-reads-changed\n/);
  assert.deepEqual(JSON.parse(messages[0].match(/data: (.+)\n\n$/)[1]), {
    readIds: [7, 8],
    reason: "ingested",
    revision: 1,
  });
  assert.deepEqual(liveFeedEventStateForTest(), { clients: 1, revision: 1 });

  removeSseClient(clientId);
  assert.deepEqual(liveFeedEventStateForTest(), { clients: 0, revision: 1 });
  resetLiveFeedEventStateForTest();
});

test("Live Feed stream uses a route-handler ReadableStream and ingestion publishes after commit", async () => {
  const fs = await import("node:fs/promises");
  const [route, ingestion, wrapper, delta] = await Promise.all([
    fs.readFile("app/api/sse/route.js", "utf8"),
    fs.readFile("app/api/plate-reads/route.js", "utf8"),
    fs.readFile("components/PlateTableWrapper.jsx", "utf8"),
    fs.readFile("app/api/live-feed/changes/route.js", "utf8"),
  ]);

  assert.match(route, /new ReadableStream/);
  assert.doesNotMatch(route, /req\.res/);
  assert.match(ingestion, /await dbClient\.query\("COMMIT"\);[\s\S]*?publishPlateReadChanges/);
  assert.doesNotMatch(ingestion, /setTimeout\(resolve, 100\)/);
  assert.match(wrapper, /new EventSource\("\/api\/sse"\)/);
  assert.match(delta, /filters: \{ readIds \}/);
  assert.match(delta, /Server-Timing/);
});
