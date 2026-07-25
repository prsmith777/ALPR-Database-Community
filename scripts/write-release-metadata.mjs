import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REF_PATTERN = /^refs\/heads\/[a-zA-Z0-9._/-]+$/;

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function shaFromPackedRefs(contents, ref) {
  for (const line of String(contents || "").split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/, 2);
    if (name === ref && SHA_PATTERN.test(sha)) return sha.toLowerCase();
  }
  return null;
}

function channelFromRef(ref) {
  const branch = ref?.slice("refs/heads/".length) || "";
  if (branch === "staging") return "staging";
  if (["main", "master", "production"].includes(branch)) return "production";
  return branch ? "development" : "self-hosted";
}

export async function readGitBuildMetadata(gitDirectory = ".git") {
  const head = String(await readFile(path.join(gitDirectory, "HEAD"), "utf8")).trim();
  if (SHA_PATTERN.test(head)) {
    return { gitSha: head.toLowerCase(), channel: "self-hosted" };
  }

  const ref = head.startsWith("ref: ") ? head.slice(5) : "";
  if (!REF_PATTERN.test(ref) || ref.includes("..")) {
    throw new Error("Git HEAD does not contain a supported branch reference");
  }

  const looseSha = String(
    (await readOptional(path.join(gitDirectory, ...ref.split("/")))) || ""
  ).trim();
  const packedRefs = looseSha ? null : await readOptional(path.join(gitDirectory, "packed-refs"));
  const gitSha = SHA_PATTERN.test(looseSha)
    ? looseSha.toLowerCase()
    : shaFromPackedRefs(packedRefs, ref);

  if (!gitSha) throw new Error(`Unable to resolve ${ref} to an exact commit`);
  return { gitSha, channel: channelFromRef(ref) };
}

export function serializeReleaseMetadata(metadata) {
  return [
    "// Generated during the commit-pinned Docker build; do not edit.",
    `export default Object.freeze(${JSON.stringify(metadata, null, 2)});`,
    "",
  ].join("\n");
}

async function main() {
  const metadata = await readGitBuildMetadata();
  await writeFile(
    "lib/built-release-metadata.mjs",
    serializeReleaseMetadata(metadata),
    { encoding: "utf8", mode: 0o644 }
  );
  process.stdout.write(`Embedded release ${metadata.gitSha} (${metadata.channel})\n`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}
