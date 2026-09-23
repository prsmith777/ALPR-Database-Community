import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CI invokes only package scripts included in the Community repository", async () => {
  const [workflow, packageText] = await Promise.all([
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const scripts = new Set(Object.keys(JSON.parse(packageText).scripts || {}));
  const invokedScripts = [...workflow.matchAll(/\byarn\s+([a-zA-Z0-9][a-zA-Z0-9:_-]*)/g)]
    .map((match) => match[1])
    .filter((name) => name !== "install");

  assert.ok(invokedScripts.length > 0);
  assert.deepEqual(
    [...new Set(invokedScripts.filter((name) => !scripts.has(name)))],
    []
  );
});
