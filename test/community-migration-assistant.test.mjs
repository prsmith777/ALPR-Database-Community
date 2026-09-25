import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  guidedMigrationInternals as internals,
  runGuidedMigrationCommand,
} from "../scripts/community-migration-assistant.mjs";

function migrationEnvironment(root) {
  return {
    ALPR_MIGRATION_SOURCE_HOST: "source-db.example.test",
    ALPR_MIGRATION_SOURCE_PORT: "5432",
    ALPR_MIGRATION_SOURCE_DATABASE: "alpr_source",
    ALPR_MIGRATION_SOURCE_USER: "migration_source",
    ALPR_MIGRATION_SOURCE_PASSWORD: "source-secret",
    ALPR_MIGRATION_SOURCE_SSLMODE: "require",
    ALPR_MIGRATION_TARGET_HOST: "target-db.example.test",
    ALPR_MIGRATION_TARGET_PORT: "5433",
    ALPR_MIGRATION_TARGET_DATABASE: "alpr_target",
    ALPR_MIGRATION_TARGET_USER: "migration_target",
    ALPR_MIGRATION_TARGET_PASSWORD: "target-secret",
    ALPR_MIGRATION_TARGET_SSLMODE: "require",
    ALPR_MIGRATION_DUMP_PATH: join(root, "artifacts", "alpr.dump"),
  };
}

function fixedClock() {
  let seconds = 0;
  return () => new Date(Date.UTC(2026, 8, 25, 0, 0, seconds++));
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

async function fixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "alpr-guided-migration-"));
  const repositoryRoot = join(temporaryRoot, "repo");
  await mkdir(repositoryRoot);
  return {
    temporaryRoot,
    repositoryRoot,
    environment: migrationEnvironment(temporaryRoot),
    async cleanup() {
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

test("workflow configuration is redacted and bound to exact endpoints and artifacts", async () => {
  const context = await fixture();
  try {
    const configuration = internals.workflowConfiguration(
      context.environment,
      context.repositoryRoot
    );
    const serialized = JSON.stringify(configuration);
    assert.equal(configuration.source.database, "alpr_source");
    assert.equal(configuration.target.port, 5433);
    assert.doesNotMatch(serialized, /source-secret|target-secret/);
    assert.match(internals.workflowIdentity(configuration), /^[A-F0-9]{64}$/);

    const changed = internals.workflowConfiguration(
      { ...context.environment, ALPR_MIGRATION_TARGET_PORT: "5434" },
      context.repositoryRoot
    );
    assert.notEqual(
      internals.workflowIdentity(changed),
      internals.workflowIdentity(configuration)
    );
  } finally {
    await context.cleanup();
  }
});

test("state and dump artifacts must remain outside the repository", async () => {
  const context = await fixture();
  try {
    const insideDump = join(context.repositoryRoot, "private.dump");
    assert.throws(
      () =>
        internals.workflowConfiguration(
          { ...context.environment, ALPR_MIGRATION_DUMP_PATH: insideDump },
          context.repositoryRoot
        ),
      /DUMP_PATH must be outside the repository/
    );
    assert.throws(
      () =>
        internals.workflowConfiguration(
          {
            ...context.environment,
            ALPR_MIGRATION_STATE_PATH: join(context.repositoryRoot, "state.json"),
          },
          context.repositoryRoot
        ),
      /STATE_PATH must be outside the repository/
    );
  } finally {
    await context.cleanup();
  }
});

test("storage paths are optional but must be absolute, paired, separate, and non-nested", async () => {
  const context = await fixture();
  try {
    assert.equal(internals.optionalStoragePaths(context.environment), null);
    assert.throws(
      () =>
        internals.optionalStoragePaths({
          ...context.environment,
          ALPR_MIGRATION_SOURCE_STORAGE_PATH: join(context.temporaryRoot, "source"),
        }),
      /set both/
    );
    assert.throws(
      () =>
        internals.optionalStoragePaths({
          ...context.environment,
          ALPR_MIGRATION_SOURCE_STORAGE_PATH: join(context.temporaryRoot, "storage"),
          ALPR_MIGRATION_TARGET_STORAGE_PATH: join(
            context.temporaryRoot,
            "storage",
            "target"
          ),
        }),
      /separate and non-nested/
    );
    assert.deepEqual(
      internals.optionalStoragePaths({
        ...context.environment,
        ALPR_MIGRATION_SOURCE_STORAGE_PATH: join(context.temporaryRoot, "source-storage"),
        ALPR_MIGRATION_TARGET_STORAGE_PATH: join(context.temporaryRoot, "target-storage"),
      }),
      {
        sourcePath: join(context.temporaryRoot, "source-storage"),
        targetPath: join(context.temporaryRoot, "target-storage"),
      }
    );
  } finally {
    await context.cleanup();
  }
});

test("start and resume stop at acknowledgements without repeating completed steps", async () => {
  const context = await fixture();
  const commands = [];
  const runner = async (command) => {
    commands.push(command);
  };
  const logger = memoryLogger();
  const clock = fixedClock();
  try {
    const first = await runGuidedMigrationCommand("start", context.environment, {
      root: context.repositoryRoot,
      runner,
      logger,
      clock,
    });
    assert.deepEqual(commands, ["preflight"]);
    assert.equal(first.steps.preflight.status, "completed");
    assert.equal(first.status, "waiting-for-dump");
    assert.equal(
      first.waitingFor.requiredValue,
      "ALPR_SOURCE_QUIESCED"
    );

    const afterDump = await runGuidedMigrationCommand(
      "resume",
      {
        ...context.environment,
        ALPR_MIGRATION_SOURCE_QUIESCED: "ALPR_SOURCE_QUIESCED",
      },
      { root: context.repositoryRoot, runner, logger, clock }
    );
    assert.deepEqual(commands, ["preflight", "dump"]);
    assert.equal(afterDump.steps.dump.status, "completed");
    assert.equal(afterDump.status, "waiting-for-restore");

    const ready = await runGuidedMigrationCommand(
      "resume",
      {
        ...context.environment,
        ALPR_MIGRATION_SOURCE_QUIESCED: "ALPR_SOURCE_QUIESCED",
        ALPR_MIGRATION_ACKNOWLEDGE: "ALPR_TO_PG17_EMPTY_TARGET",
      },
      { root: context.repositoryRoot, runner, logger, clock }
    );
    assert.deepEqual(commands, ["preflight", "dump", "restore", "validate"]);
    assert.equal(ready.status, "ready-for-acceptance");
    assert.equal(ready.steps.validate.status, "completed");

    const statePath = `${context.environment.ALPR_MIGRATION_DUMP_PATH}.workflow.json`;
    const saved = await readFile(statePath, "utf8");
    assert.doesNotMatch(saved, /source-secret|target-secret/);
    assert.match(saved, /ready-for-acceptance/);
  } finally {
    await context.cleanup();
  }
});

test("acceptance requires database validation plus storage, application, and final acknowledgements", async () => {
  const context = await fixture();
  const runner = async () => {};
  const clock = fixedClock();
  try {
    const readyEnvironment = {
      ...context.environment,
      ALPR_MIGRATION_SOURCE_QUIESCED: "ALPR_SOURCE_QUIESCED",
      ALPR_MIGRATION_ACKNOWLEDGE: "ALPR_TO_PG17_EMPTY_TARGET",
    };
    await runGuidedMigrationCommand("start", readyEnvironment, {
      root: context.repositoryRoot,
      runner,
      logger: memoryLogger(),
      clock,
    });
    await assert.rejects(
      runGuidedMigrationCommand("accept", readyEnvironment, {
        root: context.repositoryRoot,
        logger: memoryLogger(),
        clock,
      }),
      /STORAGE_VERIFIED=ALPR_STORAGE_VERIFIED/
    );

    const accepted = await runGuidedMigrationCommand(
      "accept",
      {
        ...readyEnvironment,
        ALPR_MIGRATION_STORAGE_VERIFIED: "ALPR_STORAGE_VERIFIED",
        ALPR_MIGRATION_APPLICATION_VERIFIED: "ALPR_APPLICATION_VERIFIED",
        ALPR_MIGRATION_ACCEPTANCE: "ALPR_MIGRATION_ACCEPTED",
      },
      { root: context.repositoryRoot, logger: memoryLogger(), clock }
    );
    assert.equal(accepted.status, "accepted");
    assert.deepEqual(accepted.acceptance.storageVerified, true);
    assert.deepEqual(accepted.acceptance.applicationVerified, true);
  } finally {
    await context.cleanup();
  }
});

test("failed steps record a resumable checkpoint without persisting error or password text", async () => {
  const context = await fixture();
  const logger = memoryLogger();
  try {
    await assert.rejects(
      runGuidedMigrationCommand("start", context.environment, {
        root: context.repositoryRoot,
        logger,
        clock: fixedClock(),
        runner: async () => {
          throw new Error("source-secret must never enter state");
        },
      }),
      /source-secret/
    );
    const statePath = `${context.environment.ALPR_MIGRATION_DUMP_PATH}.workflow.json`;
    const saved = await readFile(statePath, "utf8");
    assert.doesNotMatch(saved, /source-secret|target-secret|must never enter state/);
    const parsed = JSON.parse(saved);
    assert.equal(parsed.status, "failed");
    assert.deepEqual(parsed.lastFailure.code, "step-failed");
    assert.equal(parsed.steps.preflight.status, "failed");

    const commands = [];
    const resumed = await runGuidedMigrationCommand("resume", context.environment, {
      root: context.repositoryRoot,
      logger,
      clock: fixedClock(),
      runner: async (command) => {
        commands.push(command);
      },
    });
    assert.deepEqual(commands, ["preflight"]);
    assert.equal(resumed.steps.preflight.status, "completed");
    assert.equal(resumed.status, "waiting-for-dump");
  } finally {
    await context.cleanup();
  }
});

test("status reads redacted state without database passwords", async () => {
  const context = await fixture();
  try {
    await runGuidedMigrationCommand("init", context.environment, {
      root: context.repositoryRoot,
      logger: memoryLogger(),
      clock: fixedClock(),
    });
    const logger = memoryLogger();
    const statePath = `${context.environment.ALPR_MIGRATION_DUMP_PATH}.workflow.json`;
    const state = await runGuidedMigrationCommand(
      "status",
      { ALPR_MIGRATION_STATE_PATH: statePath },
      { root: context.repositoryRoot, logger }
    );
    assert.equal(state.status, "initialized");
    assert.doesNotMatch(logger.messages.join("\n"), /source-secret|target-secret/);
  } finally {
    await context.cleanup();
  }
});

test("rollback-check verifies through the guarded helper and records completion", async () => {
  const context = await fixture();
  const commands = [];
  const clock = fixedClock();
  try {
    await runGuidedMigrationCommand("init", context.environment, {
      root: context.repositoryRoot,
      logger: memoryLogger(),
      clock,
    });
    const state = await runGuidedMigrationCommand(
      "rollback-check",
      context.environment,
      {
        root: context.repositoryRoot,
        logger: memoryLogger(),
        clock,
        runner: async (command) => {
          commands.push(command);
        },
      }
    );
    assert.deepEqual(commands, ["rollback-check"]);
    assert.equal(state.rollbackCheck.status, "completed");
    assert.match(state.rollbackCheck.completedAt, /^2026-09-25T00:00:/);

    const statePath = `${context.environment.ALPR_MIGRATION_DUMP_PATH}.workflow.json`;
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.rollbackCheck.status, "completed");
    assert.doesNotMatch(JSON.stringify(saved), /source-secret|target-secret/);
  } finally {
    await context.cleanup();
  }
});

test("an initialized workflow refuses endpoint drift", async () => {
  const context = await fixture();
  try {
    await runGuidedMigrationCommand("init", context.environment, {
      root: context.repositoryRoot,
      logger: memoryLogger(),
      clock: fixedClock(),
    });
    await assert.rejects(
      runGuidedMigrationCommand(
        "resume",
        { ...context.environment, ALPR_MIGRATION_TARGET_DATABASE: "different" },
        {
          root: context.repositoryRoot,
          logger: memoryLogger(),
          runner: async () => {},
          clock: fixedClock(),
        }
      ),
      /start a new state file instead of resuming/
    );
  } finally {
    await context.cleanup();
  }
});

test("missing environment variables are reported together", () => {
  const missing = internals.missingRequiredEnvironment({
    ALPR_MIGRATION_SOURCE_HOST: "source",
  });
  assert.equal(missing.includes("ALPR_MIGRATION_SOURCE_HOST"), false);
  assert.equal(missing.includes("ALPR_MIGRATION_TARGET_PASSWORD"), true);
  assert.equal(missing.includes("ALPR_MIGRATION_DUMP_PATH"), true);
});

test("the package and public runbooks expose the guided workflow and its safety boundary", async () => {
  const [packageJson, readme, deployment, guide] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/DEPLOYMENT.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/MIGRATION_GUIDE.md", import.meta.url), "utf8"),
  ]);
  const packageDefinition = JSON.parse(packageJson);
  assert.equal(
    packageDefinition.scripts["migrate:guided"],
    "node scripts/community-migration-assistant.mjs"
  );
  assert.match(readme, /docs\/MIGRATION_GUIDE\.md/);
  assert.match(deployment, /npm run migrate:guided -- start/);
  assert.match(guide, /never switches traffic/i);
  assert.match(guide, /Passwords.*never written/i);
  assert.match(guide, /ALPR_MIGRATION_STORAGE_VERIFIED=ALPR_STORAGE_VERIFIED/);
  assert.match(guide, /ALPR_MIGRATION_APPLICATION_VERIFIED=ALPR_APPLICATION_VERIFIED/);
});
