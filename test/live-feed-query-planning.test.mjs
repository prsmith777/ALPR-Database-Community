import test from "node:test";
import assert from "node:assert/strict";
import { hydratePlateReadVehicleIdentity, PRIMARY_PLATE_READ_IDENTITY_SQL } from "../lib/plate-read-vehicle-identity.mjs";
import { withReadOnlySnapshot } from "../lib/read-only-snapshot.mjs";
import { createQueryTiming } from "../lib/query-timing.mjs";

function identityClient(identities = []) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql, params });
    return { rows: identities };
  } };
}

test("canonical identities preserve row order with one bounded query", async () => {
  const client = identityClient([
    { read_id: "20", canonical_profile_id: "8", assignment_basis: "exact_effective_plate", searchable: false },
    { read_id: "21", canonical_profile_id: null, assignment_basis: null, searchable: true },
  ]);
  const rows = [{ id: 21, marker: "first" }, { id: "20" }, { id: 22 }];
  const result = await hydratePlateReadVehicleIdentity(client, rows);
  assert.deepEqual(result.map(row => row.id), [21, "20", 22]);
  assert.equal(result[0].marker, "first");
  assert.equal(result[0].vehicle_find_similar_available, true);
  assert.equal(result[1].vehicle_profile_id, "8");
  assert.equal(result[1].vehicle_profile_assignment_basis, "exact_effective_plate");
  assert.equal(result[1].vehicle_find_similar_available, false);
  assert.equal(result[2].vehicle_profile_id, null);
  assert.equal(result[2].vehicle_find_similar_available, false);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].sql, PRIMARY_PLATE_READ_IDENTITY_SQL);
  assert.deepEqual(client.calls[0].params, [[21, "20", 22]]);
  assert.deepEqual(rows, [{ id: 21, marker: "first" }, { id: "20" }, { id: 22 }]);
});

test("identity query failure is not reported as successful unassigned data", async () => {
  await assert.rejects(hydratePlateReadVehicleIdentity({
    query() { throw new Error("database unavailable"); },
  }, [{ id: 1 }]), /database unavailable/);
});

test("empty pages require no identity queries", async () => {
  const client = identityClient();
  const rows = [];
  assert.equal(await hydratePlateReadVehicleIdentity(client, rows), rows);
  assert.equal(client.calls.length, 0);
});

function snapshotPool(failure) {
  const calls = [];
  const client = { async query(sql) {
    calls.push(sql);
    if (sql === failure) throw new Error(failure);
    return { rows: [] };
  }, release() { calls.push("release"); } };
  return { calls, client, async connect() { calls.push("connect"); return client; } };
}

test("feed snapshot uses one read-only repeatable-read client and commits before releasing", async () => {
  const pool = snapshotPool();
  assert.equal(await withReadOnlySnapshot(pool, async client => {
    assert.equal(client, pool.client);
    await client.query("page");
    await client.query("identity");
    return "result";
  }), "result");
  assert.deepEqual(pool.calls, ["connect", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "page", "identity", "COMMIT", "release"]);
});

test("snapshot rolls back on query, begin, or commit failure and always releases", async () => {
  for (const failing of ["page", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT"]) {
    const pool = snapshotPool(failing);
    await assert.rejects(withReadOnlySnapshot(pool, client => client.query("page")), { message: failing });
    assert.deepEqual(pool.calls.slice(-2), ["ROLLBACK", "release"]);
  }
});

test("rollback failure preserves the original error; connection failure never runs work", async () => {
  const pool = snapshotPool("ROLLBACK");
  await assert.rejects(withReadOnlySnapshot(pool, async () => { throw new Error("original"); }), /original/);
  assert.deepEqual(pool.calls.slice(-2), ["ROLLBACK", "release"]);
  await assert.rejects(withReadOnlySnapshot({ connect() { throw new Error("connection"); } },
    () => assert.fail("must not run")), /connection/);
});

test("timings log only slow stage durations, including a failed operation", async () => {
  let now = 0;
  const logs = [];
  const timing = createQueryTiming("feed", { clock: () => now, logger: { info: (...args) => logs.push(args) } });
  await timing.measure("page", async () => { now = 100; return "not logged"; });
  timing.finish();
  assert.equal(logs.length, 0);
  await assert.rejects(timing.measure("identity", async () => { now = 500; throw new Error("not logged"); }));
  timing.finish();
  assert.deepEqual(logs, [["feed", { totalMs: 500, stages: { page: 100, identity: 400 } }]]);
});
