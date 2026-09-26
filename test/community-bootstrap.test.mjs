import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("bootstrap exposes new-install, migration, and read-only compatibility modes", async () => {
  const source = await readFile(new URL("bootstrap.sh", root), "utf8");
  assert.match(source, /--new/);
  assert.match(source, /--migrate/);
  assert.match(source, /--check \[new\|migration\]/);
  for (const platform of [
    "22.04:jammy", "24.04:noble", "26.04:resolute",
    "12:bookworm", "13:trixie", "rhel|rocky|almalinux",
    "CentOS Stream 9 or 10", "43|44",
  ]) assert.ok(source.includes(platform), `missing automatic platform contract: ${platform}`);
  assert.match(source, /x86_64/);
  assert.match(source, /MINIMUM_CPU_COUNT=2/);
  assert.match(source, /MINIMUM_MEMORY_KIB=\$\(\(4 \* 1024 \* 1024\)\)/);
  assert.match(source, /MINIMUM_FREE_KIB=\$\(\(20 \* 1024 \* 1024\)\)/);
});

test("bootstrap installs and verifies the complete supported host toolchain", async () => {
  const source = await readFile(new URL("bootstrap.sh", root), "utf8");
  for (const expected of [
    "git", "docker-ce", "docker-buildx-plugin", "docker-compose-plugin",
    "node-v${PINNED_NODE_VERSION}-linux-x64", "postgresql-client-17", "postgresql17",
    "rsync", "openssh-client", "openssh-clients",
  ]) assert.ok(source.includes(expected), `missing bootstrap dependency contract: ${expected}`);
  assert.match(source, /SHASUMS256\.txt/);
  assert.match(source, /storage\.openvinotoolkit\.org/);
  assert.match(source, /\.\/alpr-community install/);
  assert.match(source, /\.\/alpr-community migrate wizard/);
});

test("bootstrap uses distribution-specific signed repositories", async () => {
  const source = await readFile(new URL("bootstrap.sh", root), "utf8");
  for (const expected of [
    "download.docker.com/linux/${DOCKER_REPOSITORY_DISTRIBUTION}",
    "${OS_CODENAME}-pgdg",
    "reporpms/EL-${OS_MAJOR_VERSION}-x86_64",
    "reporpms/F-${OS_MAJOR_VERSION}-x86_64",
    "pgdg-redhat-repo-latest.noarch.rpm",
    "pgdg-fedora-repo-latest.noarch.rpm",
  ]) assert.ok(source.includes(expected), `missing repository adapter contract: ${expected}`);

  const launcher = await readFile(new URL("alpr-community", root), "utf8");
  assert.match(launcher, /\/usr\/lib\/postgresql\/17\/bin/);
  assert.match(launcher, /\/usr\/pgsql-17\/bin/);
});

test("bootstrap refuses unsafe replacement and package-removal behavior", async () => {
  const source = await readFile(new URL("bootstrap.sh", root), "utf8");
  assert.doesNotMatch(source, /curl[^\n]*\|[^\n]*(ba)?sh/);
  assert.doesNotMatch(source, /apt(?:-get)?\s+(?:-y\s+)?remove/);
  assert.doesNotMatch(source, /dnf\s+(?:-y\s+)?remove/);
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
