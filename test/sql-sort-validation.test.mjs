import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  getPlateDatabaseOrderBy,
  getPlateReadsOrderBy,
} from "../lib/sql-sort.mjs";

test("plate database sorting maps each allowed field to fixed SQL", () => {
  assert.deepEqual(getPlateDatabaseOrderBy("plate_number", false), {
    innerOrderBy: "ORDER BY p.plate_number ASC NULLS LAST",
    outerOrderBy: "ORDER BY pd.plate_number ASC NULLS LAST",
  });

  assert.deepEqual(getPlateDatabaseOrderBy("occurrence_count", true), {
    innerOrderBy: "ORDER BY COUNT(pr.id) DESC NULLS LAST",
    outerOrderBy: "ORDER BY pd.occurrence_count DESC NULLS LAST",
  });

  assert.deepEqual(getPlateDatabaseOrderBy("first_seen_at", true), {
    innerOrderBy: "ORDER BY p.first_seen_at DESC NULLS LAST",
    outerOrderBy: "ORDER BY pd.first_seen_at DESC NULLS LAST",
  });

  assert.deepEqual(getPlateDatabaseOrderBy("last_seen_at", false), {
    innerOrderBy: "ORDER BY MAX(pr.timestamp) ASC NULLS LAST",
    outerOrderBy: "ORDER BY pd.last_seen_at ASC NULLS LAST",
  });
});

test("unknown plate database sort fields fall back without entering SQL", () => {
  const attack = "last_seen_at; DROP TABLE plate_reads; --";
  const result = getPlateDatabaseOrderBy(attack, true);

  assert.deepEqual(result, {
    innerOrderBy: "ORDER BY p.first_seen_at DESC NULLS LAST",
    outerOrderBy: "ORDER BY pd.first_seen_at DESC NULLS LAST",
  });

  assert.equal(result.innerOrderBy.includes(attack), false);
  assert.equal(result.outerOrderBy.includes(attack), false);
});

test("plate database sort direction accepts only the boolean false for ascending", () => {
  const result = getPlateDatabaseOrderBy(
    "last_seen_at",
    "ASC; DROP TABLE plates; --"
  );

  assert.equal(
    result.innerOrderBy,
    "ORDER BY MAX(pr.timestamp) DESC NULLS LAST"
  );
  assert.equal(
    result.outerOrderBy,
    "ORDER BY pd.last_seen_at DESC NULLS LAST"
  );
});

test("plate-read sorting accepts only fixed fields and directions", () => {
  assert.equal(
    getPlateReadsOrderBy({
      field: "occurrence_count",
      direction: "asc",
    }),
    "ORDER BY p.occurrence_count ASC, pr.timestamp DESC"
  );

  assert.equal(
    getPlateReadsOrderBy({
      field: "occurrence_count",
      direction: "desc",
    }),
    "ORDER BY p.occurrence_count DESC, pr.timestamp DESC"
  );

  assert.equal(
    getPlateReadsOrderBy({
      field: "timestamp",
      direction: "asc",
    }),
    "ORDER BY pr.timestamp ASC"
  );

  assert.equal(
    getPlateReadsOrderBy({
      field: "timestamp",
      direction: "desc",
    }),
    "ORDER BY pr.timestamp DESC"
  );
});

test("malicious plate-read sort values cannot enter SQL", () => {
  const directionAttack = "ASC; DROP TABLE plate_reads; --";
  const fieldAttack = "occurrence_count; DROP TABLE plates; --";

  const directionResult = getPlateReadsOrderBy({
    field: "occurrence_count",
    direction: directionAttack,
  });

  const fieldResult = getPlateReadsOrderBy({
    field: fieldAttack,
    direction: "asc",
  });

  assert.equal(
    directionResult,
    "ORDER BY p.occurrence_count DESC, pr.timestamp DESC"
  );
  assert.equal(fieldResult, "ORDER BY pr.timestamp DESC");
  assert.equal(directionResult.includes(directionAttack), false);
  assert.equal(fieldResult.includes(fieldAttack), false);
});

test("database queries delegate sorting to the validated helper", async () => {
  const source = await fs.readFile("lib/db.js", "utf8");

  assert.match(source, /getPlateReadsOrderBy\(sort\)/);
  assert.match(
    source,
    /getPlateDatabaseOrderBy\(\s*sortBy,\s*sortDesc\s*\)/
  );

  assert.equal(source.includes("${sort.direction}"), false);
  assert.equal(source.includes('ORDER BY ${sortBy'), false);
  assert.equal(source.includes("`pd.${sortBy}`"), false);
});
