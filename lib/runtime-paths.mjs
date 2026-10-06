import path from "node:path";

// Release files can be replaced independently of installation data. Existing
// Docker/source deployments retain their working-directory defaults.
export function runtimeDataPath(...segments) {
  const configured = process.env.ALPR_DATA_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("ALPR_DATA_DIR must be an absolute path");
  }
  return path.join(configured || process.cwd(), ...segments);
}
