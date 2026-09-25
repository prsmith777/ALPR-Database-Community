import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  communityUpdaterInternals as internals,
  runUpdaterCommand,
} from "../scripts/community-updater.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function memoryLogger() {
  const messages = [];
  return {
    messages,
    log(message) {
      messages.push(String(message));
    },
  };
}

test("stable release tags are strictly parsed, ordered, and selected", () => {
  assert.deepEqual(internals.parseVersionTag("v0.1.23"), {
    tag: "v0.1.23",
    version: "0.1.23",
    parts: [0, 1, 23],
  });
  for (const invalid of ["0.1.23", "v01.1.23", "v0.1", "v0.1.23-rc.1", "latest"]) {
    assert.equal(internals.parseVersionTag(invalid), null);
  }
  assert.ok(internals.compareVersionTags("v0.2.0", "v0.1.99") > 0);
  assert.equal(
    internals.selectTargetRelease("v0.1.22", ["v0.1.23", "v0.2.0", "v0.1.24"]),
    "v0.2.0"
  );
  assert.equal(internals.selectTargetRelease("v0.2.0", ["v0.1.23", "v0.2.0"]), null);
  assert.throws(
    () => internals.selectTargetRelease("v0.1.22", ["v0.1.23"], "v0.1.24"),
    /not fetched from origin\/main/
  );
});

test("only the canonical public repository identity is normalized as expected", () => {
  const expected = "github.com/prsmith777/ALPR-Database-Community";
  assert.equal(
    internals.normalizeRepositoryUrl("https://github.com/prsmith777/ALPR-Database-Community.git"),
    expected
  );
  assert.equal(
    internals.normalizeRepositoryUrl("git@github.com:prsmith777/ALPR-Database-Community.git"),
    expected
  );
  assert.notEqual(
    internals.normalizeRepositoryUrl("https://github.com/example/ALPR-Database-Community.git"),
    expected
  );
});

test("private updater artifacts default outside the repository and reject unsafe paths", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "alpr-updater-paths-"));
  const repository = join(temporaryRoot, "installation");
  await mkdir(repository);
  try {
    assert.equal(
      internals.resolveBackupRoot({}, repository),
      resolve(temporaryRoot, "ALPR-Database-Community-backups")
    );
    assert.throws(
      () => internals.resolveBackupRoot({ ALPR_UPDATER_BACKUP_DIR: "relative" }, repository),
      /absolute path/
    );
    assert.throws(
      () => internals.resolveBackupRoot({ ALPR_UPDATER_BACKUP_DIR: join(repository, "backups") }, repository),
      /outside the repository/
    );
    assert.throws(
      () => internals.assertSafeChild(temporaryRoot, temporaryRoot, "artifact"),
      /not a safe child/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("managed release values update without exposing or replacing unrelated secrets", () => {
  const before = "ADMIN_PASSWORD=keep-this-secret\nAPP_PORT=3000\nALPR_APP_IMAGE=old:image\n";
  const after = internals.upsertEnvironment(before, {
    ALPR_APP_IMAGE: "alpr-community:0.1.23-0123456789ab",
    ALPR_RELEASE_SHA: "0123456789abcdef0123456789abcdef01234567",
    ALPR_RELEASE_CHANNEL: "stable",
  });
  assert.match(after, /^ADMIN_PASSWORD=keep-this-secret$/m);
  assert.match(after, /^APP_PORT=3000$/m);
  assert.match(after, /^ALPR_APP_IMAGE=alpr-community:0\.1\.23-0123456789ab$/m);
  assert.equal((after.match(/^ALPR_APP_IMAGE=/gm) || []).length, 1);
  assert.match(after, /^ALPR_RELEASE_CHANNEL=stable$/m);
  assert.equal(
    internals.installedShaFromEnvironment(after),
    "0123456789abcdef0123456789abcdef01234567"
  );
  assert.equal(internals.installedShaFromEnvironment("ALPR_RELEASE_SHA=not-a-sha\n"), null);
});

test("storage inventory records only regular file count and bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alpr-updater-storage-"));
  try {
    await mkdir(join(directory, "images"));
    await writeFile(join(directory, "images", "one.jpg"), Buffer.alloc(17));
    await writeFile(join(directory, "two.jpg"), Buffer.alloc(29));
    assert.deepEqual(await internals.storageInventory(directory), { files: 2, bytes: 46 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state files are private and contain no supplied secret text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alpr-updater-state-"));
  const path = join(directory, "state.json");
  try {
    await internals.writePrivateJson(path, {
      formatVersion: internals.FORMAT_VERSION,
      status: "ready-for-acceptance",
      release: "v0.1.23",
    });
    const serialized = await readFile(path, "utf8");
    assert.doesNotMatch(serialized, /password|secret/i);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("command parsing accepts only the narrow updater interface", () => {
  assert.deepEqual(internals.parseArguments(["update", "--to", "v0.1.23"]), {
    command: "update",
    requestedTag: "v0.1.23",
    force: false,
  });
  assert.deepEqual(internals.parseArguments(["cleanup", "--force"]), {
    command: "cleanup",
    requestedTag: undefined,
    force: true,
  });
  assert.throws(() => internals.parseArguments(["update", "--latest"]), /unknown option/);
  assert.throws(() => internals.parseArguments(["rollback", "--to", "v0.1.23"]), /only with check or update/);
  assert.throws(() => internals.parseArguments(["update", "--force"]), /only with cleanup/);
});

test("the guided engine backs up, applies, validates, accepts, and rolls back with resumable state", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "alpr-updater-workflow-"));
  const repository = join(temporaryRoot, "installation");
  const backupRoot = join(temporaryRoot, "private-backups");
  const currentCommit = "1".repeat(40);
  const targetCommit = "2".repeat(40);
  let checkedOutCommit = currentCommit;
  let runningImage = "alpr-dashboard:local";
  let failDumpOnce = true;
  let clockTick = 0;
  const clock = () => new Date(Date.UTC(2026, 8, 24, 12, 0, clockTick++));
  const environment = { ALPR_UPDATER_BACKUP_DIR: backupRoot };
  const commandLog = [];

  await mkdir(repository);
  await mkdir(join(repository, "auth"));
  await mkdir(join(repository, "config"));
  await mkdir(join(repository, "storage"));
  await writeFile(join(repository, "docker-compose.yml"), "services: {}\n");
  await writeFile(join(repository, "Dockerfile"), "FROM scratch\n");
  await writeFile(join(repository, "migrations.sql"), "SELECT 1;\n");
  await writeFile(join(repository, "package.json"), '{"version":"0.1.22"}\n');
  await writeFile(join(repository, ".env"), "ADMIN_PASSWORD=private\nDB_PASSWORD=private\nAPP_PORT=3000\n");
  await writeFile(join(repository, "auth", "users.json"), "before-auth\n");
  await writeFile(join(repository, "config", "settings.yaml"), "before-config\n");
  await writeFile(join(repository, "storage", "plate.jpg"), Buffer.alloc(41));

  const runner = (command, args, options = {}) => {
    commandLog.push([command, ...args]);
    if (command === "git") {
      const joined = args.join(" ");
      if (joined === "status --porcelain --untracked-files=no") return "";
      if (joined.startsWith("describe --tags")) return checkedOutCommit === currentCommit ? "v0.1.22" : "v0.1.23";
      if (joined === "rev-parse HEAD") return checkedOutCommit;
      if (joined === "show HEAD:package.json") {
        return JSON.stringify({ version: checkedOutCommit === currentCommit ? "0.1.22" : "0.1.23" });
      }
      if (joined === "remote get-url origin") return "https://github.com/prsmith777/ALPR-Database-Community.git";
      if (joined === "fetch --prune --prune-tags --tags origin") return "";
      if (joined === "tag --list v* --merged origin/main") return "v0.1.22\nv0.1.23";
      if (joined === "rev-list -n 1 v0.1.23^{commit}") return targetCommit;
      if (joined === `merge-base --is-ancestor ${targetCommit} origin/main`) return "";
      if (joined === `show ${targetCommit}:package.json`) return '{"version":"0.1.23"}';
      if (joined === "checkout --detach v0.1.23") {
        checkedOutCommit = targetCommit;
        return "";
      }
      if (joined === "checkout --detach v0.1.22") {
        checkedOutCommit = currentCommit;
        return "";
      }
    }
    if (command === "docker") {
      const joined = args.join(" ");
      if (joined === "version" || joined === "compose version") return "ok";
      if (joined === "compose config --quiet") return "";
      if (joined === "compose config --services") return "app\ndb\nmigrate";
      if (joined === "compose ps -q db") return "database-container";
      if (joined === "compose ps -q app") return "application-container";
      if (joined === "inspect --format {{.Config.Image}} application-container") return runningImage;
      if (joined.includes("SELECT tablename FROM pg_catalog.pg_tables")) return "plate_reads\nplates";
      if (joined.includes('SELECT count(*) FROM public."plate_reads"')) return "2";
      if (joined.includes('SELECT count(*) FROM public."plates"')) return "1";
      if (joined.includes("SELECT pg_database_size(current_database())")) return "4096";
      if (joined.includes("pg_isready")) return "accepting connections";
      if (joined.includes("pg_dump")) {
        if (failDumpOnce) {
          failDumpOnce = false;
          throw new Error("simulated dump interruption");
        }
        writeFileSync(options.stdoutPath, Buffer.from("verified-private-dump"));
        return "";
      }
      if (joined.startsWith("build ")) return "";
      if (joined === "compose up -d --no-deps app") {
        runningImage = checkedOutCommit === targetCommit
          ? `alpr-community:0.1.23-${targetCommit.slice(0, 12)}`
          : "alpr-dashboard:local";
        return "";
      }
      if (joined.includes("pg_restore")) {
        assert.ok(options.stdinPath.endsWith("postgres.dump"));
        return "";
      }
      if (joined.startsWith("image rm ")) return "";
      return "";
    }
    throw new Error(`unexpected fake command: ${command} ${args.join(" ")}`);
  };

  try {
    await assert.rejects(
      runUpdaterCommand(
        ["update", "--to", "v0.1.23"],
        environment,
        {
          root: repository,
          runner,
          platform: "linux",
          confirmed: true,
          clock,
          databaseReadyAttempts: 1,
          healthCheck: async () => ({ status: "ok" }),
          logger: memoryLogger(),
        }
      ),
      /simulated dump interruption/
    );
    const failedState = JSON.parse(await readFile(join(backupRoot, "updater-state.json"), "utf8"));
    assert.equal(failedState.status, "backup-failed");

    const installed = await runUpdaterCommand(
      ["update", "--to", "v0.1.23"],
      environment,
      {
        root: repository,
        runner,
        platform: "linux",
        confirmed: true,
        clock,
        databaseReadyAttempts: 1,
        healthAttempts: 1,
        healthCheck: async () => ({ status: "ok" }),
        logger: memoryLogger(),
      }
    );
    assert.equal(installed.status, "ready-for-acceptance");
    assert.equal(installed.current.tag, "v0.1.22");
    assert.equal(installed.target.tag, "v0.1.23");
    assert.match(await readFile(join(repository, ".env"), "utf8"), /^ALPR_RELEASE_CHANNEL=stable$/m);
    assert.equal((await readFile(installed.backup.dumpPath)).toString(), "verified-private-dump");

    const accepted = await runUpdaterCommand(["accept"], environment, {
      root: repository,
      runner,
      confirmed: true,
      clock,
      logger: memoryLogger(),
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.acceptance.manualChecksConfirmed, true);

    await writeFile(join(repository, "auth", "users.json"), "after-update\n");
    await writeFile(join(repository, "config", "settings.yaml"), "after-update\n");
    const rolledBack = await runUpdaterCommand(["rollback"], environment, {
      root: repository,
      runner,
      confirmed: true,
      clock,
      databaseReadyAttempts: 1,
      healthAttempts: 1,
      healthCheck: async () => ({ status: "ok" }),
      logger: memoryLogger(),
    });
    assert.equal(rolledBack.status, "rolled-back");
    assert.equal(checkedOutCommit, currentCommit);
    assert.equal(await readFile(join(repository, "auth", "users.json"), "utf8"), "before-auth\n");
    assert.equal(await readFile(join(repository, "config", "settings.yaml"), "utf8"), "before-config\n");
    assert.ok(commandLog.some((entry) => entry.includes("pg_dump")));
    assert.ok(commandLog.some((entry) => entry.includes("pg_restore")));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("CLI help documents generic Linux support and all safety acknowledgements", async () => {
  const logger = memoryLogger();
  await runUpdaterCommand(["help"], {}, { logger });
  const help = logger.messages.join("\n");
  assert.match(help, /Linux.*Docker Compose/i);
  assert.match(help, /Unraid/i);
  assert.match(help, /ALPR_UPDATE_ACKNOWLEDGE=ALPR_UPDATE_APPROVED/);
  assert.match(help, /ALPR_UPDATE_ROLLBACK=ALPR_UPDATE_ROLLBACK/);
});

test("public update tooling has no Docker socket mount or broad prune command", async () => {
  const [script, compose, readme, guide, packageSource] = await Promise.all([
    source("scripts/community-updater.mjs"),
    source("docker-compose.yml"),
    source("README.md"),
    source("docs/UPDATES.md"),
    source("package.json"),
  ]);
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.doesNotMatch(script, /docker["', ]+system["', ]+prune|system prune|-a.*prune/i);
  assert.match(script, /runner\("docker", \["image", "rm", image\]/);
  assert.match(`${readme}\n${guide}`, /standard Linux/i);
  assert.match(guide, /does not copy.*storage/i);
  assert.match(guide, /Windows/i);
  assert.equal(JSON.parse(packageSource).scripts["update:community"], "node scripts/community-updater.mjs");
});
