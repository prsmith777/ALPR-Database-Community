import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const migrationAssistant = resolve(
  repositoryRoot,
  "scripts",
  "community-migration-assistant.mjs"
);

export const COMMUNITY_UPGRADE_BASELINES = Object.freeze([
  Object.freeze({
    version: "0.1.20",
    commit: "4cb70c2c5cbe24c7451e5c468692250331b7cbd0",
    sourceMajor: 13,
    exerciseRecovery: false,
  }),
  Object.freeze({
    version: "0.1.21",
    commit: "c783fcafc62396f437c4fa811ce33bce658119b8",
    sourceMajor: 17,
    exerciseRecovery: false,
  }),
  Object.freeze({
    version: "0.1.22",
    commit: "316742ebbd6ba6fc2e2135a4b5c96b61bc160859",
    sourceMajor: 17,
    exerciseRecovery: true,
  }),
]);

function executable(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function runProcess(
  command,
  args,
  {
    environment = process.env,
    input,
    inherit = false,
    allowFailure = false,
  } = {}
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: [
        input === undefined ? "ignore" : "pipe",
        inherit ? "inherit" : "pipe",
        inherit ? "inherit" : "pipe",
      ],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    if (!inherit) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0 || allowFailure) {
        resolvePromise(result);
        return;
      }
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${code}`;
      rejectPromise(new Error(`${command} ${args[0] || ""} failed: ${detail}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function run(command, args, options) {
  return runProcess(executable(command), args, options);
}

async function gitText(args) {
  const result = await run("git", args);
  return result.stdout;
}

function databaseEnvironment(password) {
  return {
    ...process.env,
    POSTGRES_DB: "alpr",
    POSTGRES_USER: "alpr",
    POSTGRES_PASSWORD: password,
  };
}

async function containerExists(name) {
  const result = await run("docker", ["container", "inspect", name], {
    allowFailure: true,
  });
  return result.code === 0;
}

async function startPostgres({
  name,
  image,
  password,
  ownedContainers,
  hostPort,
}) {
  if (await containerExists(name)) {
    throw new Error(`refusing to reuse existing Docker container ${name}`);
  }
  const publish = hostPort
    ? `127.0.0.1:${hostPort}:5432`
    : "127.0.0.1::5432";
  await run(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--env",
      "POSTGRES_DB",
      "--env",
      "POSTGRES_USER",
      "--env",
      "POSTGRES_PASSWORD",
      "--publish",
      publish,
      image,
    ],
    { environment: databaseEnvironment(password) }
  );
  ownedContainers.add(name);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await run(
      "docker",
      ["exec", name, "pg_isready", "--username", "alpr", "--dbname", "alpr"],
      { allowFailure: true }
    );
    if (ready.code === 0) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  const finalReady = await run(
    "docker",
    ["exec", name, "pg_isready", "--username", "alpr", "--dbname", "alpr"],
    { allowFailure: true }
  );
  if (finalReady.code !== 0) {
    const logs = await run("docker", ["logs", name], { allowFailure: true });
    const detail = `${logs.stdout}\n${logs.stderr}`.trim();
    throw new Error(
      `PostgreSQL did not become ready in ${name}${detail ? `: ${detail}` : ""}`
    );
  }
  const portResult = await run("docker", ["port", name, "5432/tcp"]);
  const match = portResult.stdout.trim().match(/:(\d+)$/);
  if (!match) {
    throw new Error(`cannot determine published PostgreSQL port for ${name}`);
  }
  return Number(match[1]);
}

async function stopContainer(name, ownedContainers) {
  if (!ownedContainers.has(name)) return;
  const stopped = await run("docker", ["stop", "--time", "5", name], {
    allowFailure: true,
  });
  if (stopped.code !== 0 && !stopped.stderr.includes("No such container")) {
    throw new Error(`docker stop failed for ${name}: ${stopped.stderr.trim()}`);
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const inspected = await run("docker", ["container", "inspect", name], {
      allowFailure: true,
    });
    if (inspected.code !== 0) {
      ownedContainers.delete(name);
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Docker did not remove stopped temporary container ${name}`);
}

function psqlEnvironment(password) {
  return { ...process.env, PGPASSWORD: password };
}

function psqlArguments(port, extra = []) {
  return [
    "--no-psqlrc",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--username",
    "alpr",
    "--dbname",
    "alpr",
    ...extra,
  ];
}

async function psql(port, password, sql, { tuplesOnly = false } = {}) {
  const args = psqlArguments(port, ["--set", "ON_ERROR_STOP=1"]);
  if (tuplesOnly) args.push("--tuples-only", "--no-align");
  const result = await run("psql", args, {
    environment: psqlEnvironment(password),
    input: sql,
  });
  return result.stdout.trim();
}

async function loadBaseline(port, password, baseline) {
  const packageDefinition = JSON.parse(
    await gitText(["show", `${baseline.commit}:package.json`])
  );
  if (packageDefinition.version !== baseline.version) {
    throw new Error(
      `baseline ${baseline.commit} reports ${packageDefinition.version}, expected ${baseline.version}`
    );
  }
  const schema = await gitText(["show", `${baseline.commit}:schema.sql`]);
  const migrations = await gitText(["show", `${baseline.commit}:migrations.sql`]);
  await psql(port, password, schema);
  await psql(port, password, `BEGIN;\n${migrations}\nCOMMIT;\n`);
  const marker = `UPG${baseline.version.replaceAll(".", "")}`.slice(0, 10);
  const fixture = `
    INSERT INTO public.plates (plate_number, occurrence_count)
    VALUES ('${marker}', 91), ('${marker}Z', 37);

    INSERT INTO public.plate_reads
      (plate_number, timestamp, camera_name, confidence, validated, event_identity)
    VALUES
      ('${marker}', '2026-01-01T00:00:00Z', 'Upgrade Camera', 91.5, true, '${marker}-event-1'),
      ('${marker}', '2026-01-01T00:00:01Z', 'Upgrade Camera', 92.5, true, '${marker}-event-2');
  `;
  await psql(port, password, fixture);
  return {
    marker,
    sourceEvidence: await readSourceEvidence(port, password, marker),
  };
}

function guidedEnvironment({ sourcePort, targetPort, password, dumpPath }) {
  return {
    ...process.env,
    ALPR_MIGRATION_SOURCE_HOST: "127.0.0.1",
    ALPR_MIGRATION_SOURCE_PORT: String(sourcePort),
    ALPR_MIGRATION_SOURCE_DATABASE: "alpr",
    ALPR_MIGRATION_SOURCE_USER: "alpr",
    ALPR_MIGRATION_SOURCE_PASSWORD: password,
    ALPR_MIGRATION_SOURCE_SSLMODE: "disable",
    ALPR_MIGRATION_TARGET_HOST: "127.0.0.1",
    ALPR_MIGRATION_TARGET_PORT: String(targetPort),
    ALPR_MIGRATION_TARGET_DATABASE: "alpr",
    ALPR_MIGRATION_TARGET_USER: "alpr",
    ALPR_MIGRATION_TARGET_PASSWORD: password,
    ALPR_MIGRATION_TARGET_SSLMODE: "disable",
    ALPR_MIGRATION_DUMP_PATH: dumpPath,
  };
}

async function guided(command, environment, { allowFailure = false } = {}) {
  return runProcess(process.execPath, [migrationAssistant, command], {
    environment,
    allowFailure,
  });
}

async function readState(dumpPath) {
  return JSON.parse(await readFile(`${dumpPath}.workflow.json`, "utf8"));
}

async function verifyTarget(port, password, marker) {
  const result = await psql(
    port,
    password,
    `
      SELECT json_build_object(
        'reads', (SELECT COUNT(*) FROM public.plate_reads WHERE plate_number = '${marker}'),
        'observedCount', (SELECT occurrence_count FROM public.plates WHERE plate_number = '${marker}'),
        'zeroCount', (SELECT occurrence_count FROM public.plates WHERE plate_number = '${marker}Z'),
        'baselineMigration', EXISTS (
          SELECT 1 FROM public.schema_migrations
          WHERE version = '2026082301_vehicle_passage_foundation'
        )
      )::text;
    `,
    { tuplesOnly: true }
  );
  const evidence = JSON.parse(result);
  if (
    Number(evidence.reads) !== 2 ||
    evidence.observedCount !== 2 ||
    evidence.zeroCount !== 0 ||
    evidence.baselineMigration !== true
  ) {
    throw new Error(`target evidence failed: ${JSON.stringify(evidence)}`);
  }
  return evidence;
}

async function readSourceEvidence(port, password, marker) {
  const result = await psql(
    port,
    password,
    `
      SELECT json_build_object(
        'reads', (SELECT COUNT(*) FROM public.plate_reads WHERE plate_number = '${marker}'),
        'observedCount', (SELECT occurrence_count FROM public.plates WHERE plate_number = '${marker}'),
        'zeroCount', (SELECT occurrence_count FROM public.plates WHERE plate_number = '${marker}Z')
      )::text;
    `,
    { tuplesOnly: true }
  );
  return JSON.parse(result);
}

async function verifySource(port, password, marker, expected) {
  const evidence = await readSourceEvidence(port, password, marker);
  if (JSON.stringify(evidence) !== JSON.stringify(expected)) {
    throw new Error(
      `retained source changed: expected ${JSON.stringify(expected)}, received ${JSON.stringify(evidence)}`
    );
  }
  return evidence;
}

async function runBaseline(baseline, workspace, suffix) {
  const password = randomBytes(24).toString("hex");
  const sourceName = `alpr-upgrade-${suffix}-${baseline.version.replaceAll(".", "")}-source`;
  const targetName = `alpr-upgrade-${suffix}-${baseline.version.replaceAll(".", "")}-target`;
  const sourceImage = baseline.sourceMajor === 13
    ? process.env.ALPR_UPGRADE_PG13_IMAGE || "postgres:13"
    : process.env.ALPR_UPGRADE_PG17_IMAGE || "postgres:17.10";
  const targetImage = process.env.ALPR_UPGRADE_PG17_IMAGE || "postgres:17.10";
  let sourcePort;
  let targetPort;
  let primaryError = null;
  const ownedContainers = new Set();
  const dumpPath = join(workspace, `community-${baseline.version}.dump`);
  console.log(
    `\n[${baseline.version}] starting disposable PostgreSQL ${baseline.sourceMajor} -> 17 validation`
  );
  try {
    sourcePort = await startPostgres({
      name: sourceName,
      image: sourceImage,
      password,
      ownedContainers,
    });
    targetPort = await startPostgres({
      name: targetName,
      image: targetImage,
      password,
      ownedContainers,
    });
    const { marker, sourceEvidence: initialSourceEvidence } = await loadBaseline(
      sourcePort,
      password,
      baseline
    );
    const baseEnvironment = guidedEnvironment({
      sourcePort,
      targetPort,
      password,
      dumpPath,
    });

    await guided("start", baseEnvironment);
    await guided("resume", {
      ...baseEnvironment,
      ALPR_MIGRATION_SOURCE_QUIESCED: "ALPR_SOURCE_QUIESCED",
    });

    let recoveryEvidence = null;
    if (baseline.exerciseRecovery) {
      await psql(
        targetPort,
        password,
        "CREATE TABLE public.interruption_guard (id integer PRIMARY KEY);"
      );
      const refused = await guided(
        "resume",
        {
          ...baseEnvironment,
          ALPR_MIGRATION_SOURCE_QUIESCED: "ALPR_SOURCE_QUIESCED",
          ALPR_MIGRATION_ACKNOWLEDGE: "ALPR_TO_PG17_EMPTY_TARGET",
        },
        { allowFailure: true }
      );
      if (
        refused.code === 0 ||
        !`${refused.stdout}\n${refused.stderr}`.includes("non-empty target")
      ) {
        throw new Error("interrupted restore exercise did not refuse the non-empty target");
      }
      const failedState = await readState(dumpPath);
      if (
        failedState.status !== "failed" ||
        failedState.lastFailure?.step !== "restore"
      ) {
        throw new Error("interrupted restore did not record a resumable restore checkpoint");
      }
      await stopContainer(targetName, ownedContainers);
      targetPort = await startPostgres({
        name: targetName,
        image: targetImage,
        password,
        ownedContainers,
        hostPort: targetPort,
      });
      recoveryEvidence = {
        refusedNonEmptyTarget: true,
        recordedFailedRestoreCheckpoint: true,
        recreatedTargetAtSameEndpoint: true,
      };
    }

    const restoreEnvironment = guidedEnvironment({
      sourcePort,
      targetPort,
      password,
      dumpPath,
    });
    await guided("resume", {
      ...restoreEnvironment,
      ALPR_MIGRATION_SOURCE_QUIESCED: "ALPR_SOURCE_QUIESCED",
      ALPR_MIGRATION_ACKNOWLEDGE: "ALPR_TO_PG17_EMPTY_TARGET",
    });
    const readyState = await readState(dumpPath);
    if (
      readyState.status !== "ready-for-acceptance" ||
      readyState.steps.validate?.status !== "completed"
    ) {
      throw new Error("guided migration did not reach ready-for-acceptance");
    }
    const targetEvidence = await verifyTarget(targetPort, password, marker);
    await guided("rollback-check", restoreEnvironment);
    const rollbackState = await readState(dumpPath);
    if (rollbackState.rollbackCheck?.status !== "completed") {
      throw new Error("rollback-check completion was not recorded");
    }
    const sourceEvidence = await verifySource(
      sourcePort,
      password,
      marker,
      initialSourceEvidence
    );

    console.log(`[${baseline.version}] passed`);
    return {
      version: baseline.version,
      commit: baseline.commit,
      sourceMajor: baseline.sourceMajor,
      targetMajor: 17,
      targetEvidence,
      sourceEvidence,
      recoveryEvidence,
      status: "passed",
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      stopContainer(targetName, ownedContainers),
      stopContainer(sourceName, ownedContainers),
    ]);
    const cleanupErrors = cleanup
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupErrors.length > 0 && primaryError) {
      for (const error of cleanupErrors) {
        console.error(`cleanup warning after failure: ${error.message}`);
      }
    } else if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Community upgrade matrix left temporary containers behind"
      );
    }
  }
}

function selectedBaselines(argumentsList) {
  const onlyIndex = argumentsList.indexOf("--only");
  if (onlyIndex === -1) return COMMUNITY_UPGRADE_BASELINES;
  const requested = argumentsList[onlyIndex + 1];
  if (!requested) throw new Error("--only requires a version such as 0.1.22");
  const selected = COMMUNITY_UPGRADE_BASELINES.filter(
    (baseline) => baseline.version === requested
  );
  if (selected.length === 0) {
    throw new Error(`unsupported matrix baseline ${requested}`);
  }
  return selected;
}

export async function runCommunityUpgradeMatrix(
  argumentsList = process.argv.slice(2)
) {
  const baselines = selectedBaselines(argumentsList);
  await run("docker", ["version"]);
  await run("psql", ["--version"]);
  await run("pg_dump", ["--version"]);
  await run("pg_restore", ["--version"]);
  const workspace = await mkdtemp(join(tmpdir(), "alpr-community-upgrades-"));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const results = [];
  try {
    for (const baseline of baselines) {
      results.push(await runBaseline(baseline, workspace, suffix));
    }
    console.log("\nCommunity upgrade matrix passed:");
    console.log(JSON.stringify(results, null, 2));
    return results;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runCommunityUpgradeMatrix().catch((error) => {
    console.error(`Community upgrade matrix failed: ${error.message}`);
    process.exitCode = 1;
  });
}
