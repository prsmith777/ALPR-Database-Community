import { createHash } from "node:crypto";
import { open, mkdir } from "node:fs/promises";
import path from "node:path";
import { COMMUNITY_SOURCE, hashFile, verifyWindowsPackage } from "./windows-native-package.mjs";
import { windowsMaintenanceInternals } from "./windows-maintenance.mjs";

const API = "https://api.github.com/repos/prsmith777/ALPR-Database-Community";
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const WINDOWS_UPDATE_PROTOCOL = 1;
export function windowsUpdateAssetNames(tag) {
  if (!TAG.test(tag)) throw new Error("An exact stable Community tag is required");
  const prefix = `ALPR-Community-${tag.slice(1)}-Windows-x64-Update`;
  return { archive: `${prefix}.zip`, metadata: `${prefix}.json` };
}
function allowedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname)) {
    throw new Error("Update download left the trusted GitHub hosts");
  }
  return url;
}
async function responseFor(url, options = {}) {
  const signal=AbortSignal.timeout(options.timeoutMs || 30_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    url = allowedUrl(url);
    const response = await (options.fetch || fetch)(url.href, { redirect: "manual", signal,
      headers: { "User-Agent": "ALPR-Community-Windows-Updater", Accept: url.hostname === "api.github.com" ? "application/vnd.github+json" : "application/octet-stream" } });
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Update download redirect is missing its destination");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Community update download failed (HTTP ${response.status}). Check the internet connection and try again.`); }
    return response;
  }
  throw new Error("Too many update download redirects");
}
async function transfer(response, maximumBytes, onChunk) {
  if (!response.body || Number(response.headers.get("content-length") || 0) > maximumBytes) {
    await response.body?.cancel(); throw new Error("Update download exceeds its size limit");
  }
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maximumBytes) throw new Error("Update download exceeds its size limit");
    await onChunk(chunk, total);
  }
  return total;
}
async function jsonFrom(url, options = {}, asset = null) {
  const chunks = [], hash = createHash("sha256");
  const size = await transfer(await responseFor(url, options), asset ? 128 * 1024 : 2 * 1024 * 1024, (chunk) => { chunks.push(chunk); hash.update(chunk); });
  if (asset && (size !== asset.size || hash.digest("hex") !== asset.sha256)) throw new Error("Update metadata checksum mismatch");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function assetFrom(release, name) {
  const assets = release.assets?.filter((asset) => asset.name === name);
  const asset = assets?.[0];
  const expectedUrl = `${COMMUNITY_SOURCE}/releases/download/${release.tag_name}/${name}`;
  if (assets?.length !== 1 || asset.state !== "uploaded" || asset.browser_download_url !== expectedUrl ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) {
    throw new Error("This release does not have a verified Windows UI update package");
  }
  return { name, url: expectedUrl, size: asset.size, sha256: asset.digest.slice(7) };
}
export async function findWindowsUpdate(current, target = null, options = {}) {
  if (target && !TAG.test(target)) throw new Error("An exact stable Community tag is required");
  const release = await jsonFrom(`${API}/releases/${target ? `tags/${target}` : "latest"}`, options);
  if (release.draft !== false || release.prerelease !== false || !TAG.test(release.tag_name || "") ||
      (target && release.tag_name !== target) || release.html_url !== `${COMMUNITY_SOURCE}/releases/tag/${release.tag_name}`) {
    throw new Error("Only published stable Community releases can be installed");
  }
  if (windowsMaintenanceInternals.compareVersions(release.tag_name, current.tag) <= 0) return null;
  const names = windowsUpdateAssetNames(release.tag_name);
  const archive = assetFrom(release, names.archive), metadataAsset = assetFrom(release, names.metadata);
  if (archive.size > 2 * 1024 ** 3 || metadataAsset.size > 128 * 1024) throw new Error("Windows update assets exceed their size limits");
  const metadata = await jsonFrom(metadataAsset.url, options, metadataAsset);
  if (metadata.formatVersion !== 1 || metadata.updaterProtocol !== WINDOWS_UPDATE_PROTOCOL || metadata.source !== COMMUNITY_SOURCE ||
      metadata.tag !== release.tag_name || metadata.channel !== "stable" || !/^[a-f0-9]{40}$/.test(metadata.commit || "") ||
      !/^[a-f0-9]{64}$/.test(metadata.manifestSha256 || "") || metadata.archive?.name !== archive.name ||
      metadata.archive.sha256 !== archive.sha256 || metadata.archive.sizeBytes !== archive.size) {
    throw new Error("Windows update metadata does not match the published assets");
  }
  let ref = await jsonFrom(`${API}/git/ref/tags/${release.tag_name}`, options);
  if (ref.ref !== `refs/tags/${release.tag_name}`) throw new Error("Release tag reference differs");
  for (let depth = 0; ref.object?.type === "tag" && depth < 5; depth++) {
    if (!/^[a-f0-9]{40}$/.test(ref.object.sha || "")) throw new Error("Invalid annotated release tag");
    ref = await jsonFrom(`${API}/git/tags/${ref.object.sha}`, options);
  }
  if (ref.object?.type !== "commit" || ref.object.sha !== metadata.commit) throw new Error("Windows update source differs from the stable tag");
  return { tag: metadata.tag, commit: metadata.commit, manifestSha256: metadata.manifestSha256, archive };
}
export async function downloadWindowsUpdate(candidate, destination, options = {}) {
  // destination is generated by the privileged worker inside its private cache.
  await mkdir(destination);
  const archivePath = path.join(destination,"update.zip"), handle = await open(archivePath,"wx");
  let lastPercent = -1;
  try {
    const size = await transfer(await responseFor(candidate.archive.url, {...options,timeoutMs:15 * 60_000}), candidate.archive.size, async (chunk, total) => {
      await handle.writeFile(chunk);
      const percent = Math.floor(100 * total / candidate.archive.size);
      if (percent !== lastPercent) { lastPercent = percent; options.progress?.(`Downloading Windows update: ${percent}%`); }
    });
    if (size !== candidate.archive.size) throw new Error("Windows update download is incomplete");
  } finally { await handle.close(); }
  if (await hashFile(archivePath) !== candidate.archive.sha256) throw new Error("Windows update archive checksum mismatch");
  const packageRoot = path.join(destination,"package");
  await options.extract(archivePath, packageRoot);
  if (await hashFile(path.join(packageRoot,"windows-package.json")) !== candidate.manifestSha256) throw new Error("Windows update manifest checksum mismatch");
  const manifest = await verifyWindowsPackage(packageRoot);
  if (manifest.commit !== candidate.commit || `v${manifest.version}` !== candidate.tag) throw new Error("Windows update package identity differs");
  return packageRoot;
}
export const windowsUpdateReleaseInternals = Object.freeze({ allowedUrl, responseFor, transfer, jsonFrom, assetFrom });
