import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const workflowsDirectory = path.resolve(".github", "workflows");
const immutableActionReference = /@[0-9a-f]{40}$/;

test("GitHub Actions use immutable commit references", async () => {
  const workflowFiles = (await readdir(workflowsDirectory))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();

  assert.ok(workflowFiles.length > 0, "expected at least one GitHub Actions workflow");

  const mutableReferences = [];
  for (const workflowFile of workflowFiles) {
    const contents = await readFile(path.join(workflowsDirectory, workflowFile), "utf8");
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      const match = line.match(/^\s*uses:\s*([^\s#]+)/);
      if (!match || match[1].startsWith("./")) continue;
      if (!immutableActionReference.test(match[1])) {
        mutableReferences.push(`${workflowFile}:${index + 1}: ${match[1]}`);
      }
    }
  }

  assert.deepEqual(
    mutableReferences,
    [],
    `mutable GitHub Actions references found:\n${mutableReferences.join("\n")}`,
  );
});
