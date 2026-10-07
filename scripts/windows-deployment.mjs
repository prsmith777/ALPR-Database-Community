import { cp, lstat, readFile, readdir, realpath, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { assertWindowsHost, hashFile, verifyWindowsPackage } from "./windows-native-package.mjs";

export function nativeRunner(command, args, options = {}) {
  const result = spawnSync(command, args, { windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || path.basename(command) + " failed").trim());
  return String(result.stdout || "").trim();
}
export async function atomicJson(file, value) {
  const temporary = file + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  await rename(temporary, file);
}
export async function assertRealDirectory(directory) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Native directories cannot be links or junctions");
  const canonical = await realpath(directory);
  if (path.resolve(canonical).toLowerCase() !== path.resolve(directory).toLowerCase()) throw new Error("Native directory ancestors cannot be junctions");
}
export async function fileInventory(root, prefix = "") {
  if (!prefix) await assertRealDirectory(root);
  const files = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + "/" + entry.name : entry.name;
    const full = path.join(root, ...name.split("/"));
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("Native data cannot contain links or junctions");
    if (info.isDirectory()) Object.assign(files, await fileInventory(root, name));
    else if (info.isFile()) files[name] = await hashFile(full);
    else throw new Error("Unexpected native data file");
  }
  return files;
}
export function assertPreservedFiles(before, after) {
  const lost = Object.keys(before).filter((name) => before[name] !== after[name]);
  if (lost.length) throw new Error("Stored files changed or disappeared: " + lost.length);
}
export async function loadWindowsDeployment(installationFile, options = {}) {
  if (!options.skipHostCheck) assertWindowsHost();
  if (!installationFile || !path.isAbsolute(installationFile)) throw new Error("ALPR_WINDOWS_INSTALLATION must be an absolute path");
  const installation = JSON.parse(await readFile(installationFile, "utf8"));
  if (installation.formatVersion !== 1 || installation.profile !== "windows-native" ||
      !/^\d+\.\d+\.\d+-[0-9a-f]{12}$/.test(installation.current) ||
      ![installation.installRoot, installation.dataRoot, installation.pgBin].every((value) => typeof value === "string" && path.isAbsolute(value))) {
    throw new Error("Invalid native Windows installation");
  }
  const root = installation.installRoot, data = installation.dataRoot;
  await assertRealDirectory(root);
  await assertRealDirectory(data);
  await assertRealDirectory(path.join(data, "management"));
  if (path.resolve(installationFile) !== path.join(root, "installation.json")) throw new Error("Installation file must be inside its recorded install root");
  const releaseRoot = path.join(root, "releases");
  await assertRealDirectory(releaseRoot);
  const currentPath = path.join(releaseRoot, installation.current);
  const current = await verifyWindowsPackage(currentPath, { allowPreview: options.allowPreview });
  const run = options.runner || nativeRunner;
  const databasePort = String(installation.environment.DB_HOST).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!databasePort || !installation.environment.DB_PASSWORD || installation.environment.DB_NAME !== "postgres" ||
      installation.environment.DB_USER !== "postgres") throw new Error("Native maintenance requires the installer-owned loopback database");
  const pgEnvironment = { ...process.env, PGPASSWORD: installation.environment.DB_PASSWORD };
  const pg = (executable, args, opts = {}) => run(path.join(installation.pgBin, executable + ".exe"),
    ["--host", "127.0.0.1", "--port", databasePort, "--username", "postgres", "--dbname", "postgres", ...args],
    { env: pgEnvironment, ...opts });
  const sql = (statement) => pg("psql", ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "-At", "-c", statement]);
  const service = (operation) => run(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "host", "Service-Control.ps1"), "-Operation", operation]);
  return {
    profile: "windows-native", root, data, releaseRoot, installation, installationFile, currentPath, current, pg, sql, service, run,
    async attest() { return JSON.parse(service("attest")); },
    backupRoot: path.join(data, "management", "backups"),
    async counts() {
      for(let attempt=0;;attempt++) {
        try {
          const tables = sql("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;").split(/\r?\n/).filter(Boolean);
          if(tables.some(table=>!/^[a-z_][a-z0-9_]*$/.test(table)))throw new Error("Unexpected public table name");
          if(!tables.length)return {};
          // Count all tables in one statement/snapshot rather than opening a
          // new Windows client process and connection for every table.
          const rows=sql(tables.map(table=>`SELECT '${table}',count(*) FROM public.${table}`).join(" UNION ALL ")+";");
          const counts={};
          for(const row of rows.split(/\r?\n/)) {
            const [table,count,...extra]=row.split("|");
            if(!tables.includes(table) || !/^\d+$/.test(count || "") || extra.length || Object.hasOwn(counts,table))throw new Error("Invalid native database count result");
            counts[table]=count;
          }
          if(Object.keys(counts).length !== tables.length)throw new Error("Native database count inventory differs");
          return counts;
        }catch(error) {
          // Only repeat read-only observations after a transient connection
          // reset. Mutating PostgreSQL operations are never replayed here.
          if(attempt >= 2 || !/server closed the connection|connection to server[\s\S]*failed|could not connect to server/i.test(error.message))throw error;
          await new Promise(resolve=>setTimeout(resolve,250));
        }
      }
    },
    async health() {
      const port = Number(installation.environment.PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid native app port");
      for (let attempt = 0; attempt < (options.healthAttempts || 60); attempt++) {
        try {
          const response = await fetch("http://127.0.0.1:" + port + "/api/health-check", { signal: AbortSignal.timeout(3000) });
          const body = response.ok ? await response.json() : null;
          if (body?.status === "ok") return { status: "ok" };
        } catch { /* wait for the fixed local service */ }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("Native application health check failed");
    },
    async stage(packageRoot) {
      const manifest = await verifyWindowsPackage(packageRoot, { allowPreview: options.allowPreview });
      const name = manifest.version + "-" + manifest.commit.slice(0,12);
      const destination = path.join(releaseRoot, name);
      const manifestHash = await hashFile(path.join(packageRoot, "windows-package.json"));
      const ensureInactive = async () => {
        const selected = JSON.parse(await readFile(installationFile, "utf8"));
        if (selected.current === name) throw new Error("Cannot stage over the active Windows release");
      };
      await assertRealDirectory(releaseRoot);
      await ensureInactive();
      let exists = false;
      try { await lstat(destination); exists = true; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (exists) {
        await assertRealDirectory(destination);
        let verified = false;
        try {
          await verifyWindowsPackage(destination, { allowPreview: options.allowPreview });
          verified = await hashFile(path.join(destination, "windows-package.json")) === manifestHash;
        } catch { /* Preserve an incomplete prior copy after verifying its replacement. */ }
        if (verified) {
          run(path.join(destination, "runtime", "node.exe"), ["openvino-runtime-probe.cjs"], { cwd: path.join(destination, "app") });
          return { manifest, name, path: destination, reused: true };
        }
      }
      // Copy and probe privately before publishing a release directory. A
      // failed copy cannot occupy the name used by the next retry.
      const pending = path.join(releaseRoot, ".staging-" + name + "-" + randomUUID());
      await cp(packageRoot, pending, { recursive: true, force: false, errorOnExist: true });
      await verifyWindowsPackage(pending, { allowPreview: options.allowPreview });
      if (await hashFile(path.join(pending, "windows-package.json")) !== manifestHash) throw new Error("Staged manifest differs from the verified source");
      run(path.join(pending, "runtime", "node.exe"), ["openvino-runtime-probe.cjs"], { cwd: path.join(pending, "app") });
      await ensureInactive();
      let preserved;
      if (exists) {
        await assertRealDirectory(destination);
        preserved = path.join(releaseRoot, ".failed-stage-" + name + "-" + randomUUID());
        // Both exact paths are immediate children of the already verified
        // private releases root. Keep the old files for diagnosis; never delete them.
        if (path.dirname(destination) !== releaseRoot || path.dirname(preserved) !== releaseRoot) throw new Error("Invalid staging preservation path");
        await rename(destination, preserved);
      }
      await rename(pending, destination);
      return { manifest, name, path: destination, preserved };
    },
    async switchRelease(name) {
      if (!/^\d+\.\d+\.\d+-[0-9a-f]{12}$/.test(name)) throw new Error("Invalid native release name");
      await atomicJson(installationFile, { ...installation, current: name });
    },
    migrate(release) { pg("psql", ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--single-transaction", "--file", path.join(release, "migrations.sql")]); },
  };
}
