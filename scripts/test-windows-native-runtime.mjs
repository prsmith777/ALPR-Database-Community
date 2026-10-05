import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { nativeRunner } from "./windows-deployment.mjs";
import { assertWindowsHost, verifyWindowsPackage } from "./windows-native-package.mjs";

const [packageArgument, pgArgument] = process.argv.slice(2);
if (!packageArgument || !pgArgument) throw new Error("Usage: node scripts/test-windows-native-runtime.mjs ABSOLUTE_PACKAGE_DIR ABSOLUTE_PG17_BIN");
const packageRoot = path.resolve(packageArgument), pgBin = path.resolve(pgArgument);
assertWindowsHost();
await verifyWindowsPackage(packageRoot, { allowPreview: true });
assert.match(nativeRunner(path.join(pgBin,"psql.exe"),["--version"]),/PostgreSQL\) 17\./);
async function freePort() {
  const server = net.createServer();
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const port = server.address().port;
  await new Promise((resolve,reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
const root = await mkdtemp(path.join(os.tmpdir(),"alpr-windows-runtime-"));
const database = path.join(root,"postgres"), data = path.join(root,"data");
const dbPort = await freePort(), appPort = await freePort();
const secret = randomBytes(32).toString("hex");
const pgEnv = { ...process.env, PGPASSWORD:secret };
const pg = (name,args) => nativeRunner(path.join(pgBin,name + ".exe"),args,{env:pgEnv,...(name === "pg_ctl" ? {stdio:"ignore"} : {})});
const sql = (query) => pg("psql",["-X","-h","127.0.0.1","-p",String(dbPort),"-U","postgres","-d","postgres","-At","--set","ON_ERROR_STOP=1","-c",query]);
let server, databaseStarted = false;
try {
  await mkdir(data);
  await writeFile(path.join(root,"password.tmp"),secret);
  pg("initdb",["-D",database,"-U","postgres","--encoding=UTF8","--auth=scram-sha-256","--pwfile=" + path.join(root,"password.tmp")]);
  pg("pg_ctl",["-D",database,"-l",path.join(root,"postgres.log"),"-o","-h 127.0.0.1 -p " + dbPort,"-w","start"]);
  databaseStarted = true;
  for (const name of ["schema.sql","migrations.sql"]) {
    pg("psql",["-X","-h","127.0.0.1","-p",String(dbPort),"-U","postgres","-d","postgres","--set","ON_ERROR_STOP=1","--single-transaction","--file",path.join(packageRoot,name)]);
  }
  const application = path.join(packageRoot,"app");
  const entry = "import {pathToFileURL} from 'node:url';import path from 'node:path';await import(pathToFileURL(path.join(process.cwd(),'server.js')));process.on('message',()=>process.emit('SIGINT'));";
  server = spawn(path.join(packageRoot,"runtime","node.exe"),["--input-type=module","-e",entry],{
    cwd:application, windowsHide:true, stdio:["ignore","pipe","pipe","ipc"],
    env:{...process.env,NODE_ENV:"production",ALPR_DATA_DIR:data,HOSTNAME:"127.0.0.1",PORT:String(appPort),
      DB_HOST:"127.0.0.1:" + dbPort,DB_USER:"postgres",DB_NAME:"postgres",DB_PASSWORD:secret,ADMIN_PASSWORD:secret,
      VEHICLE_REID_MODEL_DIR:path.join(application,"models","visual-search"),ALPR_DEPLOYMENT_PROFILE:"windows-native"},
  });
  let output = "";
  server.stdout.on("data",(chunk) => { output += chunk.toString(); });
  server.stderr.on("data",(chunk) => { output += chunk.toString(); });
  const base = "http://127.0.0.1:" + appPort;
  let healthy = false;
  for (let i=0;i<60;i++) {
    if (server.exitCode !== null) throw new Error("Standalone runtime exited during startup");
    try {
      const response = await fetch(base + "/api/health-check",{signal:AbortSignal.timeout(3000)});
      if (response.ok && (await response.json()).status === "ok") { healthy=true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve,1000));
  }
  if (!healthy) throw new Error("Native runtime did not become healthy");
  assert.equal((await fetch(base + "/login")).status,200);
  // Initialization creates isolated auth in ALPR_DATA_DIR.
  await fetch(base + "/api/verify-session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:"invalid"})});
  let auth;
  for (let i=0;i<20;i++) {
    try { auth=JSON.parse(await readFile(path.join(data,"auth","auth.json"),"utf8")); break; } catch {}
    await new Promise((resolve) => setTimeout(resolve,250));
  }
  assert.ok(auth?.apiKey,"Native runtime must create authentication outside the release");
  const { default:sharp } = await import("sharp");
  const image = await sharp({create:{width:320,height:240,channels:3,background:{r:40,g:80,b:120}}}).jpeg().toBuffer();
  const response = await fetch(base + "/api/plate-reads",{
    method:"POST",headers:{"content-type":"application/json","x-api-key":auth.apiKey},
    body:JSON.stringify({plate_number:"TST000101",camera:"Synthetic Windows",timestamp:new Date().toISOString(),Image:image.toString("base64")}),
  });
  if (!response.ok) throw new Error("Synthetic native ingest failed: HTTP " + response.status);
  assert.equal(sql("SELECT count(*) FROM public.plate_reads WHERE plate_number = 'TST000101';"),"1");
  const stored = sql("SELECT image_path FROM public.plate_reads WHERE plate_number = 'TST000101';");
  assert.ok(stored.startsWith("images/") && !stored.includes("\\"),"Native image references must be portable");
  await readFile(path.join(data,"storage",...stored.split("/")));
  assert.equal((await fetch(base + "/api/plate-reads",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,401);
  assert.equal(sql("SELECT count(*) FROM public.schema_migrations WHERE version = '2026092701_native_reid';"),"1");
  assert.ok(!output.includes(secret),"Runtime logs must not expose test credentials");
  console.log("Native PostgreSQL 17 + standalone Windows runtime passed health, login page, auth persistence, synthetic ingestion, portable stored image, missing-key refusal, and schema checks.");
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server,"exit");
    server.send("stop");
    await Promise.race([exited,new Promise((resolve) => setTimeout(resolve,15_000))]);
    if (server.exitCode === null) { server.kill(); await exited; }
  }
  if (databaseStarted) pg("pg_ctl",["-D",database,"-w","-m","fast","stop"]);
  // This directory was created by mkdtemp for this test, never an installation.
  await rm(root,{recursive:true,force:true});
}
