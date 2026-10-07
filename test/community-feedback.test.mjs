import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import yaml from "js-yaml";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function issueTemplate(name) {
  return yaml.load(await source(`.github/ISSUE_TEMPLATE/${name}`));
}

test("Community feedback uses structured issues and routes questions and security safely", async () => {
  const [config, bug, feature] = await Promise.all([
    issueTemplate("config.yml"),
    issueTemplate("bug_report.yml"),
    issueTemplate("feature_request.yml"),
  ]);

  assert.equal(config.blank_issues_enabled, false);
  const contacts = new Map(config.contact_links.map((link) => [link.name, link.url]));
  assert.equal(contacts.size, config.contact_links.length);
  assert.equal(contacts.get("Documentation wiki"), "https://github.com/prsmith777/ALPR-Database-Community/wiki");
  assert.equal(contacts.get("Install on Windows 10 or Windows 11"), "https://github.com/prsmith777/ALPR-Database-Community/blob/main/docs/WINDOWS_INSTALL.md");
  assert.equal(contacts.get("Questions, setup help, and general feedback"), "https://github.com/prsmith777/ALPR-Database-Community/discussions");
  assert.equal(contacts.get("Report a security vulnerability privately"), "https://github.com/prsmith777/ALPR-Database-Community/security/advisories/new");
  assert.deepEqual(bug.labels, ["bug"]);
  assert.deepEqual(feature.labels, ["enhancement"]);

  const bugSource = await source(".github/ISSUE_TEMPLATE/bug_report.yml");
  assert.match(bugSource, /GitHub issues are public/);
  assert.match(bugSource, /I tested the latest stable Community release/);
  assert.match(bugSource, /I removed credentials/);
});

test("public documentation exposes every feedback channel and privacy boundary", async () => {
  const [readme, contributing, security] = await Promise.all([
    source("README.md"),
    source("CONTRIBUTING.md"),
    source("SECURITY.md"),
  ]);
  const documentation = `${readme}\n${contributing}\n${security}`;

  assert.match(documentation, /ALPR-Database-Community\/discussions/);
  assert.match(documentation, /template=bug_report\.yml/);
  assert.match(documentation, /template=feature_request\.yml/);
  assert.match(documentation, /security\/advisories\/new/);
  assert.match(contributing, /Support is provided on a best-effort basis by a single maintainer/);
  assert.match(contributing, /GitHub issues, discussions, comments, and pull requests are public/);
});
