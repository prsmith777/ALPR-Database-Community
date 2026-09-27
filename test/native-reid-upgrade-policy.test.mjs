import assert from "node:assert/strict";
import test from "node:test";
import {
  captureNativeUpgradeSnapshot, compareSavedNativeUpgradeCounts, nativeIdentityInstalled,
} from "../scripts/native-reid-upgrade-policy.mjs";

test("stopped-source evidence counts only unbound non-Blue-Iris direction data", async () => {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    if (sql.includes("schema_migrations")) return "f";
    if (sql.includes("information_schema")) return "t";
    return sql.includes("vehicle_orientation_labels") ? "2" : "1";
  };
  const before = { schema_migrations: 1, capture_assets: 4, vehicle_orientation_labels: 5,
    vehicle_direction_observations: 4, plate_reads: 24, users: 1, tags: 2 };
  const snapshot = await captureNativeUpgradeSnapshot(query, before);
  assert.deepEqual(snapshot, { formatVersion: 1, native: false,
    directionRetirements: { vehicle_orientation_labels: "2", vehicle_direction_observations: "1" } });
  assert.match(calls.at(-1), /classifier_version <> 'blue-iris-zone-crossing-v1' AND source_embedding_id IS NULL/);
  const after = { schema_migrations: 2, vehicle_orientation_labels: 3,
    vehicle_direction_observations: 3, plate_reads: 24, users: 1, tags: 2 };
  assert.deepEqual(compareSavedNativeUpgradeCounts(before, after, snapshot, true).losses, []);
  for (const table of ["plate_reads", "users", "tags", "vehicle_orientation_labels", "vehicle_direction_observations"]) {
    assert.equal(compareSavedNativeUpgradeCounts(before, { ...after, [table]: after[table] - 1 }, snapshot, true).losses[0].table, table);
  }
  assert.equal(compareSavedNativeUpgradeCounts({ ...before, unknown: 0 }, after, snapshot, true).losses[0].table, "unknown");
  assert.throws(() => compareSavedNativeUpgradeCounts(before, after, snapshot, false), /lacks the completed/);
});

test("native upgrades never re-use a historical retirement allowance", async () => {
  const before = { schema_migrations: 2, vehicle_reid_control: 1, vehicle_direction_observations: 3, capture_assets: 0 };
  const snapshot = await captureNativeUpgradeSnapshot(async () => "t", before);
  assert.equal(snapshot.native, true);
  assert.deepEqual(snapshot.directionRetirements, {});
  const result = compareSavedNativeUpgradeCounts(before,
    { schema_migrations: 2, vehicle_reid_control: 1, vehicle_direction_observations: 2 }, snapshot, true);
  assert.deepEqual(result.losses.map(({ table }) => table), ["vehicle_direction_observations", "capture_assets"]);
});

test("missing or malformed evidence, corrupt authority, and impossible allowances fail closed", async () => {
  for (const snapshot of [null, {}, { formatVersion: 1, native: false, directionRetirements: [] },
    { formatVersion: 1, native: false, directionRetirements: "bad" },
    { formatVersion: 1, native: false, directionRetirements: { users: 99 } }]) {
    assert.throws(() => compareSavedNativeUpgradeCounts({}, {}, snapshot, true), /older updater/);
  }
  await assert.rejects(nativeIdentityInstalled(async () => "t", { schema_migrations: 1 }), /control is missing/);
  await assert.rejects(nativeIdentityInstalled(async (sql) => sql.includes("schema_migrations") ? "t" : "f",
    { schema_migrations: 1, vehicle_reid_control: 1 }), /control is invalid/);
  await assert.rejects(nativeIdentityInstalled(async () => "nonsense", { schema_migrations: 1 }), /attestation/);
  assert.throws(() => compareSavedNativeUpgradeCounts({ vehicle_orientation_labels: 2 }, {},
    { formatVersion: 1, native: false, directionRetirements: { vehicle_orientation_labels: "3" } }, true), /Invalid stopped-source/);
});
