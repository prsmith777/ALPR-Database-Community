import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const image = process.argv[2] || process.env.ALPR_RUNTIME_IMAGE;

if (!image) {
  console.error(
    "Usage: node scripts/verify-runtime-image.mjs <image>\n" +
      "       ALPR_RUNTIME_IMAGE=<image> yarn test:runtime-image"
  );
  process.exit(2);
}

const contract = {
  required: [
    "/app/server.js",
    "/app/package.json",
    "/app/.next/static",
    "/app/public",
    "/app/models/visual-search/vehicle-detection-0202.xml",
    "/app/models/visual-search/vehicle-detection-0202.bin",
    "/app/models/visual-search/vehicle-attributes-recognition-barrier-0039.xml",
    "/app/models/visual-search/vehicle-attributes-recognition-barrier-0039.bin",
    "/app/models/visual-search/vehicle-reid-0001.xml",
    "/app/models/visual-search/vehicle-reid-0001.bin",
  ],
  forbidden: [
    "/app/.git",
    "/app/.github",
    "/app/test",
    "/app/scripts",
    "/app/docs",
    "/app/Dockerfile",
    "/app/docker-compose.yml",
    "/app/docker-compose-dbonly.yml",
    "/app/docker-compose.without-database.yml",
    "/app/schema.sql",
    "/app/migrations.sql",
    "/app/example.json",
    "/app/multi-ai-payload.json",
    "/app/test-payload.json",
    "/app/test-mqtt.js",
  ],
};

const probe = `
  const fs = require("node:fs");
  const contract = ${JSON.stringify(contract)};
  const missing = contract.required.filter((path) => !fs.existsSync(path));
  const forbidden = contract.forbidden.filter((path) => fs.existsSync(path));
  process.stdout.write(JSON.stringify({ missing, forbidden }));
  if (missing.length || forbidden.length) process.exitCode = 1;
`;

const result = spawnSync(
  "docker",
  ["run", "--rm", "--network", "none", "--entrypoint", "node", image, "-e", probe],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
);

if (result.error) {
  console.error(`Unable to inspect ${image}: ${result.error.message}`);
  process.exit(1);
}

if (result.stderr) process.stderr.write(result.stderr);

let inspection;
try {
  inspection = JSON.parse(result.stdout || "{}");
} catch {
  console.error(`Runtime image inspection returned invalid output: ${result.stdout}`);
  process.exit(1);
}

if (result.status !== 0) {
  if (inspection.missing?.length) {
    console.error(`Missing required runtime paths: ${inspection.missing.join(", ")}`);
  }
  if (inspection.forbidden?.length) {
    console.error(`Forbidden development paths: ${inspection.forbidden.join(", ")}`);
  }
  process.exit(result.status || 1);
}

console.log(
  `Runtime image ${image} passed: ${contract.required.length} required paths present, ` +
    `${contract.forbidden.length} development paths absent.`
);

const openvinoProbe = readFileSync(
  new URL("./openvino-runtime-probe.cjs", import.meta.url),
  "utf8"
);
const inference = spawnSync(
  "docker",
  ["run", "--rm", "--network", "none", "--entrypoint", "node", image],
  {
    encoding: "utf8",
    input: openvinoProbe,
    stdio: ["pipe", "pipe", "pipe"],
  }
);

if (inference.error) {
  console.error(`Unable to run OpenVINO validation in ${image}: ${inference.error.message}`);
  process.exit(1);
}
if (inference.stderr) process.stderr.write(inference.stderr);
if (inference.status !== 0) {
  if (inference.stdout) process.stdout.write(inference.stdout);
  process.exit(inference.status || 1);
}

let openvino;
try {
  openvino = JSON.parse(inference.stdout || "{}");
} catch {
  console.error(`OpenVINO validation returned invalid output: ${inference.stdout}`);
  process.exit(1);
}
if (
  openvino.status !== "ok" ||
  openvino.device !== "CPU" ||
  !Array.isArray(openvino.models) ||
  openvino.models.length !== 3 ||
  openvino.models.some((model) => !Number.isInteger(model.outputElements) || model.outputElements < 1)
) {
  console.error(`OpenVINO validation returned an invalid result: ${inference.stdout}`);
  process.exit(1);
}

console.log(
  `OpenVINO CPU inference passed for ${openvino.models.map((model) => model.name).join(", ")}.`
);
