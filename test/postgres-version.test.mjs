import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = await readFile(
  new URL("../docker-compose.yml", import.meta.url),
  "utf8",
);
const databaseOnlyCompose = await readFile(
  new URL("../docker-compose-dbonly.yml", import.meta.url),
  "utf8",
);
const deploymentRunbook = await readFile(
  new URL("../docs/personal-deployment.md", import.meta.url),
  "utf8",
);

test("bundled database services use the supported PostgreSQL release", () => {
  for (const source of [compose, databaseOnlyCompose]) {
    assert.match(source, /image:\s*postgres:17\.10/);
    assert.doesNotMatch(source, /image:\s*postgres:13(?:\s|$)/);
  }
});

test("the deployment runbook warns that a fresh volume is required", () => {
  assert.match(deploymentRunbook, /must not be started with the PostgreSQL 17 image/);
  assert.match(deploymentRunbook, /restoring it into a fresh\s+PostgreSQL 17 volume/);
  assert.match(deploymentRunbook, /retaining the PostgreSQL\s+13 volume/);
});
