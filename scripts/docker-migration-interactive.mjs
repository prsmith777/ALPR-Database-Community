import { createInterface } from "node:readline/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { listDockerSources, previewDockerExport, exportDockerMigration } from "./docker-migration-export.mjs";
const input = createInterface({ input: process.stdin, output: process.stdout });
try {
  const sources = await listDockerSources();
  const apps = sources.containers.filter(item => item.application);
  const databases = sources.containers.filter(item => item.database);
  for (const [title, items] of [["ALPR applications", apps], ["PostgreSQL databases", databases]]) {
    console.log(title);
    items.forEach((item, index) => console.log(String(index + 1) + ": " + item.name + " | " + item.image));
  }
  const app = apps[Number(await input.question("Original ALPR application number: ")) - 1];
  const database = databases[Number(await input.question("Original database number: ")) - 1];
  if (!app || !database) throw new Error("Select both source containers.");
  const answer = await input.question("Private local backup directory (absolute path): ");
  if (!path.isAbsolute(answer)) throw new Error("Use an absolute private backup path.");
  const parent = path.resolve(answer);
  if (!path.isAbsolute(parent)) throw new Error("Use an absolute private backup path.");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const preview = await previewDockerExport({ appId: app.id, databaseId: database.id, workParent: parent });
  console.log(preview.sourceLabel + ", PostgreSQL " + preview.serverMajor + ", plate reads: " + preview.plateReads);
  if (preview.plateReads === "0") console.log("WARNING: this source is empty. Cancel if you expected historical records.");
  console.log("Pause every other database writer. The selected original Docker app will stop briefly and restart afterward.");
  if (await input.question("Type EXPORT ORIGINAL DOCKER DATABASE to confirm: ") !== "EXPORT ORIGINAL DOCKER DATABASE") throw new Error("Cancelled without stopping the source.");
  const destination = path.join(parent, "Docker-ALPR-" + randomUUID());
  const result = await exportDockerMigration({ appId: app.id, databaseId: database.id, destination,
    confirmation: preview.confirmation, expected: preview, writersPaused: true });
  console.log("Verified backup: " + result.destination + os.EOL + "Copy the entire folder to Windows. Pause source ingestion again before import. The importer requires an empty target and does not merge existing records.");
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { input.close(); }
