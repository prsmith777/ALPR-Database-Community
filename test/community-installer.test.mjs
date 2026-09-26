import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  communityInstallerInternals as internals,
  runInstallerCommand,
} from "../scripts/community-installer.mjs";

const RELEASE = Object.freeze({
  tag: "v0.1.24",
  version: "0.1.24",
  commit: "2".repeat(40),
});

function memoryLogger() {
  const messages = [];
  return {
    messages,
    log(message) { messages.push(String(message)); },
    error(message) { messages.push(String(message)); },
  };
}

async function makeReleaseRoot() {
  const root = await mkdtemp(join(tmpdir(), "alpr-community-install-"));
  await writeFile(join(root, ".env.example"), "ADMIN_PASSWORD=\nDB_PASSWORD=\nTZ=UTC\nAPP_PORT=3000\nDB_PORT=5432\n");
  await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
  await writeFile(join(root, "docker-compose.yml"), "services: {}\n");
  await writeFile(join(root, "migrations.sql"), "SELECT 1;\n");
  await writeFile(join(root, "package.json"), '{"version":"0.1.24"}\n');
  await writeFile(join(root, "schema.sql"), "SELECT 1;\n");
  return root;
}

function fakeDockerRunner(options = {}) {
  let imageExists = false;
  const commands = [];
  const runner = (command, args) => {
    commands.push([command, ...args]);
    const joined = args.join(" ");
    if (command === "git" && joined === "--version") return "git version 2.51";
    if (command === process.execPath && joined.includes("verify-runtime-image.mjs")) return "";
    if (command !== "docker") throw new Error(`unexpected command: ${command} ${joined}`);
    if (["version", "info", "compose version", "buildx version"].includes(joined)) return "ok";
    if (joined.startsWith("ps -a --filter label=com.docker.compose.project=")) return "";
    if (joined === "volume ls --format {{.Name}}") return "unrelated-volume";
    if (joined === "network ls --format {{.Name}}") return "bridge";
    if (joined.startsWith("image ls --quiet alpr-community:")) return imageExists ? "image-id" : "";
    if (joined.startsWith("buildx create --name alpr-community-build-")) return "builder";
    if (joined.startsWith("buildx build --builder alpr-community-build-") && joined.includes("--tag alpr-community:")) {
      imageExists = true;
      return "";
    }
    if (joined.startsWith("buildx rm --force alpr-community-build-")) return "";
    if (joined.startsWith("run --rm --user 0:0 --entrypoint chown")) return "";
    if (joined.includes(" compose ")) throw new Error("unexpected normalized Docker command");
    if (args[0] === "compose") {
      if (joined.includes(" config --quiet")) return "";
      if (joined.includes(" up -d db")) return "";
      if (joined.includes(" exec -T db pg_isready")) return "accepting connections";
      if (joined.includes(" run --rm --no-deps migrate")) return "";
      if (joined.includes(" up -d --no-deps app")) return "";
      if (joined.includes(" ps -q app")) return "application-container";
      if (joined.includes(" exec -T db psql") && joined.includes("concat_ws")) return "0|0|0|0|0|0|0|t";
      if (joined.includes(" down --volumes --remove-orphans")) return "";
    }
    if (joined === "inspect --format {{.Config.Image}} application-container") {
      return internals.imageForRelease(RELEASE);
    }
    if (joined.startsWith("image inspect --format") && joined.endsWith(internals.imageForRelease(RELEASE))) {
      return RELEASE.commit;
    }
    if (joined === `image rm ${internals.imageForRelease(RELEASE)}`) {
      imageExists = false;
      return "";
    }
    throw new Error(`unexpected docker command: ${joined}`);
  };
  return { runner, commands, imageExists: () => imageExists };
}

const CONFIGURATION = Object.freeze({
  administratorPassword: "Long$Admin#Pass123",
  timeZone: "America/Denver",
  appPort: 3310,
  dbPort: 5544,
  projectName: "alpr-community-test",
});

test("fresh-install values are strictly validated and serialized", () => {
  assert.equal(internals.normalizeProjectName(" ALPR Database Community "), "alpr-database-community");
  assert.equal(internals.validatePort("3000", "port"), 3000);
  assert.equal(internals.validateTimeZone("America/Denver"), "America/Denver");
  assert.equal(internals.validateAdministratorPassword(CONFIGURATION.administratorPassword), CONFIGURATION.administratorPassword);
  assert.equal(internals.quoteDotenv("value$with#symbols"), "'value$with#symbols'");
  assert.throws(() => internals.validateAdministratorPassword("short"), /12 through 128/);
  assert.throws(() => internals.validateAdministratorPassword(" leading-password"), /whitespace/);
  assert.throws(() => internals.validateAdministratorPassword("contains\\backslash"), /backslashes/);
  assert.throws(() => internals.validateTimeZone("Not/A_Time_Zone"), /invalid IANA/);
  assert.throws(() => internals.validatePort(70000, "port"), /1 through 65535/);
  assert.doesNotThrow(() => internals.validateTimeZone(internals.defaultTimeZone()));
  assert.deepEqual(internals.discoverServerAddresses({
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    docker0: [{ address: "203.0.113.1", family: "IPv4", internal: false }],
    eth0: [
      { address: "198.51.100.25", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
  }), ["198.51.100.25"]);
});

test("fresh install builds a pinned image, proves an empty database, and stores only redacted state", async () => {
  const root = await makeReleaseRoot();
  const fake = fakeDockerRunner();
  const logger = memoryLogger();
  try {
    const state = await runInstallerCommand([], {}, {
      root,
      runner: fake.runner,
      logger,
      platform: "linux",
      arch: "x64",
      nodeVersion: "24.21.0",
      releaseIdentity: RELEASE,
      configuration: CONFIGURATION,
      confirmed: true,
      freeBytes: async () => internals.MINIMUM_FREE_BYTES + 1,
      portAvailable: async () => true,
      databaseReadyAttempts: 1,
      healthAttempts: 1,
      healthCheck: async () => ({ status: "ok" }),
      serverAddresses: ["192.0.2.25"],
    });
    assert.equal(state.status, "installed");
    assert.equal(state.release.tag, "v0.1.24");
    assert.equal(state.validation.freshDatabase, true);
    const envSource = await readFile(join(root, ".env"), "utf8");
    assert.match(envSource, /^ADMIN_PASSWORD='Long\$Admin#Pass123'$/m);
    assert.match(envSource, /^DB_PASSWORD='[A-Za-z0-9_-]{43}'$/m);
    assert.match(envSource, /^ALPR_APP_IMAGE=alpr-community:0\.1\.24-222222222222$/m);
    assert.match(envSource, /^ALPR_RELEASE_SHA=2{40}$/m);
    assert.match(envSource, /^COMPOSE_PROJECT_NAME=alpr-community-test$/m);
    assert.match(envSource, /^ALPR_UPDATE_HOST_GID=\d+$/m);
    const serializedState = await readFile(internals.statePath(root), "utf8");
    assert.doesNotMatch(serializedState, /Long\$Admin|DB_PASSWORD|ADMIN_PASSWORD/);
    assert.equal(fake.imageExists(), true);
    assert.ok(fake.commands.some((entry) => entry.join(" ").includes("buildx build --builder")));
    assert.ok(fake.commands.some((entry) => entry.join(" ").includes("buildx rm --force")));
    assert.ok(fake.commands.some((entry) => entry.join(" ").includes("verify-runtime-image.mjs")));
    assert.ok(fake.commands.some((entry) => entry.join(" ").includes("pg_isready -h 127.0.0.1")));
    assert.ok(fake.commands.some((entry) => entry.join(" ").includes("run --rm --no-deps migrate")));
    assert.ok(fake.commands.some((entry) => entry.join(" ").includes("concat_ws")));
    if (process.platform !== "win32") {
      assert.equal((await stat(join(root, ".env"))).mode & 0o777, 0o600);
      assert.equal((await stat(internals.statePath(root))).mode & 0o777, 0o600);
    }
    assert.match(logger.messages.join("\n"), /installed successfully/);
    assert.match(logger.messages.join("\n"), /http:\/\/192\.0\.2\.25:3310/);
    assert.match(logger.messages.join("\n"), /username blank/);
    assert.match(logger.messages.join("\n"), /Software Updates/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed fresh install removes only resources created by that attempt", async () => {
  const root = await makeReleaseRoot();
  const fake = fakeDockerRunner();
  const logger = memoryLogger();
  try {
    await assert.rejects(
      runInstallerCommand([], {}, {
        root,
        runner: fake.runner,
        logger,
        platform: "linux",
        arch: "x64",
        nodeVersion: "24.21.0",
        releaseIdentity: RELEASE,
        configuration: CONFIGURATION,
        confirmed: true,
        freeBytes: async () => internals.MINIMUM_FREE_BYTES + 1,
        portAvailable: async () => true,
        databaseReadyAttempts: 1,
        healthAttempts: 1,
        healthCheck: async () => { throw new Error("simulated health failure"); },
      }),
      /simulated health failure/
    );
    await assert.rejects(readFile(join(root, ".env")), /ENOENT/);
    await assert.rejects(readFile(internals.statePath(root)), /ENOENT/);
    for (const directory of internals.RUNTIME_DIRECTORIES) {
      await assert.rejects(stat(join(root, directory)), /ENOENT/);
    }
    assert.equal(fake.imageExists(), false);
    assert.ok(fake.commands.some((entry) => entry.join(" ").includes("down --volumes --remove-orphans")));
    assert.ok(fake.commands.some((entry) => entry.join(" ").includes("image rm")));
    assert.match(logger.messages.join("\n"), /Removed only resources recorded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh install refuses existing configuration, nonempty storage, and conflicting ports", async () => {
  const cases = [
    async (root) => writeFile(join(root, ".env"), "existing=true\n"),
    async (root) => { await mkdir(join(root, "storage")); await writeFile(join(root, "storage", "existing.jpg"), "private"); },
  ];
  for (const prepare of cases) {
    const root = await makeReleaseRoot();
    const fake = fakeDockerRunner();
    try {
      await prepare(root);
      await assert.rejects(
        runInstallerCommand([], {}, {
          root,
          runner: fake.runner,
          platform: "linux",
          arch: "x64",
          nodeVersion: "24.21.0",
          releaseIdentity: RELEASE,
          configuration: CONFIGURATION,
          confirmed: true,
          freeBytes: async () => internals.MINIMUM_FREE_BYTES + 1,
          portAvailable: async () => true,
        }),
        /not a fresh installation|already exists/
      );
      assert.equal(fake.imageExists(), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const root = await makeReleaseRoot();
  const fake = fakeDockerRunner();
  try {
    await assert.rejects(
      runInstallerCommand([], {}, {
        root,
        runner: fake.runner,
        platform: "linux",
        arch: "x64",
        nodeVersion: "24.21.0",
        releaseIdentity: RELEASE,
        configuration: { ...CONFIGURATION, dbPort: CONFIGURATION.appPort },
        confirmed: true,
        freeBytes: async () => internals.MINIMUM_FREE_BYTES + 1,
        portAvailable: async () => true,
      }),
      /must be different/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh install rejects every Compose volume and network name it owns", async () => {
  for (const collision of [
    "alpr-community-test_db-data",
    "alpr-community-test_app-auth",
    "alpr-community-test_app-config",
    "alpr-community-test_app-logs",
    "alpr-community-test_app-plate_images",
    "alpr-community-test_default",
  ]) {
    const root = await makeReleaseRoot();
    const fake = fakeDockerRunner();
    const baseRunner = fake.runner;
    const runner = (command, args, options) => {
      const joined = args.join(" ");
      if (command === "docker" && joined === "volume ls --format {{.Name}}") return collision;
      if (command === "docker" && joined === "network ls --format {{.Name}}") return collision;
      return baseRunner(command, args, options);
    };
    try {
      await assert.rejects(
        runInstallerCommand([], {}, {
          root,
          runner,
          platform: "linux",
          arch: "x64",
          nodeVersion: "24.21.0",
          releaseIdentity: RELEASE,
          configuration: CONFIGURATION,
          confirmed: true,
          freeBytes: async () => internals.MINIMUM_FREE_BYTES + 1,
          portAvailable: async () => true,
        }),
        new RegExp(`Docker resource ${collision.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} already exists`)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("guarded recovery removes an exact interrupted attempt but refuses installed state", async () => {
  const root = await makeReleaseRoot();
  const fake = fakeDockerRunner();
  const logger = memoryLogger();
  const envSource = "ADMIN_PASSWORD='private-password'\nDB_PASSWORD='generated-database-password'\n";
  try {
    await writeFile(join(root, ".env"), envSource);
    for (const directory of internals.RUNTIME_DIRECTORIES) await mkdir(join(root, directory));
    const interrupted = {
      formatVersion: internals.FORMAT_VERSION,
      status: "failed",
      root,
      projectName: CONFIGURATION.projectName,
      image: internals.imageForRelease(RELEASE),
      environmentDigest: createHash("sha256").update(envSource).digest("hex"),
      createdDirectories: [...internals.RUNTIME_DIRECTORIES],
      createdImage: false,
    };
    await writeFile(internals.statePath(root), `${JSON.stringify(interrupted)}\n`);
    await runInstallerCommand(["--recover"], {
      ALPR_INSTALL_RECOVERY: internals.RECOVERY_ACKNOWLEDGEMENT,
    }, { root, runner: fake.runner, logger });
    await assert.rejects(readFile(join(root, ".env")), /ENOENT/);
    await assert.rejects(readFile(internals.statePath(root)), /ENOENT/);
    assert.ok(fake.commands.some((entry) => entry.join(" ").includes("down --volumes --remove-orphans")));

    await writeFile(internals.statePath(root), `${JSON.stringify({ ...interrupted, status: "installed" })}\n`);
    await assert.rejects(
      runInstallerCommand(["--recover"], {
        ALPR_INSTALL_RECOVERY: internals.RECOVERY_ACKNOWLEDGEMENT,
      }, { root, runner: fake.runner, logger }),
      /refuses a completed installation/
    );

    await writeFile(internals.statePath(root), `${JSON.stringify(interrupted)}\n`);
    await assert.rejects(
      runInstallerCommand(["--recover"], {
        ALPR_INSTALL_RECOVERY: internals.RECOVERY_ACKNOWLEDGEMENT,
      }, { root, runner: fake.runner, logger }),
      /\.env is missing.*refuses to discard/
    );
    assert.equal((await readFile(internals.statePath(root), "utf8")).trim(), JSON.stringify(interrupted));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer help documents Linux VM support, generated database credentials, and guarded recovery", async () => {
  const logger = memoryLogger();
  await runInstallerCommand(["--help"], {}, { logger });
  const help = logger.messages.join("\n");
  assert.match(help, /Linux x86-64.*Linux virtual machine/is);
  assert.match(help, /database password is generated automatically/i);
  assert.match(help, /ALPR_INSTALL_ACKNOWLEDGE=ALPR_FRESH_INSTALL/);
  assert.match(help, /ALPR_INSTALL_RECOVERY=ALPR_RECOVER_FAILED_INSTALL/);
  assert.deepEqual(internals.parseArguments(["--recover"]), { command: "recover" });
  assert.deepEqual(internals.parseArguments(["--status"]), { command: "status" });
  assert.throws(() => internals.parseArguments(["--force"]), /unknown fresh-install option/);
});

test("fresh installer contains no Docker socket mount, broad prune, or test-data loader", async () => {
  const [installer, launcher, packageSource] = await Promise.all([
    readFile(new URL("../scripts/community-installer.mjs", import.meta.url), "utf8"),
    readFile(new URL("../alpr-community", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(installer, /docker\.sock|system["', ]+prune|staging-fixtures\.sql/i);
  assert.match(installer, /"0\|0\|0\|0\|0\|0\|0\|t"/);
  assert.match(installer, /refs\/heads\/main:refs\/remotes\/origin\/main/);
  assert.match(installer, /merge-base", "--is-ancestor"/);
  assert.match(installer, /"status", "--porcelain", "--untracked-files=normal"/);
  assert.match(launcher, /community-installer\.mjs/);
  assert.equal(JSON.parse(packageSource).scripts["install:community"], "node scripts/community-installer.mjs");
});
