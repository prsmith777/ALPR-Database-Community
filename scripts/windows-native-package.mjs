import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const WINDOWS_PACKAGE_FORMAT = 1;
export const COMMUNITY_SOURCE = "https://github.com/prsmith777/ALPR-Database-Community";
export const WINDOWS_SERVICES = Object.freeze({
  app: "ALPRCommunityApp",
  database: "ALPRCommunityDatabase",
});

export function assertWindowsHost({ platform = process.platform, arch = process.arch, build } = {}) {
  if (platform !== "win32" || arch !== "x64") throw new Error("Native Windows requires Windows 10 22H2 or Windows 11, x64");
  // 19045 is the explicit Windows 10 baseline. Windows Server/LTSC are not
  // certified by this range check; the installer checks ProductType/DisplayVersion.
  if (build !== undefined && !(Number(build) === 19045 || Number(build) >= 22000)) {
    throw new Error("Windows 10 22H2 (build 19045) or Windows 11 is required");
  }
}

export function safePackagePath(root, name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.startsWith("/") ||
      name.split("/").some((part) => !part || part === "." || part === ".." ||
        /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Unsafe Windows package path");
  }
  return path.join(root, ...name.split("/"));
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function listPackageFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = safePackagePath(root, name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error("Native packages cannot contain links");
    if (stat.isDirectory()) result.push(...await listPackageFiles(root, name));
    else if (stat.isFile()) result.push(name);
    else throw new Error("Native packages can contain only regular files");
  }
  return result.sort();
}

export async function verifyWindowsPackage(root, { allowPreview = false } = {}) {
  const manifest = JSON.parse(await readFile(path.join(root, "windows-package.json"), "utf8"));
  if (manifest.formatVersion !== WINDOWS_PACKAGE_FORMAT || manifest.source !== COMMUNITY_SOURCE ||
      manifest.platform !== "win32" || manifest.arch !== "x64" ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^[0-9a-f]{40}$/.test(manifest.commit) ||
      (!allowPreview && manifest.channel !== "stable") ||
      !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Unsupported or unverified Community Windows package");
  }
  const names = await listPackageFiles(root);
  const expected = Object.keys(manifest.files).sort();
  if (JSON.stringify(names.filter((name) => name !== "windows-package.json")) !== JSON.stringify(expected)) {
    throw new Error("Windows package file inventory does not match its manifest");
  }
  for (const name of expected) {
    const file = safePackagePath(root, name);
    if (!/^[0-9a-f]{64}$/.test(manifest.files[name]) || await hashFile(file) !== manifest.files[name]) {
      throw new Error(`Windows package checksum failed: ${name}`);
    }
  }
  for (const required of ["app/server.js", "runtime/node.exe", "runtime/winsw.exe",
    "host/windows-service.mjs", "host/windows-maintenance.mjs", "schema.sql", "migrations.sql", "Install.ps1"]) {
    if (!manifest.files[required]) throw new Error(`Windows package missing ${required}`);
  }
  const metadata = JSON.parse(await readFile(path.join(root, "app", "package.json"), "utf8"));
  if (metadata.version !== manifest.version) throw new Error("Windows runtime/package version mismatch");
  return manifest;
}
