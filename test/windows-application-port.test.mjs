import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {changeWindowsApplicationPort} from '../scripts/windows-application-port.mjs';
import {validateCommunityUpdateRequest,submitCommunityUpdateRequest} from '../lib/community-update-control.mjs';
import {claimWindowsUpdateRequest} from '../scripts/windows-update-service.mjs';

const request=(extra={})=>({formatVersion:1,id:randomUUID(),createdAt:new Date().toISOString(),operation:'app-port',appPort:3001,confirmation:'CHANGE APPLICATION PORT',...extra});
async function fixture(t,fail=false){
 const root=await mkdtemp(path.join(os.tmpdir(),'alpr-port-control-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const privateRoot=path.join(root,'management/updates'),backupRoot=path.join(root,'management/backups');await mkdir(privateRoot,{recursive:true});await mkdir(backupRoot);
 const calls=[];const installation={current:'0.1.54-aaaaaaaaaaaa',environment:{PORT:'3000',DB_HOST:'127.0.0.1:5433',HOSTNAME:'0.0.0.0',DB_PASSWORD:'private-fixture-secret'}};
 const deployment={root,data:root,backupRoot,installation,run(command,args){
  assert.equal(path.basename(command),'powershell.exe');assert.equal(args.includes('-File'),true);assert.equal(args.includes('3001'),true);
  const operation=args[args.indexOf('-Operation')+1];calls.push(operation);
  if(operation==='check')return JSON.stringify({rulePresent:true,ruleEnabled:true});
  if(operation==='apply'&&fail)throw new Error('synthetic startup failure');
  installation.environment.PORT=operation==='apply'?'3001':'3000';return '';
 },health:async()=>({status:'ok'}),attest:async()=>({listenerOwned:true})};
 return {root,privateRoot,backupRoot,calls,deployment};
}
test('only the Windows control protocol accepts bounded application ports',async t=>{
 const input=request();assert.throws(()=>validateCommunityUpdateRequest(input),/Unsupported/);
 const validated=validateCommunityUpdateRequest({...input,command:'calc',path:'C:\\private'},{requireIdentity:true,allowWindowsPort:true});
 assert.equal(validated.appPort,3001);assert.equal(validated.command,undefined);assert.equal(validated.path,undefined);
 for(const value of [0,1023,65536,3000.5,'3001','3001;calc',null])assert.throws(()=>validateCommunityUpdateRequest(request({appPort:value}),{allowWindowsPort:true}));
 assert.throws(()=>validateCommunityUpdateRequest(request({confirmation:'yes'}),{allowWindowsPort:true}),/Type/);
 assert.throws(()=>validateCommunityUpdateRequest(request({target:'v0.1.54'}),{allowWindowsPort:true}),/target release/);
 const f=await fixture(t),control=path.join(f.root,'control');await mkdir(control);
 await assert.rejects(submitCommunityUpdateRequest(input,{directory:control,requireAgentOnline:false,environment:{ALPR_DEPLOYMENT_PROFILE:'linux-docker'}}),/Unsupported/);
 const submitted=await submitCommunityUpdateRequest(input,{directory:control,requireAgentOnline:false,environment:{ALPR_DEPLOYMENT_PROFILE:'windows-native'}});
 const claimed=await claimWindowsUpdateRequest({control,privateRoot:f.privateRoot});assert.equal(claimed.request.id,submitted.requestId);assert.equal(claimed.request.appPort,3001);
});
test('port change commits only after verification and keeps database and network settings',async t=>{
 const f=await fixture(t);const expected={...f.deployment.installation.environment,PORT:'3001'};
 const result=await changeWindowsApplicationPort(request(),{SystemRoot:'C:\\Windows'},{deployment:f.deployment});
 assert.deepEqual(f.calls,['check','apply']);assert.equal(result.currentAppPort,3001);assert.deepEqual(f.deployment.installation.environment,expected);
 const journal=JSON.parse(await readFile(path.join(f.privateRoot,'application-port.json'),'utf8'));assert.equal(journal.phase,'committed');assert.doesNotMatch(JSON.stringify(journal),/private-fixture-secret/);
 await assert.rejects(readFile(path.join(f.backupRoot,'maintenance.lock')),{code:'ENOENT'});
});
test('failed startup restores the previous application port',async t=>{
 const f=await fixture(t,true);await assert.rejects(changeWindowsApplicationPort(request(),{SystemRoot:'C:\\Windows'},{deployment:f.deployment}),/previous application port was restored/);
 assert.deepEqual(f.calls,['check','apply','restore']);assert.equal(f.deployment.installation.environment.PORT,'3000');
 assert.equal(JSON.parse(await readFile(path.join(f.privateRoot,'application-port.json'),'utf8')).phase,'restored');
});
test('interrupted port transaction is recovered without applying the request again',async t=>{
 const f=await fixture(t),input=request();
 f.deployment.installation.environment.PORT='3001';
 await writeFile(path.join(f.privateRoot,'application-port.json'),JSON.stringify({formatVersion:1,requestId:input.id,current:f.deployment.installation.current,previousPort:3000,port:3001,rulePresent:true,ruleEnabled:true,phase:'pending'}));
 const result=await changeWindowsApplicationPort(input,{SystemRoot:'C:\\Windows'},{deployment:f.deployment,recover:true});
 assert.deepEqual(f.calls,['restore']);assert.equal(result.currentAppPort,3000);assert.equal(f.deployment.installation.environment.PORT,'3000');
});
test('port changes refuse pending updates, shared database ports and maintenance before mutation',async t=>{
 for(const kind of ['update','database','lock']){
  const f=await fixture(t);
  if(kind==='update')await writeFile(path.join(f.backupRoot,'updater-state.json'),JSON.stringify({status:'ready-for-acceptance'}));
  if(kind==='lock')await writeFile(path.join(f.backupRoot,'maintenance.lock'),String(process.pid));
  await assert.rejects(changeWindowsApplicationPort(request({appPort:kind==='database'?5433:3001}),{SystemRoot:'C:\\Windows'},{deployment:f.deployment}));assert.deepEqual(f.calls,[]);
 }
});


test('recovery before journal creation verifies the existing port without applying a change',async t=>{
 const f=await fixture(t),input=request();
 const result=await changeWindowsApplicationPort(input,{SystemRoot:'C:\\Windows'},{deployment:f.deployment,recover:true});
 assert.deepEqual(f.calls,[]);assert.equal(result.currentAppPort,3000);
 assert.match(result.message,/No port change was applied/);
});

test('malformed or mismatched pending journals refuse before applying or restoring a port',async t=>{
 for(const change of [{port:'3001'},{previousPort:3001},{ruleEnabled:'true'},{current:'invalid'},{requestId:'invalid'},{phase:'invalid'}]){
  const f=await fixture(t),input=request();
  const journal={formatVersion:1,requestId:input.id,current:f.deployment.installation.current,previousPort:3000,port:3001,rulePresent:true,ruleEnabled:true,phase:'pending',...change};
  await writeFile(path.join(f.privateRoot,'application-port.json'),JSON.stringify(journal));
  await assert.rejects(changeWindowsApplicationPort(input,{SystemRoot:'C:\\Windows'},{deployment:f.deployment,recover:true}));assert.deepEqual(f.calls,[]);
 }
});

test('port operations retain update acceptance and rollback information in public status',async t=>{
 const f=await fixture(t);f.deployment.current={version:'0.1.54',commit:'a'.repeat(40)};
 const {performWindowsUpdateRequest}=await import('../scripts/windows-update-worker.mjs');
 const input=request();const result=await performWindowsUpdateRequest(input,{SystemRoot:'C:\\Windows'},{deployment:f.deployment,changePort:async()=>({currentAppPort:3001,message:'Changed'}),runUpdater:async()=>({status:'accepted',current:{tag:'v0.1.54'},backup:{dumpSha256:'a'.repeat(64)},acceptance:{cleanupEligibleAt:'2026-10-14T00:00:00Z'}})});
 assert.equal(result.currentAppPort,3001);assert.equal(result.updaterStatus,'accepted');assert.equal(result.rollbackPresent,true);assert.equal(result.message,'Changed');
});
