import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const POSTGRES_CLIENT_IMAGE = "postgres:17.10";
// An inherited string environment variable must never redirect a protected
// native backup. Only the source exporter can attach this in-process capability.
export const DOCKER_POSTGRES_CONTEXT = Symbol("Docker migration source");
export function dockerCommand() {
  const desktop = path.join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "resources", "bin", "docker.exe");
  return process.platform === "win32" && existsSync(desktop) ? desktop : "docker";
}
export function docker(args, { environment = process.env, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(dockerCommand(), args, { env: environment, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Docker operation timed out. Keep the source and backup files.")); }, timeout);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", () => { clearTimeout(timer); reject(new Error("Docker is unavailable. Start Docker Desktop in Linux-container mode and run the tool as the account that uses Docker.")); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error("Docker operation failed (" + String(args[0]) + "). Check Docker is running and the selected source is available.", { cause: { code, stderr } }));
    });
  });
}
// Used only by the export path. No source volume or Docker socket is mounted.
export function dockerPostgresArguments(program, args, env) {
  const tool = path.basename(program).replace(/\.exe$/i, "");
  const source = env.ALPR_MIGRATION_DOCKER_SOURCE;
  const scratch = env.ALPR_MIGRATION_DOCKER_SCRATCH;
  if (!/^[a-f0-9]{64}$/.test(source || "") || !path.isAbsolute(scratch || "") || /[,\r\n]/.test(scratch)) throw new Error("Invalid Docker export context.");
  if (!["psql", "pg_dump", "pg_restore"].includes(tool)) throw new Error("Unsupported Docker export tool.");
  const mapped = [...args];
  const file = mapped.indexOf("--file");
  if (file >= 0) {
    if (tool !== "pg_dump" || mapped[file + 1] !== path.join(scratch, "postgres.dump")) throw new Error("Docker export refuses an unexpected file destination.");
    mapped[file + 1] = "/export/postgres.dump";
  }
  if (tool === "pg_restore" && (mapped.length !== 1 || mapped[0] !== "--version")) throw new Error("Docker export cannot restore a database.");
  if (tool === "psql" && !mapped.includes("--version") && !mapped.includes("--command")) throw new Error("Docker export accepts read-only source queries only.");
  return ["run", "--rm", "--name", "alpr-export-client-" + randomUUID(),
    "--label", "org.alpr.migration-client=true", "--network", "container:" + source,
    ...(process.platform === "linux" ? ["--user", String(process.getuid()) + ":" + String(process.getgid())] : []),
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--mount", "type=bind,src=" + scratch + ",dst=/export",
    "--env", "PGPASSWORD", "--env", "PGSSLMODE", "--env", "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=120000",
    "--env", "PGCONNECT_TIMEOUT=10", "--entrypoint", tool, POSTGRES_CLIENT_IMAGE, ...mapped];
}
export async function dockerPostgres(program, args, environment) {
  const command = dockerPostgresArguments(program, args, environment);
  try {
    return await docker(command, { environment, timeout: 30 * 60_000 });
  } finally {
    // The generated name is owned by this invocation, including timeout cases.
    await docker(["rm", "--force", command[command.indexOf("--name") + 1]]).catch(() => {});
  }
}
