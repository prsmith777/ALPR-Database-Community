import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("bootstrap exposes new-install, migration, and read-only compatibility modes", async () => {
  const source = await readFile(new URL("bootstrap.sh", root), "utf8");
  assert.match(source, /BOOTSTRAP_VERSION="6"/);
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
  assert.match(source, /MINIMUM_MEMORY_KIB=\$\(\(3500 \* 1024\)\)/);
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

test("bootstrap materializes fresh clones and refuses ambiguous v3 no-checkout residue", async () => {
  const source = await readFile(new URL("bootstrap.sh", root), "utf8");
  assert.doesNotMatch(source, /git clone[^\n]*--no-checkout/);
  assert.match(source, /is_unmaterialized_bootstrap_checkout/);
  assert.match(source, /! -name \.git/);
  assert.match(source, /ls-files --stage/);
  assert.match(source, /ambiguous empty-index checkout/);
  assert.doesNotMatch(source, /Recovering an incomplete bootstrap checkout/);
});

test("bootstrap documentation gates execution on an exact published release checksum", async () => {
  for (const file of ["README.md", "docs/BOOTSTRAP.md"]) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.match(source, /set -Eeuo pipefail/);
    assert.match(source, /releases\/latest/);
    assert.match(source, /releases\/download\/\$\{release_tag\}/);
    assert.match(source, /sha256sum --check --strict/);
    assert.match(source, /--release "\$\{release_tag\}"/);
    assert.doesNotMatch(source, /command -v less|\bless\s+"?\$\{download_dir\}/);
  }
});

test("bootstrap presents a forgiving first-time-user flow", async () => {
  const source = await readFile(new URL("bootstrap.sh", root), "utf8");
  assert.match(source, /New installation\n\s+Choose this for a new, empty ALPR system/);
  assert.match(source, /while true; do/);
  assert.match(source, /Please enter a number from 1 through 4/);
  assert.match(source, /Continue\? \[y\/N\]/);
  assert.match(source, /y\|yes/);
  assert.match(source, /Step 1 of 4: Checking this computer/);
  assert.match(source, /Step 4 of 4: Starting the guided ALPR installer/);
});

test("launcher honors the bootstrap private-runtime override", async () => {
  const source = await readFile(new URL("alpr-community", root), "utf8");
  assert.match(source, /ALPR_BOOTSTRAP_RUNTIME_ROOT/);
});

test("published releases attach the bootstrap and checksum from the exact tag", async () => {
  const workflow = await readFile(new URL(".github/workflows/release-bootstrap.yml", root), "utf8");
  assert.match(workflow, /release:\s*\n\s*types:\s*\n\s*- published/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(workflow, /sha256sum alpr-community-bootstrap\.sh/);
  assert.match(workflow, /gh release upload/);
});
