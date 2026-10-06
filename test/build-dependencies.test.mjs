import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { twMerge } from "tailwind-merge";

const require = createRequire(import.meta.url);

test("Next lint root discovery retains directory glob behavior with tinyglobby", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "alpr-lint-glob-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["one", "two"]) await mkdir(path.join(root, "apps", name), { recursive: true });
  await writeFile(path.join(root, "apps", "not-a-directory.txt"), "fixture");
  const { getRootDirs } = require("@next/eslint-plugin-next/dist/utils/get-root-dirs.js");
  const asNames = (dirs) => dirs.map((dir) => path.basename(dir)).sort();
  assert.deepEqual(getRootDirs({ cwd: root, settings: {} }), [root]);
  assert.deepEqual(asNames(getRootDirs({ cwd: root, settings: { next: { rootDir: root + "/apps/*" } } })), ["one", "two"]);
  assert.deepEqual(asNames(getRootDirs({ cwd: root, settings: { next: { rootDir: [root + "/apps/{one,two}", root + "/missing/*"] } } })), ["one", "two"]);
  const pluginRequire = createRequire(require.resolve("@next/eslint-plugin-next"));
  assert.equal(pluginRequire("fast-glob/package.json").name, "tinyglobby");
  assert.throws(() => require.resolve("braces"), { code: "MODULE_NOT_FOUND" });
  assert.throws(() => require.resolve("micromatch"), { code: "MODULE_NOT_FOUND" });
});

test("shared stylesheet compiles theme colors, controls, sidebar widths and animations", async () => {
  const filename = new URL("../app/globals.css", import.meta.url);
  const source = (await readFile(filename, "utf8")).replace("@import 'tailwindcss';", "@import 'tailwindcss' source(none);") +
    '\n@source inline("bg-background text-foreground dark:bg-zinc-950 rounded-md shadow-xs outline-hidden w-(--sidebar-width) animate-in fade-in-0");\n';
  const result = await postcss([tailwind({ optimize: false })]).process(source, { from: fileURLToPath(filename) });
  const rules = new Map();
  result.root.walkRules((rule) => { if (!rules.has(rule.selector)) rules.set(rule.selector, []); rules.get(rule.selector).push(rule.toString()); });
  assert.match(rules.get(".bg-background").join(""), /background-color: hsl\(var\(--background\)\)/);
  assert.match(rules.get(".text-foreground").join(""), /color: hsl\(var\(--foreground\)\)/);
  assert.match(rules.get(".rounded-md").join(""), /border-radius: calc\(var\(--radius\) - 2px\)/);
  assert.match(result.css, /width: var\(--sidebar-width\)/);
  assert.match(result.css, /--tw-shadow: 0 1px 2px 0/);
  assert.match(result.css, /outline: 2px solid transparent/);
  assert.match(result.css, /:is\(\.dark \*\)/);
  assert.match(result.css, /animation-name: enter/);
  assert.match(result.css, /@keyframes enter/);
});

test("class overrides retain Tailwind 4 shadow, size and outline behavior", () => {
  assert.equal(twMerge("shadow-xs shadow-lg"), "shadow-lg");
  assert.equal(twMerge("w-(--sidebar-width) w-12"), "w-12");
  assert.equal(twMerge("outline-hidden outline-none"), "outline-none");
});
