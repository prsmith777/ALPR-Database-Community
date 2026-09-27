import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdaterCommand } from "./community-updater.mjs";

// Called only after the parent fixture verifies an empty, sentinel-guarded CI
// database and loads the real v0.1.42 schema. PostgreSQL, pg_dump, migrations,
// transactional pg_restore, updater state and filesystem backups are real.
// Git/image/app lifecycle boundaries are simulated; no production host is used.
export async function exerciseNativeHostUpdater({ pool, database, readId, before }) {
  const container = process.env.NATIVE_REID_TEST_CONTAINER;
  if (process.env.CI !== "true" || !/^[a-f0-9]{12,64}$/.test(container || "")
      || process.env.NATIVE_REID_TEST_OPT_IN !== "true"
      || !/^codex_native_reid_[a-f0-9]{8,32}$/.test(database || "")) {
    throw new Error("Host updater integration requires the CI-owned scratch PostgreSQL container");
  }
  const guard = await pool.query("SELECT current_database() AS name, scope, guard_token FROM public.codex_integration_test_guard");
  assert.deepEqual(guard.rows, [{ name: database, scope: "native-reid-upgrade", guard_token: process.env.NATIVE_REID_TEST_GUARD_TOKEN }]);
  const temporary = await mkdtemp(join(tmpdir(), "alpr-native-host-updater-"));
  const root = join(temporary, "installation");
  const backupRoot = join(temporary, "backups");
  const sourceCommit = "1".repeat(40);
  const targetCommit = "2".repeat(40);
  let current = sourceCommit;
  let image = "alpr-dashboard:local";
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 8, 27, 0, 0, tick++));
  const environment = { ALPR_UPDATER_BACKUP_DIR: backupRoot };
  const migrations = readFileSync(new URL("../migrations.sql", import.meta.url), "utf8");
  const commands = [];
  function docker(args, options = {}) {
    const result = spawnSync("docker", args, { encoding: options.stdoutPath ? undefined : "utf8",
      input: options.input, maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error("Scratch PostgreSQL command failed: " + (result.error?.message || result.stderr));
    if (options.stdoutPath) writeFileSync(options.stdoutPath, result.stdout);
    return options.stdoutPath ? "" : String(result.stdout).trim();
  }
  // Verify the exact container endpoint too, not only the separate pool endpoint.
  assert.equal(docker(["exec", container, "psql", "-U", "postgres", "-d", database, "-Atc",
    "SELECT guard_token FROM public.codex_integration_test_guard WHERE scope='native-reid-upgrade'"]), process.env.NATIVE_REID_TEST_GUARD_TOKEN);
  function runner(command, args, options = {}) {
    commands.push([command, ...args]);
    const joined = args.join(" ");
    if (command === process.execPath && joined.includes("verify-runtime-image.mjs")) return "";
    if (command === "git") {
      if (joined === "status --porcelain --untracked-files=no") return "";
      if (joined.startsWith("describe --tags")) return current === sourceCommit ? "v0.1.42" : "v0.1.44";
      if (joined === "rev-parse HEAD") return current;
      if (joined === "show HEAD:package.json") return JSON.stringify({ version: current === sourceCommit ? "0.1.42" : "0.1.44" });
      if (joined === "remote get-url origin") return "https://github.com/prsmith777/ALPR-Database-Community.git";
      if (joined.startsWith("fetch --prune")) return "";
      if (joined === "tag --list v* --merged origin/main") return "v0.1.42\nv0.1.44";
      if (joined === "rev-list -n 1 v0.1.44^{commit}") return targetCommit;
      if (joined === `merge-base --is-ancestor ${targetCommit} origin/main`) return "";
      if (joined === `show ${targetCommit}:package.json`) return '{"version":"0.1.44"}';
      if (joined === "checkout --detach v0.1.44") { current = targetCommit; return ""; }
      if (joined === "checkout --detach v0.1.42") { current = sourceCommit; return ""; }
    }
    if (command === "docker") {
      if (["version", "compose version", "buildx version", "compose config --quiet", "compose stop app", "compose up -d db"].includes(joined)) return "";
      if (joined === "compose config --services") return "app\ndb\nmigrate";
      if (joined === "compose ps -q db") return container;
      if (joined === "compose ps -q app") return "fixture-app";
      if (joined === "inspect --format {{.Config.Image}} fixture-app") return image;
      if (joined.startsWith("image inspect --format")) return current;
      if (args[0] === "buildx" && ["create", "build", "rm"].includes(args[1])) return "";
      if (joined === "compose up -d --no-deps app") {
        image = current === sourceCommit ? "alpr-dashboard:local" : `alpr-community:0.1.44-${targetCommit.slice(0, 12)}`;
        return "";
      }
      if (joined === "compose run --rm --no-deps migrate") {
        return docker(["exec", "-i", container, "psql", "--no-psqlrc", "-U", "postgres", "-d", database,
          "--set", "ON_ERROR_STOP=1", "--single-transaction"], { input: migrations });
      }
      if (args[0] === "compose" && args[1] === "cp") {
        assert.ok(args[3].startsWith("db:/tmp/alpr-community-rollback-"));
        return docker(["cp", args[2], container + args[3].slice(2)]);
      }
      if (args.slice(0, 4).join(" ") === "compose exec -T db") {
        const executable = args[4];
        assert.ok(["psql", "pg_dump", "pg_isready", "sh", "rm"].includes(executable));
        const translated = args.slice(4).map((value, index, all) =>
          ["--dbname", "-d"].includes(all[index - 1]) && value === "postgres" ? database : value);
        return docker(["exec", "-i", container, ...translated], options);
      }
    }
    throw new Error("Unexpected integration boundary: " + command + " " + joined);
  }
  const options = { root, runner, confirmed: true, clock, databaseReadyAttempts: 1,
    healthCheck: async () => ({ status: "ok" }), logger: { log() {} } };
  options.validateInstalledRelease = (args, env) => runUpdaterCommand(args, env, options);
  const update = () => runUpdaterCommand(["update", "--to", "v0.1.44"], environment, options);
  const rollback = () => runUpdaterCommand(["rollback"], environment, options);
  const validate = () => runUpdaterCommand(["validate"], environment, options);
  try {
    await mkdir(root);
    for (const dir of ["auth", "config", "storage"]) await mkdir(join(root, dir));
    for (const file of ["docker-compose.yml", "Dockerfile", "migrations.sql"]) await writeFile(join(root, file), "fixture\n");
    await writeFile(join(root, ".env"), "APP_PORT=3000\n");
    await writeFile(join(root, "auth", "users.json"), "fixture authentication");
    await writeFile(join(root, "config", "settings.yaml"), "fixture configuration");
    await writeFile(join(root, "storage", "plate.jpg"), "fixture image data");
    const initial = await update();
    assert.equal(initial.status, "ready-for-acceptance");
    assert.equal(initial.backup.identityUpgrade.native, false);
    assert.equal(initial.validation.retiredDerivedRows.find(row => row.table === "capture_assets").retired, 1);
    assert.deepEqual(initial.backup.identityUpgrade.directionRetirements,
      { vehicle_orientation_labels: "1", vehicle_direction_observations: "1" });
    assert.deepEqual((await pool.query("SELECT classifier_version FROM public.vehicle_direction_observations")).rows,
      [{ classifier_version: "blue-iris-zone-crossing-v1" }]);
    assert.ok(commands.some(args => args.includes("pg_dump")), "backup must actually run");
    // The exact bug: empty retired tables are absent, but validation succeeds.
    assert.ok(initial.validation.retiredDerivedRows.some(row => row.retired === 0));
    // Real original-data deletion must still fail, even when derived retirement is expected.
    await pool.query("DELETE FROM public.plate_reads WHERE id = $1", [readId]);
    await assert.rejects(validate(), /post-update row counts decreased:.*plate_reads/);
    const restored = await rollback();
    assert.equal(restored.status, "rolled-back");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.capture_assets")).rows[0].count, 1);
    const restoredRead = await pool.query("SELECT id, plate_number, observed_plate, image_path, vehicle_image_path, camera_name, timestamp, review_status, review_revision, validated FROM public.plate_reads WHERE id = $1", [readId]);
    assert.deepEqual(restoredRead.rows, before.rows);
    assert.equal(await readFile(join(root, "auth", "users.json"), "utf8"), "fixture authentication");
    const retried = await update();
    assert.equal(retried.status, "ready-for-acceptance");
    const dump = await readFile(retried.backup.dumpPath);
    await writeFile(retried.backup.dumpPath, "corrupt dump");
    await assert.rejects(validate(), /checksum no longer matches/);
    await assert.rejects(rollback(), /checksum no longer matches/);
    await writeFile(retried.backup.dumpPath, dump);
    await validate();
    await rollback();
    assert.ok(commands.some(args => args.some(arg => String(arg).includes("DROP SCHEMA public CASCADE"))), "rollback must use the real transactional restore wrapper");
    console.log("native_host_updater_backup_validate_loss_refusal_rollback_retry=passed");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
