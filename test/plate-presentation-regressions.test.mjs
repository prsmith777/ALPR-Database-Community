import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { formatPlateDateTime } from "../lib/plate-date.mjs";

test("missing and invalid plate timestamps render as unavailable", () => {
  for (const timestamp of [null, undefined, "", "not-a-timestamp"]) {
    assert.equal(formatPlateDateTime(timestamp), "—");
  }
});

test("valid plate timestamps honor the configured locale format", () => {
  const timestamp = "2026-07-18T12:34:00.000Z";

  assert.equal(
    formatPlateDateTime(timestamp, 12),
    new Date(timestamp).toLocaleString("en-US")
  );
  assert.equal(
    formatPlateDateTime(timestamp, 24),
    new Date(timestamp).toLocaleString("en-GB")
  );
});

test("plate insights count distinct reads when tag joins multiply rows", async () => {
  const source = await readFile(new URL("../lib/db.js", import.meta.url), "utf8");
  const insightsQuery = source.slice(source.indexOf("export async function getPlateInsights"));

  assert.match(insightsQuery, /COUNT\(DISTINCT pr\.id\) as total_occurrences/);
});
