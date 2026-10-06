import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { hashFile } from "../scripts/windows-native-package.mjs";
import { createMigrationBundle, verifyMigrationBundle, stageMigrationBundle } from "../scripts/community-migration-bundle.mjs";
import { normalizeMigratedStorageReference, restoreWindowsMigration } from "../scripts/windows-migration.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "alpr-migration-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const storage = path.join(source, "storage");
  await mkdir(path.join(storage, "images"), { recursive: true });
  await writeFile(path.join(storage, "images", "fixture.jpg"), "fixture image");
  const dump = path.join(source, "postgres.dump");
  await writeFile(dump, "fixture logical dump");
  const manifest = { formatVersion: 3, source: { serverMajor: 17, applicationProfile: "alpr-community-v0.1.20-plus",
    schemaFingerprint: "A".repeat(64), tableCounts: { plate_reads: "1" } }, dump: { sha256: (await hashFile(dump)).toUpperCase(), sizeBytes: (await readFile(dump)).length } };
  await writeFile(dump + ".manifest.json", JSON.stringify(manifest));
  return { root, storage, storagePath: storage, dumpPath: dump, destination: path.join(root, "backup"), sourceQuiesced: true };
}

test("Linux and Windows logical backups share a verified portable file format", async (t) => {
  const f = await fixture(t);
  const manifest = await createMigrationBundle(f);
  assert.equal(manifest.files["storage/images/fixture.jpg"], await hashFile(path.join(f.storage, "images", "fixture.jpg")));
  await verifyMigrationBundle(f.destination);
  await stageMigrationBundle(f.destination, path.join(f.root, "staged"));
  await writeFile(path.join(f.destination, "storage", "images", "fixture.jpg"), "changed");
  await assert.rejects(verifyMigrationBundle(f.destination), /changed/);
});

test("backup creation refuses overwrite, a running source, and malformed dump evidence", async (t) => {
  const f = await fixture(t);
  await assert.rejects(createMigrationBundle({ ...f, sourceQuiesced: false }), /Stop source/);
  await createMigrationBundle(f);
  await assert.rejects(createMigrationBundle(f), /EEXIST/);
  await writeFile(f.dumpPath, "corrupt");
  await assert.rejects(createMigrationBundle({ ...f, destination: path.join(f.root, "another") }), /does not match/);
});

test("portable backup captures environment-owned camera credentials and time zone without old database credentials", async (t) => {
  const f = await fixture(t);
  const configPath = path.join(f.root, "settings.yaml");
  await writeFile(configPath, "general:\n  maxRecords: 4321\ndatabase:\n  password: do-not-transfer\nblueiris:\n  username: saved-user\n");
  await createMigrationBundle({ ...f, configPath, configEnvironment: {
    TZ: "America/Denver", BLUEIRIS_HOST: "http://fixture.invalid", BLUEIRIS_PASSWORD: "fixture-private-password", DB_PASSWORD: "must-not-transfer",
  } });
  const manifest = await verifyMigrationBundle(f.destination);
  assert.equal(manifest.runtimeTimeZone, "America/Denver");
  const config = await readFile(path.join(f.destination, "config/settings.yaml"), "utf8");
  assert.match(config, /saved-user/); assert.match(config, /fixture-private-password/);
  assert.doesNotMatch(config, /do-not-transfer|must-not-transfer/);
  assert.match(await readFile(configPath, "utf8"), /do-not-transfer/, "The source config must stay unchanged");
});

test("Windows restore refuses a nonempty database before modifying any data", async (t) => {
  const f = await fixture(t);
  await createMigrationBundle(f);
  await assert.rejects(restoreWindowsMigration({ bundleRoot: f.destination }, {
    confirmed: true, deployment: { sql() { return "1"; }, pg() { assert.fail("must not restore"); } },
  }), /existing database/);
});

test("legacy paths become portable without accepting traversal or external image roots", () => {
  for (const input of ["images/a.jpg", "images\\a.jpg", "/app/storage/images/a.jpg", "C:\\ALPR\\storage\\images\\a.jpg"]) {
    assert.equal(normalizeMigratedStorageReference(input), "images/a.jpg");
  }
  for (const input of ["../images/a.jpg", "/app/../storage/images/a.jpg", "C:/Users/name/file.txt", "images/CON.jpg"]) {
    assert.throws(() => normalizeMigratedStorageReference(input));
  }
});
