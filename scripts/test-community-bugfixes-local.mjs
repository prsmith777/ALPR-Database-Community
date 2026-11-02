import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { exerciseCommunityBugfixes } from "./test-community-bugfixes-postgres.mjs";

const bin = path.resolve(process.argv[2] || "invalid");
const root = await mkdtemp(path.join(os.tmpdir(),"alpr-community-bugfix-"));
assert.equal(path.dirname(root),os.tmpdir());
const data = path.join(root,"postgres");
const secret = randomBytes(32).toString("hex");
const executable = name => path.join(bin,name + (process.platform === "win32" ? ".exe" : ""));
function run(name,args,options={}) {
  const result=spawnSync(executable(name),args,{encoding:"utf8",windowsHide:true,...options});
  if(result.status!==0)throw new Error(`${name} failed: ${result.stderr || result.error || ""}`);
}
const listener=net.createServer();listener.listen(0,"127.0.0.1");await once(listener,"listening");
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
let started=false;
try {
  await writeFile(path.join(root,"password"),secret,{mode:0o600});
  run("initdb",["-D",data,"-U","postgres","--encoding=UTF8","--locale=C","--auth=scram-sha-256","--pwfile="+path.join(root,"password")]);
  run("pg_ctl",["-D",data,"-l",path.join(root,"postgres.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"],{stdio:"ignore"});
  started=true;
  let browserTest;
  if (process.argv.includes("--browser")) browserTest=(await import("./test-community-browser.mjs")).exerciseBrowser;
  await exerciseCommunityBugfixes({host:"127.0.0.1",port,user:"postgres",password:secret},{browserTest});
} finally {
  if(started)run("pg_ctl",["-D",data,"-w","-m","fast","stop"],{stdio:"ignore"});
  assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith("alpr-community-bugfix-"));
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:300});
}
