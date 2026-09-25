import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeImage } from "../scripts/community-image-builder.mjs";

const release = Object.freeze({ version: "0.1.30", commit: "3".repeat(40) });

test("runtime builds use and remove an isolated temporary BuildKit cache", () => {
  const commands = [];
  buildRuntimeImage((command, args) => {
    commands.push([command, ...args]);
    return "";
  }, "/release", release, "alpr-community:0.1.30-333333333333");

  assert.equal(commands.length, 3);
  const create = commands[0].join(" ");
  const build = commands[1].join(" ");
  const remove = commands[2].join(" ");
  const builder = commands[0][4];
  assert.match(create, /^docker buildx create --name alpr-community-build-/);
  assert.ok(build.includes(`--builder ${builder}`));
  assert.ok(build.includes("--pull --load"));
  assert.ok(build.includes("--tag alpr-community:0.1.30-333333333333"));
  assert.equal(remove, `docker buildx rm --force ${builder}`);
});

test("temporary BuildKit cache is removed after a failed build", () => {
  const commands = [];
  assert.throws(() => buildRuntimeImage((command, args) => {
    commands.push([command, ...args]);
    if (args[0] === "buildx" && args[1] === "build") throw new Error("simulated build failure");
    return "";
  }, "/release", release, "alpr-community:test"), /simulated build failure/);
  assert.ok(commands.at(-1).join(" ").includes("buildx rm --force"));
});

test("a built image is removed if its isolated cache cannot be deleted", () => {
  const commands = [];
  assert.throws(() => buildRuntimeImage((command, args) => {
    commands.push([command, ...args]);
    if (args[0] === "buildx" && args[1] === "rm") throw new Error("simulated cache cleanup failure");
    return "";
  }, "/release", release, "alpr-community:test"), /temporary builder alpr-community-build-.*could not be removed/);
  assert.ok(commands.some((entry) => entry.join(" ") === "docker image rm alpr-community:test"));
});
