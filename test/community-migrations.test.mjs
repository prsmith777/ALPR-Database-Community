import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { compileMigrations } from "../scripts/build-migrations.mjs";

test("the old updater entry point is the complete, current checksummed bundle", async () => {
  const { sql, manifest } = await compileMigrations();
  assert.equal((await readFile(new URL("../migrations.sql", import.meta.url), "utf8")).replace(/\r\n/g,"\n"), sql);
  assert.equal(new Set(manifest.map(row => row.version)).size, manifest.length);
  assert.ok(manifest.length >= 75);
  assert.ok(!sql.includes("\\ir "), "older packages require no external source files");
});
