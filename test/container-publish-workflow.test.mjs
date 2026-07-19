import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/publish-container.yml", import.meta.url),
  "utf8",
);

test("container publishing is fork-owned, immutable, and never runs for pull requests", () => {
  assert.match(workflow, /IMAGE_NAME: prsmith777\/alpr-database-community/);
  assert.match(workflow, /type=sha,format=long,prefix=sha-/);
  assert.match(workflow, /flavor: latest=false/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /- main/);
  assert.match(workflow, /- feature\/ux-foundation/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /algertc\/alpr-dashboard/);
  assert.doesNotMatch(workflow, /:latest/);
});

test("container publishing has narrow permissions and attestable provenance", () => {
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /platforms: linux\/amd64/);
  assert.match(workflow, /subject-digest: \$\{\{ steps\.push\.outputs\.digest \}\}/);
  assert.match(workflow, /push-to-registry: true/);
  assert.doesNotMatch(workflow, /cache-(?:from|to):\s*type=gha/);

  for (const action of [
    "docker/login-action",
    "docker/metadata-action",
    "docker/build-push-action",
  ]) {
    assert.match(
      workflow,
      new RegExp(`${action}@[0-9a-f]{40}`),
      `${action} must be pinned to a full commit SHA`,
    );
  }
});
