import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import { sourceCandidates, validateSourcePair, exportDockerMigration, assertDockerBackupSeparation } from "../scripts/docker-migration-export.mjs";
import { dockerPostgresArguments, POSTGRES_CLIENT_IMAGE } from "../scripts/docker-migration-client.mjs";
const appId = "a".repeat(64), dbId = "b".repeat(64);
function fixtures() {
  const app = { Id: appId, Name: "/original-app", Platform: "linux", State: { Running: true },
    Config: { Image: "algertc/alpr-dashboard:latest", Env: ["DB_PASSWORD=private-fixture"], Labels: {} },
    Mounts: ["/app/auth", "/app/config", "/app/storage"].map(Destination => ({ Destination })),
    NetworkSettings: { Networks: { original: {} } } };
  const database = { Id: dbId, Name: "/original-db", Platform: "linux", State: { Running: true },
    Config: { Image: "postgres:13", Env: ["POSTGRES_PASSWORD=private-fixture"], Labels: {} },
    NetworkSettings: { Networks: { original: { Aliases: ["db"] } } } };
  return { app, database };
}
test("discovery distinguishes Docker applications/databases and never lists native service metadata", () => {
  const { app, database } = fixtures();
  const result = sourceCandidates([app, database]);
  assert.equal(result[0].application, true); assert.equal(result[1].database, true);
  assert.ok(!JSON.stringify(result).includes("private-fixture"));
  assert.deepEqual(sourceCandidates([{ ...app, Platform: "windows" }]), []);
});
test("source pairing follows the selected application's configured network alias, not a guessed local port", () => {
  const { app, database } = fixtures();
  assert.equal(validateSourcePair(app, database).ALPR_MIGRATION_DOCKER_SOURCE, dbId);
  assert.throws(() => validateSourcePair(app, { ...database, NetworkSettings: { Networks: { other: {} } } }), /does not match/);
  assert.throws(() => validateSourcePair(app, { ...database, State: { Running: false } }), /running/);
  assert.throws(() => validateSourcePair(app, { ...database, Id: appId }), /separate/);
  assert.throws(() => validateSourcePair(app, database, { database: { host: "foreign:5432" } }), /does not match/);
  assert.throws(() => validateSourcePair(app, database, { database: { password: "different-fixture" } }), /settings differ/);
  assert.throws(() => validateSourcePair(app, database, { database: { name: "postgresql://other.invalid/postgres" } }), /connection strings/);
  assert.throws(() => validateSourcePair(app, database, { database: { name: "host=other.invalid dbname=postgres" } }), /connection strings/);
});
test("client transport uses a PostgreSQL 17 client, read-only sessions, no published ports, and no password argument", () => {
  const scratch = path.resolve(os.tmpdir(), "private export");
  const env = { ALPR_MIGRATION_DOCKER_SOURCE: dbId, ALPR_MIGRATION_DOCKER_SCRATCH: scratch };
  const args = dockerPostgresArguments("pg_dump.exe", ["--format=custom", "--file", path.join(scratch, "postgres.dump")], env);
  assert.ok(args.includes(POSTGRES_CLIENT_IMAGE)); assert.ok(args.includes("container:" + dbId));
  assert.ok(args.includes("PGPASSWORD")); assert.ok(args.some(value => value.includes("default_transaction_read_only=on")));
  assert.ok(!args.includes("--publish") && !args.includes("--privileged"));
  assert.equal(args.at(-1), "/export/postgres.dump");
  assert.throws(() => dockerPostgresArguments("pg_restore", ["--dbname", "postgres"], env), /cannot restore/);
  assert.throws(() => dockerPostgresArguments("pg_dump", ["--file", path.resolve("unrelated")], env), /unexpected file/);
  assert.throws(() => dockerPostgresArguments("psql", ["--file", "anything"], env), /unexpected file/);
  assert.throws(() => dockerPostgresArguments("pg_dump", [], { ...env, ALPR_MIGRATION_DOCKER_SOURCE: "--host" }), /context/);
});
test("export refuses unreviewed or unpaused sources before invoking Docker", async () => {
  const call = { appId, databaseId: dbId, destination: path.resolve("unused") };
  for (const request of [call, { ...call, confirmation: appId + ":" + dbId, writersPaused: true }]) {
    await assert.rejects(exportDockerMigration(request, { docker() { assert.fail("must not touch Docker"); } }), /Review/);
  }
});
test("an existing destination is preserved before source inspection or stopping", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "alpr-docker-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(exportDockerMigration({ appId, databaseId: dbId, destination: root,
    confirmation: appId + ":" + dbId, writersPaused: true, expected: { sourceProfile: "original-alpr-v0.1.9", tableCounts: {} } },
  { docker() { assert.fail("must not touch Docker"); } }), /never overwritten/);
});
test("Windows exporter script parses with inbox PowerShell and installer exposes export before fresh installation", async () => {
  const source = await readFile(new URL("../scripts/windows/CommunitySetup.iss", import.meta.url), "utf8");
  assert.ok(source.includes("DockerBackupButton.OnClick := @DockerBackupClick"));
  const button = source.slice(source.indexOf("procedure DockerBackupClick(Sender: TObject);\nvar"), source.indexOf("function PrepareToInstall"));
  assert.ok(button.includes("RunSetupOperation('verify'"));
  assert.ok(!button.includes("RunSetupOperation('install'"));
  if (process.platform === "win32") {
    const { spawnSync } = await import("node:child_process");
    const script = path.resolve(import.meta.dirname, "../scripts/windows/ExportDockerMigration.ps1").replaceAll("'", "''");
    const result = spawnSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", "$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile('" + script + "',[ref]$t,[ref]$e);if($e){$e|Out-String|Write-Error;exit 1}"],
      { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("inherited Docker flags cannot redirect a native PostgreSQL process", async () => {
  const { postgresMajorMigrationInternals: pg } = await import("../scripts/postgres-major-migration.mjs");
  const result = await pg.runProcess(process.execPath, ["-e", "process.stdout.write('native')"], {
    environment: { ...process.env, ALPR_MIGRATION_DOCKER_SOURCE: dbId, ALPR_MIGRATION_DOCKER_SCRATCH: os.tmpdir() },
  });
  assert.equal(result.stdout, "native");
});
test("database password whitespace is preserved across logical migration", async () => {
  const { postgresMajorMigrationInternals: pg } = await import("../scripts/postgres-major-migration.mjs");
  const endpoint = pg.readEndpoint({ ALPR_MIGRATION_SOURCE_HOST: "127.0.0.1", ALPR_MIGRATION_SOURCE_DATABASE: "postgres",
    ALPR_MIGRATION_SOURCE_USER: "postgres", ALPR_MIGRATION_SOURCE_PASSWORD: "  fixture secret  " }, "ALPR_MIGRATION_SOURCE");
  assert.equal(endpoint.password, "  fixture secret  ");
});
test("backup paths cannot intersect original bind storage on Linux or Docker Desktop", () => {
  assert.throws(() => assertDockerBackupSeparation(["/srv/alpr/storage"], ["/srv/alpr/storage/backup"], "linux"), /outside/);
  assert.throws(() => assertDockerBackupSeparation(["C:/ALPR/storage"], ["C:/ALPR/storage/backup"], "win32"), /outside/);
  assert.throws(() => assertDockerBackupSeparation(["/run/desktop/mnt/host/c/ALPR/storage"], ["C:/ALPR/storage/backup"], "win32"), /outside/);
  assert.throws(() => assertDockerBackupSeparation(["/host_mnt/c/ALPR/auth"], ["C:/ALPR/auth/backup"], "win32"), /outside/);
  assert.doesNotThrow(() => assertDockerBackupSeparation(["/srv/alpr/storage"], ["/srv/alpr/backup"], "linux"));
});