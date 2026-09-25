import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  migrationWizardInternals as internals,
  runMigrationWizardCommand,
} from "../scripts/community-migration-wizard.mjs";

function fixedClock() {
  let seconds = 0;
  return () => new Date(Date.UTC(2026, 8, 25, 12, 0, seconds++));
}

function memoryLogger() {
  const messages = [];
  return {
    messages,
    log(message) { messages.push(String(message)); },
    error(message) { messages.push(String(message)); },
  };
}

async function fixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "alpr-migration-wizard-"));
  const repositoryRoot = join(temporaryRoot, "repo");
  await mkdir(repositoryRoot);
  for (const filename of [
    ".env.example",
    "Dockerfile",
    "docker-compose.yml",
    "migrations.sql",
    "package.json",
    "schema.sql",
  ]) {
    await writeFile(join(repositoryRoot, filename), filename === ".env.example"
      ? "ADMIN_PASSWORD=\nDB_PASSWORD=\n"
      : filename === "package.json"
        ? '{"version":"0.1.31"}\n'
        : "fixture\n");
  }
  const statePath = join(temporaryRoot, "private", "wizard.json");
  const artifactDirectory = join(temporaryRoot, "artifacts");
  const environment = {
    ALPR_MIGRATION_WIZARD_STATE_PATH: statePath,
    ALPR_MIGRATION_ARTIFACT_DIR: artifactDirectory,
    ALPR_MIGRATION_SOURCE_HOST: "old-alpr.example.test",
    ALPR_MIGRATION_SOURCE_PORT: "5432",
    ALPR_MIGRATION_SOURCE_DATABASE: "postgres",
    ALPR_MIGRATION_SOURCE_USER: "postgres",
    ALPR_MIGRATION_SOURCE_PASSWORD: "source-password-sentinel",
    ALPR_MIGRATION_SOURCE_SSLMODE: "prefer",
    ALPR_MIGRATION_NO_STORAGE: internals.NO_STORAGE_ACKNOWLEDGEMENT,
  };
  const releaseIdentity = {
    tag: "v0.1.31",
    version: "0.1.31",
    commit: "1".repeat(40),
  };
  const configuration = {
    administratorPassword: "administrator-password-sentinel",
    timeZone: "UTC",
    appPort: 3100,
    dbPort: 55432,
    projectName: "alpr-migration-test",
  };
  return {
    temporaryRoot,
    repositoryRoot,
    statePath,
    artifactDirectory,
    environment,
    releaseIdentity,
    configuration,
    async cleanup() { await rm(temporaryRoot, { recursive: true, force: true }); },
  };
}

function testOptions(context, operations = {}) {
  const commands = [];
  const migrationCommands = [];
  const runner = (command, args = []) => {
    commands.push([command, ...args]);
    if (args.some((argument) => String(argument).startsWith("SELECT concat_ws('|',"))) {
      return "1|2|3|4|5|6";
    }
    return "";
  };
  const migrationRunner = async (command) => { migrationCommands.push(command); };
  return {
    root: context.repositoryRoot,
    platform: "linux",
    arch: "x64",
    nodeVersion: "24.0.0",
    freeBytes: async () => 20 * 1024 ** 3,
    releaseIdentity: context.releaseIdentity,
    configuration: context.configuration,
    interactive: false,
    runner,
    migrationRunner,
    logger: memoryLogger(),
    clock: fixedClock(),
    prepareTarget: async (state, installerContext, configuration, databasePassword) => {
      assert.equal(installerContext.release.tag, "v0.1.31");
      assert.equal(configuration.projectName, "alpr-migration-test");
      const source = `ADMIN_PASSWORD='administrator-password-sentinel'\nDB_PASSWORD='${databasePassword}'\n`;
      await writeFile(join(context.repositoryRoot, ".env"), source, { mode: 0o600 });
      state.resources.environmentDigest = createHash("sha256").update(source).digest("hex");
    },
    copyStorage: async () => ({ mode: "none", files: 0, bytes: 0, checksumVerified: true }),
    validateApplication: async () => ({ health: "ok", dataSignature: "1|2|3|4|5|6", outboundNetwork: "isolated" }),
    validateRestart: async () => ({ health: "ok", dataSignature: "1|2|3|4|5|6", persistence: "passed" }),
    healthCheck: async () => ({ status: "ok" }),
    commands,
    migrationCommands,
    ...operations,
  };
}

test("wizard paths stay outside the repository and state rejects secret fields", async () => {
  const context = await fixture();
  try {
    assert.throws(
      () => internals.assertPrivatePath(join(context.repositoryRoot, "wizard.json"), context.repositoryRoot, "state"),
      /outside the repository/
    );
    const state = {
      formatVersion: internals.FORMAT_VERSION,
      root: context.repositoryRoot,
      release: {
        tag: "v0.1.31",
        version: "0.1.31",
        commit: "1".repeat(40),
        image: `alpr-community:0.1.31-${"1".repeat(12)}`,
      },
      configuration: {
        projectName: "alpr-migration-test",
        appPort: 3100,
        dbPort: 55432,
        storage: { targetPath: join(context.repositoryRoot, "storage") },
        dumpPath: join(context.temporaryRoot, "source.dump"),
        workflowStatePath: join(context.temporaryRoot, "source.dump.workflow.json"),
      },
      resources: { directories: [] },
      steps: Object.fromEntries(internals.STEPS.map((step) => [step, { status: "pending" }])),
      databasePassword: "must-not-persist",
    };
    assert.throws(() => internals.validateState(state, context.repositoryRoot), /forbidden secret-like field/);
  } finally {
    await context.cleanup();
  }
});

test("dotenv parser reads generated quoted values without exposing them in state", () => {
  assert.deepEqual(
    internals.parseDotenv("DB_PASSWORD='a-b_c'\nTZ=UTC\n# ignored\n"),
    { DB_PASSWORD: "a-b_c", TZ: "UTC" }
  );
});

test("storage accepts a local mount, a restricted SSH source, or an explicit no-storage acknowledgement", async () => {
  const context = await fixture();
  try {
    assert.deepEqual(
      await internals.collectStorage(
        { ALPR_MIGRATION_SOURCE_STORAGE_SSH: "alpr@source.example.test:/srv/alpr/storage" },
        context.repositoryRoot,
        { interactive: false }
      ),
      {
        mode: "ssh",
        source: "alpr@source.example.test:/srv/alpr/storage",
        targetPath: join(context.repositoryRoot, "storage"),
      }
    );
    await assert.rejects(
      internals.collectStorage(
        { ALPR_MIGRATION_SOURCE_STORAGE_SSH: "alpr@source.example.test:/srv/../private" },
        context.repositoryRoot,
        { interactive: false }
      ),
      /restricted form/
    );
    await assert.rejects(
      internals.collectStorage(
        {
          ALPR_MIGRATION_SOURCE_STORAGE_PATH: join(context.temporaryRoot, "local"),
          ALPR_MIGRATION_SOURCE_STORAGE_SSH: "alpr@source.example.test:/srv/alpr/storage",
        },
        context.repositoryRoot,
        { interactive: false }
      ),
      /not both/
    );
  } finally {
    await context.cleanup();
  }
});

test("wizard prepares once, stops for source quiescence, then resumes every automated check", async () => {
  const context = await fixture();
  const options = testOptions(context);
  try {
    const waiting = await runMigrationWizardCommand(["start"], context.environment, options);
    assert.equal(waiting.status, "waiting-for-source-stop");
    assert.equal(waiting.steps.target.status, "completed");
    assert.equal(waiting.steps.database.status, "pending");
    assert.deepEqual(options.migrationCommands, ["preflight"]);

    const ready = await runMigrationWizardCommand(
      ["resume"],
      {
        ...context.environment,
        ALPR_MIGRATION_SOURCE_QUIESCED: internals.SOURCE_QUIESCED_ACKNOWLEDGEMENT,
      },
      options
    );
    assert.equal(ready.status, "ready-for-review");
    assert.deepEqual(
      internals.STEPS.map((step) => ready.steps[step].status),
      ["completed", "completed", "completed", "completed", "completed"]
    );
    assert.deepEqual(options.migrationCommands, ["preflight", "dump", "restore", "validate"]);
    assert.equal(ready.steps.application.result.outboundNetwork, "isolated");

    const saved = await readFile(context.statePath, "utf8");
    assert.doesNotMatch(saved, /source-password-sentinel|administrator-password-sentinel/);
    assert.match(saved, /ready-for-review/);
  } finally {
    await context.cleanup();
  }
});

test("failed steps store only a redacted code and cannot silently rerun failed target creation", async () => {
  const context = await fixture();
  const options = testOptions(context, {
    prepareTarget: async () => { throw new Error("source-password-sentinel internal detail"); },
  });
  try {
    await assert.rejects(
      runMigrationWizardCommand(["start"], context.environment, options),
      /internal detail/
    );
    const saved = await readFile(context.statePath, "utf8");
    assert.doesNotMatch(saved, /source-password-sentinel|internal detail/);
    assert.equal(JSON.parse(saved).lastFailure.code, "step-failed");
    await assert.rejects(
      runMigrationWizardCommand(["resume"], context.environment, options),
      /run migrate wizard recover/
    );
  } finally {
    await context.cleanup();
  }
});

test("a failed database restore recreates only the disposable target and resumes from the verified dump", async () => {
  const context = await fixture();
  const migrationCommands = [];
  let restoreAttempts = 0;
  const options = testOptions(context, {
    migrationRunner: async (command) => {
      migrationCommands.push(command);
      if (command === "restore" && restoreAttempts++ === 0) {
        throw new Error("simulated target restore failure");
      }
    },
  });
  const environment = {
    ...context.environment,
    ALPR_MIGRATION_SOURCE_QUIESCED: internals.SOURCE_QUIESCED_ACKNOWLEDGEMENT,
  };
  try {
    await assert.rejects(
      runMigrationWizardCommand(["start"], environment, options),
      /simulated target restore failure/
    );
    const ready = await runMigrationWizardCommand(["resume"], environment, options);
    assert.equal(ready.status, "ready-for-review");
    assert.deepEqual(migrationCommands, ["preflight", "dump", "restore", "restore", "validate"]);
    assert.ok(options.commands.some((command) => command.includes("DROP DATABASE postgres;")));
  } finally {
    await context.cleanup();
  }
});

test("acceptance is explicit, records rollback verification, and leaves target isolated", async () => {
  const context = await fixture();
  const options = testOptions(context);
  try {
    await runMigrationWizardCommand(
      ["start"],
      {
        ...context.environment,
        ALPR_MIGRATION_SOURCE_QUIESCED: internals.SOURCE_QUIESCED_ACKNOWLEDGEMENT,
      },
      options
    );
    await assert.rejects(
      runMigrationWizardCommand(["accept"], context.environment, options),
      /acceptance requires/
    );
    const accepted = await runMigrationWizardCommand(
      ["accept"],
      {
        ...context.environment,
        ALPR_MIGRATION_ACCEPTANCE: internals.ACCEPTANCE_ACKNOWLEDGEMENT,
      },
      options
    );
    assert.equal(accepted.status, "accepted-isolated");
    assert.equal(accepted.acceptance.status, "completed");
    assert.equal(accepted.activation.status, "pending");
    assert.equal(options.migrationCommands.at(-1), "rollback-check");

    await assert.rejects(
      runMigrationWizardCommand(["activate"], context.environment, options),
      /activation requires/
    );
    const activated = await runMigrationWizardCommand(
      ["activate"],
      {
        ...context.environment,
        ALPR_MIGRATION_ACTIVATION: internals.ACTIVATION_ACKNOWLEDGEMENT,
      },
      options
    );
    assert.equal(activated.status, "activated");
    assert.equal(activated.activation.status, "completed");
    assert.ok(options.commands.some((command) => command.includes("down")));
    assert.ok(options.commands.some((command) => command.includes("migrate")));
  } finally {
    await context.cleanup();
  }
});

test("a failed activation returns the accepted target to the isolated network", async () => {
  const context = await fixture();
  const options = testOptions(context, {
    healthCheck: async () => { throw new Error("simulated activation health failure"); },
  });
  try {
    await runMigrationWizardCommand(
      ["start"],
      {
        ...context.environment,
        ALPR_MIGRATION_SOURCE_QUIESCED: internals.SOURCE_QUIESCED_ACKNOWLEDGEMENT,
      },
      options
    );
    await runMigrationWizardCommand(
      ["accept"],
      {
        ...context.environment,
        ALPR_MIGRATION_ACCEPTANCE: internals.ACCEPTANCE_ACKNOWLEDGEMENT,
      },
      options
    );
    await assert.rejects(
      runMigrationWizardCommand(
        ["activate"],
        {
          ...context.environment,
          ALPR_MIGRATION_ACTIVATION: internals.ACTIVATION_ACKNOWLEDGEMENT,
        },
        options
      ),
      /simulated activation health failure/
    );
    const saved = JSON.parse(await readFile(context.statePath, "utf8"));
    assert.equal(saved.status, "activation-failed");
    assert.equal(saved.activation.isolationRecovery, "completed");
    const isolatedRecovery = options.commands.findLastIndex(
      (command) => command.some((argument) => String(argument).endsWith("docker-compose.migration-validation.yml")) &&
        command.includes("app")
    );
    const standardShutdown = options.commands.findLastIndex(
      (command) => command.includes("down") &&
        !command.some((argument) => String(argument).endsWith("docker-compose.migration-validation.yml"))
    );
    assert.ok(isolatedRecovery > standardShutdown);
  } finally {
    await context.cleanup();
  }
});

test("status is redacted and works without database credentials", async () => {
  const context = await fixture();
  const options = testOptions(context);
  try {
    await runMigrationWizardCommand(["start"], context.environment, options);
    const logger = memoryLogger();
    const state = await runMigrationWizardCommand(
      ["status"],
      { ALPR_MIGRATION_WIZARD_STATE_PATH: context.statePath },
      { root: context.repositoryRoot, logger }
    );
    assert.equal(state.status, "waiting-for-source-stop");
    assert.doesNotMatch(logger.messages.join("\n"), /source-password-sentinel|administrator-password-sentinel/);
  } finally {
    await context.cleanup();
  }
});

test("public entrypoints expose the automated wizard and isolated validation boundary", async () => {
  const [wrapper, packageSource, composeSource] = await Promise.all([
    readFile(new URL("../alpr-community", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.migration-validation.yml", import.meta.url), "utf8"),
  ]);
  assert.match(wrapper, /community-migration-wizard\.mjs/);
  assert.equal(JSON.parse(packageSource).scripts["migrate:wizard"], "node scripts/community-migration-wizard.mjs");
  assert.match(composeSource, /internal:\s*true/);
});
