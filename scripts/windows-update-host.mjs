import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { assertRealDirectory } from "./windows-deployment.mjs";
import { verifyWindowsPackage, hashFile } from "./windows-native-package.mjs";

export async function refreshWindowsUpdateHost(installationFile) {
  const installation=JSON.parse(await readFile(installationFile,"utf8"));
  const root=path.dirname(installationFile);
  if (installation.installRoot !== root || installation.profile !== "windows-native" || !/^\d+\.\d+\.\d+-[a-f0-9]{12}$/.test(installation.current)) throw new Error("Invalid host refresh identity");
  const selected=path.join(root,"releases",installation.current);
  const manifest=await verifyWindowsPackage(selected,{allowPreview:true});
  await assertRealDirectory(root);
  const backup=path.join(installation.dataRoot,"management","backups",`host-code-${randomUUID()}`);
  await mkdir(backup,{recursive:true}); await assertRealDirectory(backup);
  for (const [name,hash] of Object.entries(manifest.files)) {
    if (!/^host\/[a-zA-Z0-9-]+\.(mjs|ps1)$/.test(name) && !/^lib\/community-update-(control|shape)\.mjs$/.test(name)) continue;
    const destination=path.join(root,...name.split("/"));
    const parent=path.dirname(destination); await mkdir(parent,{recursive:true}); await assertRealDirectory(parent);
    const temporary=destination+`.${randomUUID()}.tmp`;
    try {
      try {
        if (await hashFile(destination) === hash) continue;
        const recovery=path.join(backup,...name.split("/"));
        await mkdir(path.dirname(recovery),{recursive:true}); await cp(destination,recovery,{force:false,errorOnExist:true});
      } catch(error) { if (error.code !== "ENOENT") throw error; }
      await cp(path.join(selected,...name.split("/")),temporary,{force:false,errorOnExist:true});
      if (await hashFile(temporary) !== hash) throw new Error("Host helper checksum differs");
      await rename(temporary,destination);
    } finally { await rm(temporary,{force:true}); }
  }
  return {commit:manifest.commit,recoveryCopy:backup};
}
