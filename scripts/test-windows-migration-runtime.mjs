import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { nativeRunner } from "./windows-deployment.mjs";
import { BlueIrisVehicleFrameRepository } from "../lib/blue-iris-vehicle-frame-repository.mjs";

const [targetArgument, sourceArgument, pgArgument] = process.argv.slice(2);
if (!targetArgument || !sourceArgument || !pgArgument) throw new Error("Use TARGET_RELEASE SOURCE_RELEASE PG17_BIN (only disposable clusters are created).");
const targetRelease = path.resolve(targetArgument), sourceRelease = path.resolve(sourceArgument), pgBin = path.resolve(pgArgument);
const { exportWindowsMigration, restoreWindowsMigration } = await import(targetRelease === path.resolve(import.meta.dirname, "..")
  ? "./windows-migration.mjs" : pathToFileURL(path.join(targetRelease, "host", "windows-migration.mjs")).href);
const root = await mkdtemp(path.join(os.tmpdir(), "alpr-migration-runtime-"));
const clusters = [];
async function freePort() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function cluster(name, release) {
  const home = path.join(root, name), data = path.join(home, "data"), database = path.join(home, "postgres");
  const secret = randomBytes(32).toString("hex"), port = await freePort();
  for (const folder of ["auth", "config", "storage", "management/backups"]) await mkdir(path.join(data, folder), { recursive: true });
  await writeFile(path.join(home, "password.tmp"), secret);
  const env = { ...process.env, PGPASSWORD: secret };
  const run = (exe, args) => nativeRunner(exe, args, { env, ...(path.basename(exe) === "pg_ctl.exe" ? { stdio: "ignore" } : {}) });
  run(path.join(pgBin, "initdb.exe"), ["-D", database, "-U", "postgres", "--encoding=UTF8", "--auth=scram-sha-256", "--pwfile=" + path.join(home, "password.tmp")]);
  run(path.join(pgBin, "pg_ctl.exe"), ["-D", database, "-l", path.join(home, "postgres.log"), "-o", "-h 127.0.0.1 -p " + port, "-w", "start"]);
  clusters.push({ database, run });
  const db = (exe, args) => run(path.join(pgBin, exe + ".exe"), ["--host", "127.0.0.1", "--port", String(port), "--username", "postgres", "--dbname", "postgres", ...args]);
  const sql = (statement) => db("psql", ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "-At", "-c", statement]);
  const operations = [];
  const deployment = { data, currentPath: release, current: { commit: "f".repeat(40) }, backupRoot: path.join(data, "management/backups"),
    installation: { pgBin, environment: { DB_HOST: "127.0.0.1:" + port, DB_PASSWORD: secret, ADMIN_PASSWORD: secret,
      TZ: "America/Denver", BLUEIRIS_HOST: "http://synthetic-camera.invalid", BLUEIRIS_PASSWORD: "synthetic-private-camera-password" } },
    sql, pg: db, run, service(operation) { operations.push(operation); },
    async attest() { return { listenerOwned: true, status: "Running", commit: "f".repeat(40) }; },
    async counts() {
      const tables = sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;").split(/\r?\n/).filter(Boolean);
      assert.ok(tables.every((table) => /^[a-z_][a-z0-9_]*$/.test(table)));
      if (!tables.length) return {};
      return JSON.parse(sql("SELECT json_object_agg(name,total ORDER BY name) FROM (" + tables.map((table) =>
        "SELECT '" + table + "' AS name, count(*)::text AS total FROM public." + table).join(" UNION ALL ") + ") counts;"));
    },
    migrate(selected) { db("psql", ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--single-transaction", "--file", path.join(selected, "migrations.sql")]); },
  };
  return { home, data, secret, sql, db, port, operations, deployment };
}
try {
  for (const baseline of ["legacy", "community"]) {
    const source = await cluster(baseline + "-source", sourceRelease);
    source.db("psql", ["--set", "ON_ERROR_STOP=1", "--single-transaction", "--file", path.join(sourceRelease, "schema.sql")]);
    if (baseline === "community") source.deployment.migrate(sourceRelease);
    await mkdir(path.join(source.data, "storage/images"));
    await writeFile(path.join(source.data, "storage/images/fixture.jpg"), "synthetic portable image");
    await writeFile(path.join(source.data, "config/settings.yaml"), "general:\n  maxRecords: 4321\ndatabase:\n  password: source-secret-must-not-transfer\n");
    await writeFile(path.join(source.data, "auth/auth.json"), JSON.stringify({ password: "legacy-hash", apiKey: "a".repeat(64), sessions: { old: {} } }));
    source.sql(`INSERT INTO public.plates(plate_number,occurrence_count) VALUES ('MIG0001',1);
      INSERT INTO public.plate_reads(plate_number,camera_name,image_path,"timestamp") VALUES ('MIG0001','My LPR','images/fixture.jpg',CURRENT_TIMESTAMP);`);
    if (baseline === "community") source.sql(`INSERT INTO public.users(username,display_name,password_hash) VALUES ('fixture-user','Fixture user','fixture-retained-hash');
      INSERT INTO public.user_sessions(user_id,token_hash,expires_at) SELECT id,'${"b".repeat(64)}',CURRENT_TIMESTAMP+INTERVAL '1 day' FROM public.users WHERE username='fixture-user';`);
    const destination = path.join(root, baseline + "-backup");
    await exportWindowsMigration({ destination }, { deployment: source.deployment });
    assert.deepEqual(source.operations, ["stop", "start"]);
    const target = await cluster(baseline + "-target", targetRelease);
    const result = await restoreWindowsMigration({ bundleRoot: destination }, { deployment: target.deployment, confirmed: true });
    assert.equal(result.status, "validated");
    assert.equal(target.sql("SELECT count(*) FROM public.plate_reads WHERE plate_number='MIG0001';"), "1");
    assert.equal(await readFile(path.join(target.data, "storage/images/fixture.jpg"), "utf8"), "synthetic portable image");
    const config = await readFile(path.join(target.data, "config/settings.yaml"), "utf8");
    assert.ok(config.includes("4321") && !config.includes("source-secret"));
    assert.ok(config.includes("synthetic-private-camera-password"), "Environment-owned camera credentials must survive the move");
    assert.equal(target.deployment.installation.environment.TZ, "America/Denver");
    const auth = JSON.parse(await readFile(path.join(target.data, "auth/auth.json"), "utf8"));
    assert.equal(auth.apiKey, "a".repeat(64)); assert.deepEqual(auth.sessions, {});
    const { default: bcrypt } = await import("bcrypt");
    assert.ok(await bcrypt.compare(target.secret, auth.password));
    if (baseline === "community") {
      assert.equal(target.sql("SELECT password_hash FROM public.users WHERE username='fixture-user';"),"fixture-retained-hash");
      assert.equal(target.sql("SELECT count(*) FROM public.user_sessions WHERE revoked_at IS NOT NULL AND revoke_reason='computer migration';"),"1");
    }
    await assert.rejects(restoreWindowsMigration({ bundleRoot: destination }, { deployment: target.deployment, confirmed: true }), /existing database/);
    // Save, switch, and claim an explicitly configured LPR camera through real SQL.
    const pool = new pg.Pool({ host: "127.0.0.1", port: target.port, user: "postgres", database: "postgres", password: target.secret });
    try {
      const repository = new BlueIrisVehicleFrameRepository(pool);
      const overview = { plateCameraName: "My LPR", directionLabel: "Arriving", sourceCameraName: "Wide view", sourceCameraShortName: "Wide01",
        sourceRole: "primary", overviewContext: "street", expectedDeltaMs: 0, toleranceMs: 1500, priority: 0, enabled: true };
      await repository.saveOverviewPairProfile(overview);
      const lpr = await repository.saveOverviewPairProfile({ ...overview, sourceCameraName: "My LPR", sourceCameraShortName: "Lpr01", sourceMode: "lpr_camera", replacePrimary: true });
      assert.equal(lpr.source_mode, "lpr_camera");
      const active = await repository.listPrimaryOverviewProfilesForRead({ plateCameraName: "My LPR", directionLabel: "Arriving" });
      assert.equal(active.length, 1); assert.equal(active[0].source_camera_name, "My LPR");
      target.sql(`UPDATE public.plate_reads SET bi_trigger_direction_status='ready',bi_trigger_direction_label='Arriving',
        bi_trigger_direction_profile_version=1,bi_trigger_direction_algorithm='blue-iris-zone-crossing-v1',
        vehicle_image_queue_kind='overview',vehicle_image_status='pending',vehicle_image_updated_at=CURRENT_TIMESTAMP,
        "timestamp"=CURRENT_TIMESTAMP-INTERVAL '30 seconds'
        WHERE plate_number='MIG0001';`);
      const claimed = await repository.claimNextOverviewRead();
      assert.equal(claimed.overview_source_mode, "lpr_camera"); assert.equal(String(claimed.overview_profile_id), String(lpr.id));
      // Replay is idempotent even after a same-camera mapping exists.
      target.deployment.migrate(targetRelease);
      assert.equal((await repository.listOverviewPairProfiles()).find((profile) => profile.id === lpr.id).source_mode, "lpr_camera");
    } finally { await pool.end(); }
    assert.equal(source.sql("SELECT count(*) FROM public.plate_reads WHERE plate_number='MIG0001';"), "1");
    console.log(baseline + " logical export/import passed exact pre-migration counts, source-schema attestation, upgrade policy, image checksums, settings, API-key preservation, chosen-password reset, nonempty-target refusal, source preservation, and real-SQL LPR source switching/claim/replay.");
  }
} finally {
  for (const item of clusters.reverse()) item.run(path.join(pgBin, "pg_ctl.exe"), ["-D", item.database, "-w", "-m", "fast", "stop"]);
  if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error("Unexpected test directory.");
  await rm(root, { recursive: true, force: true });
}
