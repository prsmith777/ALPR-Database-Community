import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { submitCommunityUpdateRequest, readCommunityUpdateControlSnapshot } from "../lib/community-update-control.mjs";
import { claimWindowsUpdateRequest, windowsUpdateServiceInternals } from "../scripts/windows-update-service.mjs";
import { windowsUpdateSummary, performWindowsUpdateRequest } from "../scripts/windows-update-worker.mjs";
import { findWindowsUpdate, windowsUpdateAssetNames, windowsUpdateReleaseInternals } from "../scripts/windows-update-release.mjs";

async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),"alpr-ui-updates-"));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const control=path.join(root,"control"),privateRoot=path.join(root,"private");
 await mkdir(control);await mkdir(privateRoot);
 return {root,control,privateRoot};
}
const request=(extra={})=>({formatVersion:1,id:randomUUID(),createdAt:new Date().toISOString(),operation:"check",...extra});
function releaseFixture() {
 const source="https://github.com/prsmith777/ALPR-Database-Community",tag="v0.1.48",commit="c".repeat(40), names=windowsUpdateAssetNames(tag);
 const archive={name:names.archive,sha256:"a".repeat(64),sizeBytes:123};
 const metadata={formatVersion:1,updaterProtocol:1,source,channel:"stable",tag,commit,manifestSha256:"b".repeat(64),archive};
 const bytes=JSON.stringify(metadata);
 const assets=[{name:names.archive,digest:`sha256:${archive.sha256}`,size:123},{name:names.metadata,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,size:Buffer.byteLength(bytes)}]
   .map(a=>({...a,state:"uploaded",browser_download_url:`${source}/releases/download/${tag}/${a.name}`}));
 const release={tag_name:tag,html_url:`${source}/releases/tag/${tag}`,draft:false,prerelease:false,assets};
 let tagCommit=commit;
 const fetch=async url=> {
   if(url.endsWith("/releases/latest") || url.endsWith(`/releases/tags/${tag}`))return Response.json(release);
   if(url.endsWith(names.metadata))return new Response(bytes);
   if(url.endsWith(`/git/ref/tags/${tag}`))return Response.json({ref:`refs/tags/${tag}`,object:{type:"commit",sha:tagCommit}});
   throw new Error("Unexpected URL: "+url);
 };
 return {release,metadata,fetch,setCommit:value=>{tagCommit=value;}};
}
test("Windows browser check enters the same fixed request protocol and a private worker claim",async t=>{
 const f=await fixture(t);
 await writeFile(path.join(f.control,"heartbeat.json"),JSON.stringify({observedAt:new Date().toISOString()}));
 const submitted=await submitCommunityUpdateRequest({operation:"check"},{directory:f.control,environment:{ALPR_DEPLOYMENT_PROFILE:"windows-native"}});
 const claim=await claimWindowsUpdateRequest({control:f.control,privateRoot:f.privateRoot});
 assert.equal(claim.request.id,submitted.requestId);
 assert.equal(claim.request.operation,"check");
 assert.equal(path.dirname(claim.requestFile),f.privateRoot);
 assert.equal(await claimWindowsUpdateRequest({control:f.control,privateRoot:f.privateRoot}),null);
 await writeFile(path.join(f.control,"request.json"),await readFile(claim.requestFile));
 await assert.rejects(claimWindowsUpdateRequest({control:f.control,privateRoot:f.privateRoot}),/EEXIST/);
});
test("Windows worker claim refuses expired, linked, oversized and arbitrary commands",async t=>{
 const f=await fixture(t),queued=path.join(f.control,"request.json");
 for(const input of [request({operation:"shell",command:"calc"}),request({createdAt:"2000-01-01T00:00:00Z"}),request({operation:"update",target:"main",confirmation:"yes"})]){
   await writeFile(queued,JSON.stringify(input));
   await assert.rejects(claimWindowsUpdateRequest({control:f.control,privateRoot:f.privateRoot}));
 }
 await writeFile(queued," ".repeat(65537));await assert.rejects(claimWindowsUpdateRequest({control:f.control,privateRoot:f.privateRoot}),/Invalid|large/);
 await rm(queued);const original=path.join(f.root,"original.json");await writeFile(original,JSON.stringify(request()));
 await link(original,queued);await assert.rejects(claimWindowsUpdateRequest({control:f.control,privateRoot:f.privateRoot}),/Invalid/);
 await rm(queued);await symlink(f.privateRoot,queued,process.platform === "win32"?"junction":"dir");
 await assert.rejects(claimWindowsUpdateRequest({control:f.control,privateRoot:f.privateRoot}));
});
test("only newer stable Community assets pinned to the tag and GitHub digests are accepted",async()=>{
 const f=releaseFixture(),current={tag:"v0.1.47"};
 const result=await findWindowsUpdate(current,null,{fetch:f.fetch});
 assert.equal(result.tag,"v0.1.48");assert.equal(result.commit,"c".repeat(40));
 assert.equal(await findWindowsUpdate({tag:"v0.1.48"},null,{fetch:f.fetch}),null);
 for(const change of [()=>{f.release.prerelease=true;},()=>{f.release.assets[0].digest=null;},()=>{f.release.assets[0].browser_download_url="https://attacker.invalid/update.zip";},()=>{f.setCommit("d".repeat(40));}]){
   const saved=structuredClone(f.release);change();
   await assert.rejects(findWindowsUpdate(current,null,{fetch:f.fetch}));
   Object.assign(f.release,saved);f.setCommit("c".repeat(40));
 }
});
test("privileged downloads refuse HTTP, credentials, foreign redirects and excess bytes",async()=>{
 for(const value of ["http://github.com/test","https://user@github.com/test","https://github.com:8443/test","https://example.com/file"]){assert.throws(()=>windowsUpdateReleaseInternals.allowedUrl(value));}
 await assert.rejects(windowsUpdateReleaseInternals.responseFor("https://github.com/test",{fetch:async()=>new Response(null,{status:302,headers:{location:"http://127.0.0.1:3000/private"}})}),/trusted/);
 await assert.rejects(windowsUpdateReleaseInternals.transfer(new Response("too much data"),3,()=>{}),/size limit/);
});
test("Windows check publishes only safe release and recovery state",async()=>{
 const state={status:"accepted",backup:{id:"1234567890123-aaaaaaaaaaaa",dumpSha256:"secret-hash",privateFiles:{auth:{password:"secret"}}},target:{tag:"v0.1.47"},acceptance:{cleanupEligibleAt:"2026-10-20T00:00:00Z"}};
 const result=await performWindowsUpdateRequest(request(),{}, {
   deployment:{current:{version:"0.1.47",commit:"a".repeat(40)}},findRelease:async()=>({tag:"v0.1.48"}),runUpdater:async()=>state,
 });
 assert.equal(result.targetTag,"v0.1.48");assert.equal(result.rollbackPresent,true);
 assert.doesNotMatch(JSON.stringify(result),/secret|privateFiles/);
 const cleaned=windowsUpdateSummary("cleanup",{...state,backup:{...state.backup,cleanedAt:"now"}});
 assert.equal(cleaned.rollbackPresent,false);
});
test("app snapshot strips private updater state and uses the Windows heartbeat",async t=>{
 const f=await fixture(t);
 await windowsUpdateServiceInternals.publication(f.control,"heartbeat.json",{observedAt:new Date().toISOString()});
 await windowsUpdateServiceInternals.publication(f.control,"state.json",{phase:"succeeded",operation:"check",targetTag:"v0.1.48",privateSecret:"never expose"});
 const snapshot=await readCommunityUpdateControlSnapshot({directory:f.control,environment:{ALPR_DEPLOYMENT_PROFILE:"windows-native"}});
 assert.equal(snapshot.agent.online,true);assert.equal(snapshot.state.targetTag,"v0.1.48");assert.doesNotMatch(JSON.stringify(snapshot),/never expose/);
});
