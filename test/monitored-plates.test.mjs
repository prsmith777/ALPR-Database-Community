import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("monitored plates add reason, priority, and non-destructive migration metadata", async () => {
  const [migration, database, actions, help] = await Promise.all([
    source("migrations.sql"),
    source("lib/db.js"),
    source("app/actions.js"),
    source("lib/help-manual.mjs"),
  ]);

  assert.match(migration, /monitor_reason TEXT/i);
  assert.match(migration, /monitor_priority VARCHAR\(20\)/i);
  assert.match(migration, /monitored_at TIMESTAMPTZ/i);
  assert.match(migration, /low.*normal.*high.*critical/is);
  assert.match(database, /togglePlateFlag[\s\S]*monitor_reason/);
  assert.match(actions, /revalidatePath\("\/known_plates"\)/);
  assert.match(help, /Monitored Plates replaces the separate Watchlist page/);
});
