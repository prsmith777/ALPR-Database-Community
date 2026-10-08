import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,readdir,rm,rename,link} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';
import {atomicJson} from '../scripts/windows-deployment.mjs';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'alpr-state-publish-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'state.json');await writeFile(file,'{"original":true}');return {root,file};}
test('atomic Windows state publication retries sharing failures and removes only its staging file',async t=>{
 const f=await fixture(t);let calls=0;const waits=[];
 await atomicJson(f.file,{next:true},{renameFile:async(from,to)=>{if(calls++<3)throw Object.assign(Error('sharing violation'),{code:'EPERM'});await rename(from,to);},sleep:async ms=>waits.push(ms)});
 assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),{next:true});assert.equal(calls,4);assert.deepEqual(waits,[25,50,100]);assert.deepEqual(await readdir(f.root),['state.json']);
});
test('persistent and unrelated publication failures preserve previous state and remain bounded',async t=>{
 for(const code of ['EACCES','EINVAL']){
  const f=await fixture(t);let calls=0;
  await assert.rejects(atomicJson(f.file,{next:true},{renameFile:async()=>{calls++;throw Object.assign(Error(code),{code});},sleep:async()=>{}}),{code});
  assert.equal(calls,code==='EACCES'?9:1);assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),{original:true});assert.deepEqual(await readdir(f.root),['state.json']);
 }
});
test('state publication refuses a hard-linked destination without modifying either name',async t=>{
 const f=await fixture(t);await link(f.file,path.join(f.root,'other.json'));
 await assert.rejects(atomicJson(f.file,{next:true}),/regular files/);
 assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),{original:true});assert.equal((await readdir(f.root)).length,2);
});

test('state publication survives a real Windows reader that temporarily denies replacement',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),env={...process.env};delete env.PSModulePath;
 const code="$ErrorActionPreference='Stop';$h=[IO.File]::Open('"+f.file.replaceAll("'","''")+"',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::WriteLine('LOCKED');Start-Sleep -Milliseconds 750}finally{$h.Dispose()}";
 const child=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',code],{env,windowsHide:true});
 t.after(()=>child.kill());
 const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Reader fixture exited '+code)));});
 await new Promise((resolve,reject)=>{let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('LOCKED'))resolve();});completion.then(()=>{if(!output.includes('LOCKED'))reject(Error('Reader fixture did not acquire the file'));},reject);});
 const waits=[];
 await atomicJson(f.file,{next:true},{sleep:async ms=>{waits.push(ms);await new Promise(resolve=>setTimeout(resolve,ms));}});
 await completion;assert.ok(waits.length>0,'The actual sharing lock must exercise a retry');assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),{next:true});assert.deepEqual(await readdir(f.root),['state.json']);
});
