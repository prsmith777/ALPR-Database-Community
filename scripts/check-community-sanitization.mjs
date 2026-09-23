import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const ignoredDirectories = new Set([".git", ".next", "coverage", "node_modules"]);
const textExtensions = new Set([
  "",
  ".css",
  ".env",
  ".example",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const joined = (...parts) => parts.join("");
const forbiddenText = [
  {
    name: "private IPv4 literal",
    pattern: /(?:^|[^0-9])(?:10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3})(?:$|[^0-9])/m,
  },
  {
    name: "private repository identity",
    pattern: new RegExp(joined("ALPR-Database-", "Personal"), "i"),
  },
  {
    name: "unresolved GitHub owner placeholder",
    pattern: new RegExp(joined("YOUR_GITHUB_", "USERNAME"), "i"),
  },
  {
    name: "unresolved clone owner placeholder",
    pattern: new RegExp(joined("github.com/", "<owner>"), "i"),
  },
  { name: "fixed Entry camera", pattern: new RegExp(joined("Entry", " LPR"), "i") },
  { name: "fixed Entry overview", pattern: new RegExp(joined("Entry", " Overview"), "i") },
  { name: "fixed Blue Iris camera", pattern: new RegExp(joined("Cam", "143"), "i") },
  { name: "installation-specific radar", pattern: new RegExp(joined("OPS", "9243"), "i") },
  { name: "installation-specific Compose time-zone default", pattern: /TZ:\s*"\$\{TZ:-America\// },
  { name: "private key material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "GitHub token", pattern: /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/ },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]+/ },
  { name: "OpenAI project key", pattern: /sk-proj-[A-Za-z0-9_-]+/ },
];

const forbiddenPaths = new Set([
  "auth/auth.json",
  "app/api/vehicle-overview-candidates/route.js",
  "config/settings.yaml",
  "components/VehicleReidV2ProfileCandidateControls.jsx",
  "components/VehicleReidV2ReviewCampaignControls.jsx",
  "components/icons/tpms.jsx",
  "components/settings/VehicleAssetAttributePanel.jsx",
  "components/settings/VehicleAssetEmbeddingPanel.jsx",
  "components/settings/VehicleEventShadowPanel.jsx",
  "components/settings/VehicleImageAssetCatalogPanel.jsx",
  "components/settings/VehicleImageCropPanel.jsx",
  "components/settings/VehicleReidV2ConversionPanel.jsx",
  "docs/personal-deployment.md",
  "lib/agentchat-utils.ts",
  "lib/agentchat.ts",
  "lib/chat-route.mjs",
  "lib/host-storage-snapshot-writer.mjs",
  "public/test-plate.jpg",
  "public/tpms.svg",
]);

const forbiddenTopLevelDirectories = new Set(["Images", "storage", "storage2"]);
const forbiddenExtensions = new Set([".backup", ".dump", ".pgdump"]);
const forbiddenPathPrefixes = [
  "app/api/chat/",
  "app/settings/integrations/radar/",
  "app/settings/vehicle-intelligence/calibration/",
  "app/settings/vehicle-intelligence/processing/",
  "app/settings/vehicle-intelligence/vehicle-views/",
  "app/tpms/",
  "app/traffic/",
  "app/visual_search/reid-v2/",
  "app/visual_search/review/",
  "components/chat/",
  "lib/host-maintenance",
  "lib/radar/",
  "lib/traffic/",
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

const failures = [];
const files = await walk(root);

for (const fullPath of files) {
  // The checker intentionally describes forbidden terms, so scanning itself
  // would create false positives.
  if (fullPath === scriptPath) continue;
  const relativePath = relative(root, fullPath).replaceAll("\\", "/");
  const pathParts = relativePath.split("/");
  const extension = extname(relativePath).toLowerCase();

  if (forbiddenPaths.has(relativePath)) failures.push({ relativePath, rule: "forbidden runtime or audited-sensitive path" });
  if (forbiddenPathPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
    failures.push({ relativePath, rule: "private-only feature path" });
  }
  if (forbiddenTopLevelDirectories.has(pathParts[0])) failures.push({ relativePath, rule: "forbidden runtime or audited-sensitive directory" });
  if (forbiddenExtensions.has(extension) || relativePath.toLowerCase().endsWith(".sql.gz")) {
    failures.push({ relativePath, rule: "database backup artifact" });
  }

  if (!textExtensions.has(extension)) continue;
  const content = await readFile(fullPath, "utf8");
  for (const rule of forbiddenText) {
    if (rule.pattern.test(content)) failures.push({ relativePath, rule: rule.name });
  }
}

if (failures.length > 0) {
  failures.sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.rule.localeCompare(right.rule));
  console.error(`Community sanitation check failed with ${failures.length} finding(s):`);
  for (const failure of failures) console.error(`- ${failure.relativePath}: ${failure.rule}`);
  process.exitCode = 1;
} else {
  console.log(`Community sanitation check passed for ${files.length} files.`);
}
