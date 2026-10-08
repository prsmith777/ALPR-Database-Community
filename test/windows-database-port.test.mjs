import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {changeWindowsDatabasePort,assertNoPendingPortChange} from '../scripts/windows-database-port.mjs';
import {validateCommunityUpdateRequest,submitCommunityUpdateRequest,readCommunityUpdateControlSnapshot} from '../lib/community-update-control.mjs';
import {claimWindowsUpdateRequest} from '../scripts/windows-update-service.mjs';
import {performWindowsUpdateRequest} from '../scripts/windows-update-worker.mjs';
const digest='b'.repeat(64);
const request=(extra={})=>({formatVersion:1,id:randomUUID(),createdAt:new Date().toISOString(),operation:'database-port',databasePort:5434,confirmation:'CHANGE DATABASE PORT',...extra});
async function fixture(t,{fail=false,restoreFails=false}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'alpr-db-port-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const privateRoot=path.join(root,'management/updates'),backupRoot=path.join(root,'management/backups');await mkdir(privateRoot,{recursive:true});await mkdir(backupRoot);
 const calls=[];const installation={current:'0.1.55-aaaaaaaaaaaa',environment:{PORT:'3000',DB_HOST:'127.0.0.1:5433',HOSTNAME:'0.0.0.0',DB_PASSWORD:'private-fixture-secret'}};
 const deployment={root,data:root,backupRoot,installation,current:{version:'0.1.55',commit:'a'.repeat(40)},run(command,args){
  assert.equal(path.basename(command),'powershell.exe');assert.equal(args.includes('-File'),true);
  const operation=args[args.indexOf('-Operation')+1];calls.push(operation);
  if(operation==='check')return JSON.stringify({backupSha256:digest});
  if(operation==='verify')return '';
  if(operation==='apply'){installation.environment.DB_HOST='127.0.0.1:5434';if(fail)throw new Error('synthetic database startup failure');}
  if(operation==='restore'){if(restoreFails)throw new Error('synthetic recovery failure');installation.environment.DB_HOST='127.0.0.1:5433';}
  return '';
 },health:async()=>({status:'ok'}),attest:async()=>({listenerOwned:true})};
 return {root,privateRoot,backupRoot,calls,deployment};
}
const invoke=(f,input=request(),extra={})=>changeWindowsDatabasePort(input,{SystemRoot:'C:\\Windows'},{deployment:f.deployment,...extra});
test('Windows database port IPC accepts only bounded integers and strips arbitrary commands',async t=>{
 assert.throws(()=>validateCommunityUpdateRequest(request()),/Unsupported/);
 const clean=validateCommunityUpdateRequest(request({command:'calc',path:'C:\\private',appPort:3001}),{requireIdentity:true,allowWindowsPort:true});
 assert.equal(clean.databasePort,5434);assert.equal(clean.command,undefined);assert.equal(clean.path,undefined);assert.equal(clean.appPort,undefined);
 for(const value of [0,1023,65536,5433.5,'5434','5434;calc',null])assert.throws(()=>validateCommunityUpdateRequest(request({databasePort:value}),{allowWindowsPort:true}));
 assert.throws(()=>validateCommunityUpdateRequest(request({confirmation:'CHANGE APPLICATION PORT'}),{allowWindowsPort:true}),/Type/);
 assert.throws(()=>validateCommunityUpdateRequest(request({target:'v0.1.55'}),{allowWindowsPort:true}),/target release/);
 const f=await fixture(t),control=path.join(f.root,'control');await mkdir(control);
 await assert.rejects(submitCommunityUpdateRequest(request(),{directory:control,requireAgentOnline:false,environment:{ALPR_DEPLOYMENT_PROFILE:'linux-docker'}}),/Unsupported/);
 const submitted=await submitCommunityUpdateRequest(request(),{directory:control,requireAgentOnline:false,environment:{ALPR_DEPLOYMENT_PROFILE:'windows-native'}});
 const claimed=await claimWindowsUpdateRequest({control,privateRoot:f.privateRoot});assert.equal(claimed.request.id,submitted.requestId);assert.equal(claimed.request.databasePort,5434);
 await writeFile(path.join(control,'heartbeat.json'),JSON.stringify({observedAt:new Date().toISOString(),capabilities:['database-port']}));
 await writeFile(path.join(control,'state.json'),JSON.stringify({operation:'database-port',currentDatabasePort:5434,targetDatabasePort:5434,password:'secret'}));
 const snapshot=await readCommunityUpdateControlSnapshot({directory:control});assert.equal(snapshot.agent.databasePort,true);assert.equal(snapshot.state.currentDatabasePort,5434);assert.equal(snapshot.state.password,undefined);
});
test('database port commits after verified restart and preserves app, network and credentials',async t=>{
 const f=await fixture(t),before={...f.deployment.installation.environment,DB_HOST:'127.0.0.1:5434'};
 assert.equal((await invoke(f)).currentDatabasePort,5434);assert.deepEqual(f.calls,['check','apply']);assert.deepEqual(f.deployment.installation.environment,before);
 const journal=JSON.parse(await readFile(path.join(f.privateRoot,'database-port.json'),'utf8'));assert.equal(journal.phase,'committed');assert.equal(journal.backupSha256,digest);assert.doesNotMatch(JSON.stringify(journal),/private-fixture-secret/);
 await assert.rejects(readFile(path.join(f.backupRoot,'maintenance.lock')),{code:'ENOENT'});
});
test('failed database startup restores the original port and records recovery',async t=>{
 const f=await fixture(t,{fail:true});await assert.rejects(invoke(f),/previous PostgreSQL port was restored/);
 assert.deepEqual(f.calls,['check','apply','restore']);assert.equal(f.deployment.installation.environment.DB_HOST,'127.0.0.1:5433');
 assert.equal(JSON.parse(await readFile(path.join(f.privateRoot,'database-port.json'),'utf8')).phase,'restored');
});
test('failed automatic recovery retains a pending journal and blocks other maintenance',async t=>{
 const f=await fixture(t,{fail:true,restoreFails:true});await assert.rejects(invoke(f),/needs administrator recovery/);
 assert.equal(JSON.parse(await readFile(path.join(f.privateRoot,'database-port.json'),'utf8')).phase,'pending');await assert.rejects(assertNoPendingPortChange(f.root),/maintenance recovery/);
});
test('interrupted database port change restores without replaying the request',async t=>{
 const f=await fixture(t),input=request();f.deployment.installation.environment.DB_HOST='127.0.0.1:5434';
 await writeFile(path.join(f.privateRoot,'database-port.json'),JSON.stringify({formatVersion:1,requestId:input.id,current:f.deployment.installation.current,previousPort:5433,port:5434,backupSha256:digest,phase:'pending'}));
 assert.equal((await invoke(f,input,{recover:true})).currentDatabasePort,5433);assert.deepEqual(f.calls,['restore']);
});
test('pending updates, application recovery, shared ports and live maintenance refuse before mutation',async t=>{
 for(const kind of ['update','application','port','lock']){
  const f=await fixture(t);
  if(kind==='update')await writeFile(path.join(f.backupRoot,'updater-state.json'),JSON.stringify({status:'ready-for-acceptance'}));
  if(kind==='application')await writeFile(path.join(f.privateRoot,'application-port.json'),JSON.stringify({phase:'pending'}));
  if(kind==='lock')await writeFile(path.join(f.backupRoot,'maintenance.lock'),String(process.pid));
  await assert.rejects(invoke(f,request({databasePort:kind==='port'?3000:5434})));assert.deepEqual(f.calls,[]);
 }
});
test('invalid recovery records refuse before any service action',async t=>{
 for(const change of [{port:'5434'},{previousPort:5434},{backupSha256:'bad'},{current:'invalid'},{requestId:randomUUID()},{phase:'invalid'}]){
  const f=await fixture(t),input=request();await writeFile(path.join(f.privateRoot,'database-port.json'),JSON.stringify({formatVersion:1,requestId:input.id,current:f.deployment.installation.current,previousPort:5433,port:5434,backupSha256:digest,phase:'pending',...change}));
  await assert.rejects(invoke(f,input,{recover:true}));assert.deepEqual(f.calls,[]);
 }
});
test('recovery before journal creation verifies the old listener without applying a change',async t=>{
 const f=await fixture(t);assert.equal((await invoke(f,request(),{recover:true})).currentDatabasePort,5433);assert.deepEqual(f.calls,[]);
});
test('database port public status retains accepted software update and rollback information',async t=>{
 const f=await fixture(t);const value=await performWindowsUpdateRequest(request(),{}, {deployment:f.deployment,changeDatabasePort:async()=>({currentDatabasePort:5434,message:'Changed'}),runUpdater:async()=>({status:'accepted',current:{tag:'v0.1.55'},backup:{dumpSha256:digest}})});
 assert.equal(value.currentDatabasePort,5434);assert.equal(value.rollbackPresent,true);assert.equal(value.updaterStatus,'accepted');assert.equal(value.message,'Changed');
});


test('recovery after commit verifies the new listener without replay or restoration',async t=>{
 const f=await fixture(t),input=request();await invoke(f,input);f.calls.length=0;
 assert.equal((await invoke(f,input,{recover:true})).currentDatabasePort,5434);assert.deepEqual(f.calls,['verify']);
});
