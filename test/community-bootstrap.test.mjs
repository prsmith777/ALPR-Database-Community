import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("bootstrap exposes new-install, migration, and read-only compatibility modes", async () => {
  const source = await readFile(new URL("bootstrap.sh", root), "utf8");
  assert.match(source, /--new/);
  assert.match(source, /--migrate/);
  assert.match(source, /--check \[new\|migration\]/);
  assert.match(source, /ubuntu.*24\.04/is);
  assert.match(source, /x86_64/);
  assert.match(source, /MINIMUM_CPU_COUNT=2/);
  assert.match(source, /MINIMUM_MEMORY_KIB=\$\(\(4 \* 1024 \* 1024\)\)/);
  assert.match(source, /MINIMUM_FREE_KIB=\$\(\(20 \* 1024 \* 1024\)\)/);
});

test("bootstrap installs and verifies the complete supported host toolchain", async () => {
  const source = await readFile(new URL("bootstrap.sh", root), "utf8");
  for (const expected of [
    "git", "docker-ce", "docker-buildx-plugin", "docker-compose-plugin",
    "node-v${PINNED_NODE_VERSION}-linux-x64", "postgresql-client-17", "rsync", "openssh-client",
  ]) assert.ok(source.includes(expected), `missing bootstrap dependency contract: ${expected}`);
  assert.match(source, /SHASUMS256\.txt/);
  assert.match(source, /storage\.openvinotoolkit\.org/);
  assert.match(source, /\.\/alpr-community install/);
  assert.match(source, /\.\/alpr-community migrate wizard/);
});

test("bootstrap refuses unsafe replacement and package-removal behavior", async () => {
  const source = await readFile(new URL("bootstrap.sh", root), "utf8");
  assert.doesNotMatch(source, /curl[^\n]*\|[^\n]*(ba)?sh/);
  assert.doesNotMatch(source, /apt(?:-get)?\s+(?:-y\s+)?remove/);
  assert.doesNotMatch(source, /docker\s+(?:system|builder|image|volume)\s+prune/);
  assert.match(source, /Existing Community checkout is not clean/);
  assert.match(source, /An installed Community target already exists/);
  assert.match(source, /not as root/);
});

test("published releases attach the bootstrap and checksum from the exact tag", async () => {
  const workflow = await readFile(new URL(".github/workflows/release-bootstrap.yml", root), "utf8");
  assert.match(workflow, /release:\s*\n\s*types:\s*\n\s*- published/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(workflow, /sha256sum alpr-community-bootstrap\.sh/);
  assert.match(workflow, /gh release upload/);
});
