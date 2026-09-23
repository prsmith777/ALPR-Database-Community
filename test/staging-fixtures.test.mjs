import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureSql = await readFile(
  new URL("../scripts/staging-fixtures.sql", import.meta.url),
  "utf8",
);
const schemaSql = await readFile(
  new URL("../schema.sql", import.meta.url),
  "utf8",
);
const migrationsSql = await readFile(
  new URL("../migrations.sql", import.meta.url),
  "utf8",
);

test("synthetic fixtures are explicit and excluded from normal startup SQL", () => {
  assert.doesNotMatch(schemaSql, /codex_staging_fixture/i);
  assert.doesNotMatch(migrationsSql, /codex_staging_fixture/i);
  assert.match(fixtureSql, /fixture_load/);
  assert.match(fixtureSql, /fixture_status/);
  assert.match(fixtureSql, /fixture_clear/);
  assert.match(fixtureSql, /current_database\(\) = :'fixture_database'/);
});

test("fixture ownership and cleanup use an exact manifest", () => {
  assert.match(fixtureSql, /CREATE TABLE IF NOT EXISTS public\.codex_staging_fixture_sets/);
  assert.match(fixtureSql, /CREATE TABLE IF NOT EXISTS public\.codex_staging_fixture_manifest/);
  assert.match(fixtureSql, /entity_type = 'plate_read'/);
  assert.match(fixtureSql, /m\.entity_key = r\.id::text/);
  assert.match(fixtureSql, /pg_advisory_xact_lock/);
  assert.match(fixtureSql, /Refusing cleanup because fixture records have unowned dependent data/);
  assert.doesNotMatch(fixtureSql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(fixtureSql, /setval\s*\(/i);
  assert.doesNotMatch(fixtureSql, /DELETE\s+FROM\s+public\.plate_reads\s*;/i);
  assert.doesNotMatch(
    fixtureSql,
    /m\.entity_type\s*=\s*'tag'\s+AND\s+m\.entity_key\s*=\s*pt\.tag_id::text/i,
  );
});

test("fixture identifiers fit the deployed schema and are visibly synthetic", () => {
  const plateNumbers = [
    ...fixtureSql.matchAll(/'((?:TST)[A-Z0-9]+)'/g),
  ].map((match) => match[1]);
  assert.ok(plateNumbers.length > 0);
  assert.equal(plateNumbers.every((plate) => plate.length <= 10), true);

  const cameraNames = [
    ...fixtureSql.matchAll(/'(STG-FIX-[A-Z]+)'/g),
  ].map((match) => match[1]);
  assert.ok(cameraNames.length > 0);
  assert.equal(cameraNames.every((camera) => camera.length <= 25), true);

  assert.match(fixtureSql, /SYNTHETIC TEST DATA/);
  assert.match(fixtureSql, /codex-fixture:ux-v1:/);
  assert.match(fixtureSql, /Refusing to mix synthetic fixtures with unowned staging data/);
});
