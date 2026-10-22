import { mkdtemp, mkdir, cp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
const root = path.resolve(import.meta.dirname, "..");
// Compile every production event handler; never launch the resulting installer.
export async function verifyWindowsSetupCompilation({ compiler }) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "alpr-full-compile-"));
  try {
    const payload = path.join(scratch, "payload");
    await mkdir(path.join(payload, "app/public"), { recursive: true });
    await cp(path.join(root, "LICENSE"), path.join(payload, "LICENSE"));
    await cp(path.join(root, "public/license-plate.ico"), path.join(payload, "app/public/license-plate.ico"));
    const result = spawnSync(path.resolve(compiler), ["/Q", "/DPackageRoot=" + payload,
      "/DManifestSha256=" + "0".repeat(64), "/DPackageVersion=0.0.0",
      "/DOutputRoot=" + scratch, "/DOutputName=compile-only",
      path.join(root, "scripts/windows/CommunitySetup.iss")],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error("Full installer compilation failed: " + (result.error?.message || result.stdout + result.stderr));
    return { verified: true, executed: false };
  } finally {
    if (path.dirname(scratch) !== path.resolve(os.tmpdir())) throw new Error("Unexpected compilation fixture path.");
    await rm(scratch, { recursive: true, force: true });
  }
}
