import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getReleaseInfo,
  normalizeReleaseSha,
  releaseShaFromImage,
} from "../lib/release-info.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("release information resolves a commit-pinned deployment image", () => {
  const release = getReleaseInfo({
    ALPR_RELEASE_IMAGE: "alpr-community:8cd2fa8",
    ALPR_RELEASE_CHANNEL: "staging",
  });

  assert.equal(release.version, "0.1.9");
  assert.equal(release.gitSha, "8cd2fa8");
  assert.equal(release.channel, "staging");
  assert.equal(release.source, "commit-pinned image");
  assert.equal(release.readOnly, true);
  assert.ok(release.notes.items.length >= 4);
});

test("an explicit valid SHA overrides the image tag", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const release = getReleaseInfo({
    ALPR_RELEASE_SHA: sha.toUpperCase(),
    ALPR_RELEASE_IMAGE: "alpr-community:8cd2fa8",
  });

  assert.equal(release.gitSha, sha);
  assert.equal(release.source, "environment");
  assert.equal(release.channel, "self-hosted");
});

test("invalid release metadata is rejected or safely bounded", () => {
  assert.equal(normalizeReleaseSha("not-a-sha"), null);
  assert.equal(releaseShaFromImage("registry:latest"), null);

  const release = getReleaseInfo({
    ALPR_RELEASE_SHA: "../../etc/passwd",
    ALPR_RELEASE_IMAGE: "registry:latest",
    ALPR_RELEASE_CHANNEL: "staging\n<script>",
  });

  assert.equal(release.gitSha, null);
  assert.equal(release.channel, "self-hosted");
  assert.equal(release.source, "not provided");
});

test("the administrator Release page remains read-only", async () => {
  const [card, form, page, shell, compose, module] = await Promise.all([
    source("app/settings/ReleaseInformationCard.jsx"),
    source("app/settings/SettingsForm.jsx"),
    source("app/settings/page.jsx"),
    source("components/settings/SettingsShell.jsx"),
    source("docker-compose.yml"),
    source("lib/release-info.mjs"),
  ]);

  assert.match(shell, /title: "Release"/);
  assert.match(shell, /section=release/);
  assert.match(page, /getReleaseInfo\(\)/);
  assert.match(form, /ReleaseInformationCard/);
  assert.match(form, /"release"/);
  assert.match(card, /Installed release/);
  assert.match(card, /Updates remain externally orchestrated/);
  assert.doesNotMatch(card, /onClick=/);
  assert.doesNotMatch(module, /child_process|\bexec\b|\bspawn\b|fetch\s*\(/);
  assert.match(compose, /ALPR_RELEASE_IMAGE/);
  assert.match(compose, /ALPR_RELEASE_SHA/);
  assert.match(compose, /ALPR_RELEASE_CHANNEL/);
});
