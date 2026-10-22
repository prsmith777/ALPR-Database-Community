import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStateCountry, savePlateStateCountry, listPlateStateCountries } from "../lib/plate-state-country.mjs";
import { plateCorrectionDefaults, isAliasOnlyCorrection } from "../lib/plate-correction-defaults.mjs";
import { getInitialEnvConfig } from "../lib/settings.js";

function fixture({ previous = null, missing = false, failAudit = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT state_country")) return { rows: missing ? [] : [{ state_country: previous }] };
      if (sql.startsWith("INSERT") && failAudit) throw new Error("audit unavailable");
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  return { calls, getPool: async () => ({ connect: async () => client }) };
}

test("correction defaults enable each authorized feature independently on every new draft", () => {
  assert.deepEqual(plateCorrectionDefaults({ canBatchReview: true, canManageAliases: true }), { correctAll: true, rememberAlias: true });
  assert.deepEqual(plateCorrectionDefaults({ canBatchReview: true }), { correctAll: true, rememberAlias: false });
  assert.deepEqual(plateCorrectionDefaults({ canManageAliases: true }), { correctAll: false, rememberAlias: true });
  assert.deepEqual(plateCorrectionDefaults(), { correctAll: false, rememberAlias: false });
  const draft = plateCorrectionDefaults({ canBatchReview: true, canManageAliases: true });
  draft.correctAll = false;
  assert.equal(plateCorrectionDefaults({ canBatchReview: true }).correctAll, true);
});

test("State/Country is hidden on new installations", () => {
  assert.equal(getInitialEnvConfig({}).general.showStateCountry, false);
});

test("manual values support international names, trimming and clearing without accepting invalid input", () => {
  assert.equal(normalizeStateCountry("  Québec, Canada  "), "Québec, Canada");
  assert.equal(normalizeStateCountry("日本"), "日本");
  assert.equal(normalizeStateCountry("   "), null);
  for (const value of [undefined, null, {}, 12, "x".repeat(101), "USA\nColorado", "\u0000"]) {
    assert.throws(() => normalizeStateCountry(value), { code: "INVALID_STATE_COUNTRY" });
  }
});

test("saving shared plate metadata and its audit record is one transaction", async () => {
  const f = fixture({ previous: "Canada" });
  const result = await savePlateStateCountry(f.getPool, { plateNumber: " abc123 ", stateCountry: " Colorado, USA ", actor: { id: 7 } });
  assert.deepEqual(result, { plate_number: "ABC123", state_country: "Colorado, USA" });
  const update = f.calls.find(call => call.sql.startsWith("UPDATE"));
  assert.deepEqual(update.values, ["ABC123", "Colorado, USA"]);
  const audit = f.calls.find(call => call.sql.startsWith("INSERT"));
  assert.deepEqual(audit.values, [7, "ABC123", JSON.stringify({ previous: "Canada", stateCountry: "Colorado, USA" })]);
  assert.match(f.calls[1].sql, /FOR UPDATE/);
  assert.deepEqual(f.calls.map(call => call.sql).filter(sql => ["BEGIN", "COMMIT", "ROLLBACK", "RELEASE"].includes(sql)), ["BEGIN", "COMMIT", "RELEASE"]);
  assert.ok(!f.calls.some(call => /UPDATE.*plate_reads|observed_plate/.test(call.sql)));
});

test("empty input clears metadata and unchanged saves do not duplicate audit events", async () => {
  const f = fixture({ previous: "USA" });
  await savePlateStateCountry(f.getPool, { plateNumber: "ABC123", stateCountry: "" });
  assert.deepEqual(f.calls.find(call => call.sql.startsWith("UPDATE")).values, ["ABC123", null]);
  const unchanged = fixture({ previous: "USA" });
  await savePlateStateCountry(unchanged.getPool, { plateNumber: "ABC123", stateCountry: "USA" });
  assert.ok(!unchanged.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql)));
});

test("audit failures roll back metadata and missing plates are never created implicitly", async () => {
  const f = fixture({ failAudit: true });
  await assert.rejects(savePlateStateCountry(f.getPool, { plateNumber: "ABC123", stateCountry: "USA" }), /audit unavailable/);
  assert.ok(f.calls.some(call => call.sql === "ROLLBACK"));
  assert.ok(!f.calls.some(call => call.sql === "COMMIT"));
  assert.equal(f.calls.at(-1).sql, "RELEASE");
  const missing = fixture({ missing: true });
  await assert.rejects(savePlateStateCountry(missing.getPool, { plateNumber: "ABC123", stateCountry: "USA" }), { code: "PLATE_NOT_FOUND" });
  assert.ok(!missing.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql)));
});

test("invalid input is rejected before connecting to a database", async () => {
  const getPool = () => assert.fail("must not connect");
  await assert.rejects(savePlateStateCountry(getPool, { plateNumber: "ABC123", stateCountry: "x".repeat(101) }), { code: "INVALID_STATE_COUNTRY" });
  await assert.rejects(savePlateStateCountry(getPool, { plateNumber: "", stateCountry: "USA" }), { code: "INVALID_PLATE" });
});

test("previous entries come from saved manual values in alphabetical order without case duplicates", async () => {
  const options = await listPlateStateCountries(async () => ({
    async query(sql) {
      assert.match(sql, /DISTINCT ON \(LOWER\(state_country\)\)/);
      assert.match(sql, /NULLIF\(BTRIM\(state_country\), ''\) IS NOT NULL/);
      assert.match(sql, /ORDER BY LOWER\(state_country\), state_country/);
      return { rows: [{ state_country: "Colorado, USA" }, { state_country: "Québec, Canada" }] };
    },
  }));
  assert.deepEqual(options, ["Colorado, USA", "Québec, Canada"]);
});

test("enabled alias defaults never make an unchanged OCR value into a self-alias", () => {
  const correction = { plateNumber: "ABC123", observedPlate: "ABC123", newPlateNumber: "ABC123", rememberAlias: true };
  assert.equal(isAliasOnlyCorrection(correction), false);
  assert.equal(isAliasOnlyCorrection({ ...correction, observedPlate: "ABC128" }), true);
  assert.equal(isAliasOnlyCorrection({ ...correction, observedPlate: "ABC128", rememberAlias: false }), false);
  assert.equal(isAliasOnlyCorrection({ ...correction, newPlateNumber: "ABC129" }), false);
});
