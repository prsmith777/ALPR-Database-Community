import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { nativeRunner } from "./windows-deployment.mjs";
import { assertWindowsHost, verifyWindowsPackage } from "./windows-native-package.mjs";

const [packageArgument, pgArgument] = process.argv.slice(2);
if (!packageArgument || !pgArgument) throw new Error("Usage: node scripts/test-windows-native-runtime.mjs ABSOLUTE_PACKAGE_DIR ABSOLUTE_PG17_BIN");
const packageRoot = path.resolve(packageArgument), pgBin = path.resolve(pgArgument);
assertWindowsHost();
const manifest = await verifyWindowsPackage(packageRoot, { allowPreview: true });
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
  // Use the installed release layout and the actual fixed service launcher,
  // rather than starting Next.js directly and bypassing startup readiness.
  const installRoot = path.join(root,"installation");
  const current = manifest.version + "-" + manifest.commit.slice(0,12);
  const release = path.join(installRoot,"releases",current);
  const application = path.join(release,"app");
  await mkdir(release,{recursive:true});
  await cp(path.join(packageRoot,"app"),application,{recursive:true});
  await cp(path.join(packageRoot,"runtime"),path.join(release,"runtime"),{recursive:true});
  const installationFile = path.join(installRoot,"installation.json");
  await writeFile(installationFile,JSON.stringify({formatVersion:1,profile:"windows-native",installRoot,dataRoot:data,pgBin,current,
    environment:{NODE_ENV:"production",ALPR_DATA_DIR:data,HOSTNAME:"127.0.0.1",PORT:String(appPort),
      DB_HOST:"127.0.0.1:"+dbPort,DB_USER:"postgres",DB_NAME:"postgres",DB_PASSWORD:secret,ADMIN_PASSWORD:secret,
      ALPR_DEPLOYMENT_PROFILE:"windows-native"}}));
  // Treat the build checkout as unavailable even when testing on its own host.
  // Otherwise createRequire(import.meta.url) can silently load build-time files
  // that do not exist on a user's machine.
  const sourceRoot = fileURLToPath(new URL("..",import.meta.url));
  const sourceGuard = path.join(root,"isolated-package.cjs");
  await writeFile(sourceGuard, `const Module=require('node:module');const path=require('node:path');
const source=${JSON.stringify(sourceRoot)},bundle=${JSON.stringify(packageRoot)};
const within=(root,file)=>{const relative=path.relative(root,file);return !relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
const original=Module._resolveFilename;
Module._resolveFilename=function(request,parent,...rest){
  if(parent?.filename&&within(source,parent.filename)&&!within(bundle,parent.filename)){
    const error=new Error('Packaged runtime attempted to load a file from the build checkout: '+request);error.code='MODULE_NOT_FOUND';throw error;
  }
  const resolved=original.call(this,request,parent,...rest);
  if(path.isAbsolute(resolved)&&within(source,resolved)&&!within(bundle,resolved)){
    const error=new Error('Packaged runtime resolved a file outside its bundle: '+request);error.code='MODULE_NOT_FOUND';throw error;
  }
  return resolved;
};`);
  pg("pg_ctl",["-D",database,"-w","-m","fast","stop"]);
  databaseStarted = false;
  let output = "";
  const launch = () => {
    const process = spawn(path.join(packageRoot,"runtime","node.exe"),[path.join(packageRoot,"host","windows-service.mjs"),installationFile],{
      cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe","ipc"],
      // NODE_OPTIONS treats backslashes as escapes inside quotes. Forward
      // slashes preserve Windows paths, including a temporary path with spaces.
      env:{...pgEnv,NODE_OPTIONS:'--require "'+sourceGuard.replaceAll("\\","/")+'"'},
    });
    process.stdout.on("data",(chunk)=>{output+=chunk.toString();});
    process.stderr.on("data",(chunk)=>{output+=chunk.toString();});
    return process;
  };
  const waitForDatabaseMessage = async () => {
    for(let attempt=0;attempt<100;attempt++){
      if(server.exitCode!==null)throw new Error("Service launcher exited while waiting for PostgreSQL\n"+output.replaceAll(secret,"[test credential]"));
      if(output.includes("Waiting for PostgreSQL"))return;
      await new Promise((resolve)=>setTimeout(resolve,50));
    }
    throw new Error("Service launcher did not check PostgreSQL readiness immediately");
  };
  const base = "http://127.0.0.1:" + appPort;
  server=launch();
  await waitForDatabaseMessage();
  await assert.rejects(fetch(base+"/api/health-check",{signal:AbortSignal.timeout(1000)}));
  const stoppedWaiting=once(server,"exit");
  server.send("stop");
  await Promise.race([stoppedWaiting,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Readiness cancellation timed out")),3000))]);
  assert.equal(server.exitCode,0,"Stopping during readiness must exit cleanly");
  assert.ok(!output.includes("PostgreSQL is ready; starting ALPR."),"Canceled readiness must not launch the application");
  output="";
  server=launch();
  await waitForDatabaseMessage();
  await assert.rejects(fetch(base+"/api/health-check",{signal:AbortSignal.timeout(1000)}));
  const databaseReadyAt=performance.now();
  pg("pg_ctl",["-D",database,"-l",path.join(root,"postgres.log"),"-o","-h 127.0.0.1 -p "+dbPort,"-w","start"]);
  databaseStarted=true;
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
  assert.ok(output.includes("PostgreSQL is ready; starting ALPR."),"The real launcher must verify the database before launch");
  console.log("Packaged service launcher passed database-down refusal, shutdown during readiness, and launch after PostgreSQL recovery; health reached in "+Math.round(performance.now()-databaseReadyAt)+" ms after database start.");
  assert.equal((await fetch(base + "/login")).status,200);
  // Initialization creates isolated auth in ALPR_DATA_DIR.
  await fetch(base + "/api/verify-session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:"invalid"})});
  let auth;
  for (let i=0;i<20;i++) {
    try { auth=JSON.parse(await readFile(path.join(data,"auth","auth.json"),"utf8")); break; } catch {}
    await new Promise((resolve) => setTimeout(resolve,250));
  }
  assert.ok(auth?.apiKey,"Native runtime must create authentication outside the release");
  const actions = JSON.parse(await readFile(path.join(application,".next","server","server-reference-manifest.json"),"utf8"));
  const loginId = Object.entries(actions.node).find(([,action]) => action.exportedName === "loginAction")?.[0];
  assert.ok(loginId,"The packaged runtime must include the sign-in action");
  const login = new FormData();
  login.set("$ACTION_ID_" + loginId, "");
  login.set("username", "");
  login.set("password", secret);
  const signedIn = await fetch(base + "/login",{method:"POST",headers:{origin:base},body:login});
  const cookie = signedIn.headers.getSetCookie().find((value) => value.startsWith("session="))?.split(";")[0];
  assert.ok(cookie,"Chosen administrator password must produce a signed-in session");
  const settingsRoutes = [
    "general", "database", "plate-matching", "review-corrections", "security", "release",
    "blue-iris", "home-assistant", "data-privacy", "data-privacy/privacy",
    "data-privacy/cleanup", "data-privacy/monitoring", "vehicle-intelligence", "software-updates",
    "integrations", "integrations/mqtt", "integrations/mqtt/activity", "integrations/mqtt/cameras",
    "integrations/pushover", "integrations/pushover/defaults", "integrations/pushover/test",
    "integrations/pushover/usage", "integrations/email", "integrations/email/sender",
    "integrations/email/test", "integrations/webhook", "integrations/webhook/safety",
    "integrations/webhook/test",
  ];
  for (const section of settingsRoutes) {
    const route = "/settings/" + section;
    const page = await fetch(base + route,{headers:{cookie},redirect:"manual"});
    await page.text();
    if (page.status !== 200) {
      throw new Error("Signed-in " + route + " failed: HTTP " + page.status + "\n" + output.replaceAll(secret,"[test credential]"));
    }
  }
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
  console.log("Native PostgreSQL 17 + standalone Windows runtime passed health, chosen-password sign-in, all " + settingsRoutes.length + " Settings pages without build-checkout access, auth persistence, synthetic ingestion, portable stored image, missing-key refusal, and schema checks.");
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
