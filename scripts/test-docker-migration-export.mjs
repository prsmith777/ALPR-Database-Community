import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { docker } from "./docker-migration-client.mjs";
import { listDockerSources, previewDockerExport, exportDockerMigration } from "./docker-migration-export.mjs";
import { verifyMigrationBundle } from "./community-migration-bundle.mjs";
import { hashFile } from "./windows-native-package.mjs";
const workspace = await mkdtemp(path.join(os.tmpdir(), "alpr-docker-real-"));
const owned = [], networks = [], volumes = [];
const reference = "aeb72baf6f0435c8d42ed07422f1b2f3a703e6ac";
async function original(file) {
  const response = await fetch("https://raw.githubusercontent.com/algertc/ALPR-Database/" + reference + "/" + file);
  if (!response.ok) throw new Error("Pinned Original baseline unavailable.");
  return response.text();
}
async function psql(id, sql) {
  return (await docker(["exec", id, "psql", "-U", "postgres", "-d", "postgres", "-At", "--set", "ON_ERROR_STOP=1", "-c", sql])).stdout.trim();
}
try {
  for (const major of [13, 17]) {
    const suffix = randomUUID(), network = "alpr-export-fixture-" + suffix;
    await docker(["network", "create", network]); networks.push(network);
    const password = randomUUID();
    const db = (await docker(["run", "-d", "--name", network + "-db", "--network", network, "--network-alias", "db",
      "--env", "POSTGRES_PASSWORD", "postgres:" + (major === 13 ? "13" : "17.10")], { environment: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 300_000 })).stdout.trim();
    owned.push(db);
    for (let attempt = 0; ; attempt++) {
      try { await psql(db, "SELECT 1;"); break; }
      catch (error) { if (attempt === 60) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    console.log("Preparing isolated Original schema on PostgreSQL " + major);
    for (const file of ["schema.sql", "migrations.sql"]) {
      const local = path.join(workspace, major + "-" + file); await writeFile(local, await original(file));
      await docker(["cp", local, db + ":/tmp/" + file]);
      // The pinned Original schema has an ALTER OWNER for devmgmt before its
      // migrations create that table. Reproduce its entrypoint semantics, then
      // require the complete migrations and supported schema to validate.
      const loaded = await docker(["exec", db, "psql", "-U", "postgres", "-d", "postgres",
        ...(file === "migrations.sql" ? ["--set", "ON_ERROR_STOP=1", "--single-transaction"] : []), "-f", "/tmp/" + file]);
      const unexpected = loaded.stderr.split("\n").filter(line => line.includes("ERROR:") && !line.includes('relation "devmgmt" does not exist'));
      assert.deepEqual(unexpected, [], "Pinned Original schema preparation failed unexpectedly.");
    }
    await psql(db, "INSERT INTO public.plates(plate_number,occurrence_count) VALUES ('TEST0001',1); INSERT INTO public.plate_reads(plate_number,camera_name,image_path,timestamp) VALUES ('TEST0001','Synthetic camera','images/test.jpg',CURRENT_TIMESTAMP);");
    const fixture = path.join(workspace, "files-" + major);
    for (const folder of ["config", "auth", "storage/images"]) await mkdir(path.join(fixture, folder), { recursive: true });
    await writeFile(path.join(fixture, "config/settings.yaml"), "general:\n  maxRecords: 4321\n");
    await writeFile(path.join(fixture, "auth/auth.json"), JSON.stringify({ password: "synthetic-hash", apiKey: "a".repeat(64), sessions: {} }));
    await writeFile(path.join(fixture, "storage/images/test.jpg"), "synthetic image");
    const mounts = [];
    for (const folder of ["config", "auth", "storage"]) {
      const name = network + "-" + folder; await docker(["volume", "create", name]); volumes.push(name);
      mounts.push("--mount", "type=volume,src=" + name + ",dst=/app/" + folder);
    }
    const app = (await docker(["create", "--name", network + "-app", "--network", network, ...mounts,
      "--env", "DB_PASSWORD", "--env", "TZ=America/Denver", "alpine:3.23", "sleep", "3600"],
      { environment: { ...process.env, DB_PASSWORD: password }, timeout: 300_000 })).stdout.trim();
    owned.push(app);
    for (const folder of ["config", "auth", "storage"]) await docker(["cp", path.join(fixture, folder) + path.sep + ".", app + ":/app/" + folder]);
    if (major === 13) await docker(["start", app]);
    const listed = await listDockerSources();
    assert.ok(listed.containers.some(item => item.id === app && item.application));
    assert.ok(!JSON.stringify(listed).includes(password));
    const preview = await previewDockerExport({ appId: app, databaseId: db, workParent: workspace });
    assert.equal(preview.sourceProfile, "original-alpr-v0.1.9"); assert.equal(preview.plateReads, "1");
    const request = { appId: app, databaseId: db, destination: path.join(workspace, "backup-" + major),
      confirmation: preview.confirmation, expected: preview, writersPaused: true };
    if (major === 13) {
      let injected = false;
      await assert.rejects(exportDockerMigration({ ...request, destination: path.join(workspace, "failed-" + major) },
        { docker(args, options) { if (!injected && args[0] === "cp" && args[1].includes(":/app/storage")) { injected = true; throw new Error("injected copy failure"); } return docker(args, options); } }), /injected/);
      assert.equal(JSON.parse((await docker(["inspect", app])).stdout)[0].State.Running, true, "A failed backup must restart only its selected application.");
    }
    await exportDockerMigration(request);
    const bundle = await verifyMigrationBundle(request.destination);
    assert.equal(bundle.database.source.tableCounts.plate_reads, "1");
    assert.equal(bundle.files["storage/images/test.jpg"], await hashFile(path.join(fixture, "storage/images/test.jpg")));
    assert.equal(bundle.runtimeTimeZone, "America/Denver");
    assert.equal(JSON.parse((await docker(["inspect", app])).stdout)[0].State.Running, major === 13, "Preserve the source's original running/stopped state.");
    assert.equal(await psql(db, "SELECT count(*) FROM public.plate_reads;"), "1");
    assert.equal(JSON.parse(await readFile(path.join(request.destination, "auth/auth.json"), "utf8")).apiKey, "a".repeat(64));
    if (process.env.ALPR_DOCKER_TEST_OUTPUT && major === 13) await cp(request.destination, path.resolve(process.env.ALPR_DOCKER_TEST_OUTPUT), { recursive: true, errorOnExist: true, force: false });
    console.log("Docker PostgreSQL " + major + " export passed source attestation, exact row counts, named-volume images/config/auth, restart recovery and unchanged source.");
  }
} finally {
  for (const id of owned.reverse()) await docker(["rm", "--force", id]).catch(() => {});
  for (const name of volumes) await docker(["volume", "rm", name]).catch(() => {});
  for (const name of networks) await docker(["network", "rm", name]).catch(() => {});
  await rm(workspace, { recursive: true, force: true });
}
