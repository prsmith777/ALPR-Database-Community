import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runFreshUpdater } from "../scripts/community-updater-process.mjs";

test("each operation imports the installed updater afresh and returns results independently of logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpr-fresh-updater-"));
  try {
    await mkdir(join(root, "scripts"));
    const script = join(root, "scripts", "community-updater.mjs");
    await writeFile(script, 'export async function runUpdaterCommand(args, env, options) { console.log("fixture build output"); return { version: 1, command: args[0], root: options.root, confirmed: options.confirmed, variable: env.FIXTURE_VALUE }; }');
    const options = { root, confirmed: true };
    const environment = { ...process.env, FIXTURE_VALUE: "passed" };
    assert.deepEqual(await runFreshUpdater(["status"], environment, options),
      { version: 1, command: "status", root, confirmed: true, variable: "passed" });
    await writeFile(script, 'export async function runUpdaterCommand() { return { version: 2 }; }');
    assert.deepEqual(await runFreshUpdater(["validate"], environment, options), { version: 2 });
    await writeFile(script, 'export async function runUpdaterCommand() { throw new Error("validation refused"); }');
    await assert.rejects(runFreshUpdater(["validate"], environment, options), /validation refused/);
    await writeFile(script, 'export async function runUpdaterCommand() { process.exit(0); }');
    await assert.rejects(runFreshUpdater(["validate"], environment, options), /without success/);
    await assert.rejects(runFreshUpdater(["arbitrary-command"], environment, options), /Unsupported/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
