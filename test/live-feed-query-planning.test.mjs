import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  buildPlateReadVehicleIdentitySql,
  normalizeVehicleIdentityMode,
} from "../lib/plate-read-vehicle-identity.mjs";

const V2_ONLY_RELATIONS = [
  "vehicle_reid_v2_current_read_assignments",
  "vehicle_image_asset_reads",
  "vehicle_asset_embeddings",
];

test("non-authoritative ReID modes omit v2-only Live Feed joins", () => {
  for (const mode of ["v1_primary", "v2_shadow", "v1_rollback"]) {
    const sql = buildPlateReadVehicleIdentitySql(mode, "$3");

    assert.equal(sql.mode, mode);
    assert.equal(sql.joins, "");
    assert.match(sql.columns, /cluster_assignment\.cluster_id/);
    assert.match(sql.columns, /\$3::varchar AS vehicle_identity_mode/);
    assert.match(sql.columns, /TRUE AS vehicle_find_similar_available/);
    for (const relation of V2_ONLY_RELATIONS) {
      assert.equal(sql.columns.includes(relation), false);
      assert.equal(sql.joins.includes(relation), false);
    }
  }
});

test("v2 primary Live Feed SQL keeps authoritative assignment joins", () => {
  const sql = buildPlateReadVehicleIdentitySql("v2_primary", "$9");

  assert.equal(sql.mode, "v2_primary");
  assert.match(sql.columns, /reid_v2_assignment\.canonical_profile_id/);
  assert.match(sql.columns, /\$9::varchar AS vehicle_identity_mode/);
  for (const relation of V2_ONLY_RELATIONS) {
    assert.match(sql.joins, new RegExp(relation));
  }
});

test("unknown modes fail closed to v1 primary SQL", () => {
  assert.equal(normalizeVehicleIdentityMode("unexpected"), "v1_primary");
  assert.equal(normalizeVehicleIdentityMode(null), "v1_primary");

  const sql = buildPlateReadVehicleIdentitySql("unexpected", "$1");
  assert.equal(sql.mode, "v1_primary");
  assert.equal(sql.joins, "");
});

test("Live Feed SQL accepts only positional mode parameters", () => {
  assert.throws(
    () => buildPlateReadVehicleIdentitySql("v2_shadow", "v2_shadow"),
    /positional SQL parameter/
  );
  assert.throws(
    () => buildPlateReadVehicleIdentitySql("v2_shadow", "$1; DROP TABLE plates"),
    /positional SQL parameter/
  );
});

test("getPlateReads selects the mode once and binds it to the data query", async () => {
  const source = await fs.readFile("lib/db.js", "utf8");

  assert.match(
    source,
    /SELECT mode FROM public\.vehicle_reid_control WHERE singleton = TRUE/
  );
  assert.match(
    source,
    /buildPlateReadVehicleIdentitySql\(\s*vehicleIdentityMode,\s*`\$\$\{paramIndex \+ 2\}`\s*\)/
  );
  assert.match(source, /\$\{vehicleIdentitySql\.columns\}/);
  assert.match(source, /\$\{vehicleIdentitySql\.joins\}/);
  assert.match(
    source,
    /client\.query\(dataQuery, \[\s*\.\.\.values,\s*pageSize,\s*offset,\s*vehicleIdentitySql\.mode,\s*\]\)/
  );
  assert.equal(source.includes("CROSS JOIN public.vehicle_reid_control"), false);
});
