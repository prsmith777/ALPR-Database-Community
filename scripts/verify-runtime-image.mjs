import { spawnSync } from "node:child_process";

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
