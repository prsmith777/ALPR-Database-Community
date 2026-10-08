import {assertNoPendingPortChange} from './windows-database-port.mjs';
import {open,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {atomicJson,assertRealDirectory,loadWindowsDeployment} from './windows-deployment.mjs';

function port(value){if(!Number.isInteger(value)||value<1024||value>65535)throw new Error('Invalid application port');return value;}
export async function changeWindowsApplicationPort(request,environment=process.env,options={}) {
 const deployment=options.deployment||await loadWindowsDeployment(environment.ALPR_WINDOWS_INSTALLATION,{allowPreview:true});
 const privateRoot=path.join(deployment.data,'management','updates');await assertRealDirectory(privateRoot);await assertRealDirectory(deployment.backupRoot);
 const journalFile=path.join(privateRoot,'application-port.json'),lockFile=path.join(deployment.backupRoot,'maintenance.lock');
 let journal;try{journal=JSON.parse(await readFile(journalFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(journal) {
  if(journal.formatVersion!==1||!/^\d+\.\d+\.\d+-[0-9a-f]{12}$/.test(journal.current)||!/^[-a-f0-9]{36}$/.test(journal.requestId)||!['pending','committed','restored'].includes(journal.phase)||typeof journal.rulePresent!=='boolean'||typeof journal.ruleEnabled!=='boolean')throw new Error('Port recovery requires administrator assistance');
  port(journal.previousPort);port(journal.port);
  if(journal.previousPort===journal.port)throw new Error('Port recovery requires administrator assistance');
  if(journal.current!==deployment.installation.current) {
   if(journal.phase==='pending')throw new Error('Port recovery requires administrator assistance');
   journal=null;
  }
 }
 if(options.recover && journal?.requestId!==request.id){
  if(journal?.phase==='pending')throw new Error('Port recovery request differs');
  journal=null; // This worker stopped before recording or applying its own change.
 }
 let lock;
 try{lock=await open(lockFile,'wx');}
 catch(error){
  if(error.code!=='EEXIST'||!options.recover)throw new Error('Finish the current maintenance operation before changing the application port');
  const owner=(await readFile(lockFile,'utf8')).trim();if(!/^[1-9]\d{0,9}$/.test(owner))throw new Error('Port maintenance lock needs administrator recovery');
  try{process.kill(Number(owner),0);throw new Error('Port maintenance is still running');}catch(probe){if(probe.code!=='ESRCH')throw probe;}
  await rm(lockFile);lock=await open(lockFile,'wx');
 }
 await lock.writeFile(String(process.pid));
 const run=(operation,record)=>deployment.run(path.join(environment.SystemRoot||process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),[
  '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(deployment.root,'host','Application-Port.ps1'),
  '-Operation',operation,'-Port',String(record.port),'-PreviousPort',String(record.previousPort),
  '-RulePresent',String(Number(record.rulePresent)),'-RuleEnabled',String(Number(record.ruleEnabled)),
 ]);
 const result=record=>({currentAppPort:record.phase==='committed'?record.port:record.previousPort,targetAppPort:record.port,
  message:record.phase==='committed'?'Application port changed. Open the new address and update the Blue Iris destination port.':'The previous application port was restored.'});
 try {
  await assertNoPendingPortChange(deployment.data,'application-port');
  if(options.recover){
   if(!journal){await deployment.health();await deployment.attest();return {currentAppPort:port(Number(deployment.installation.environment.PORT)),message:'The application port was preserved. No port change was applied.'};}
   port(journal.previousPort);port(journal.port);
   if(journal.phase==='pending'){run('restore',journal);journal.phase='restored';await atomicJson(journalFile,journal);}
   else {await deployment.health();await deployment.attest();}
   return result(journal);
  }
  if(journal?.phase==='pending')throw new Error('An interrupted port change must be recovered first');
  let state;try{state=JSON.parse(await readFile(path.join(deployment.backupRoot,'updater-state.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(state&&!['accepted','rolled-back'].includes(state.status))throw new Error('Finish the pending software update before changing the application port');
  const previousPort=port(Number(deployment.installation.environment.PORT)),next=port(request.appPort);
  if(next===Number(deployment.installation.environment.DB_HOST.split(':').at(-1)))throw new Error('Application and database ports must differ');
  if(next===previousPort)return {currentAppPort:next,targetAppPort:next,message:'The application already uses this port.'};
  let checked;
  try {checked=JSON.parse(run('check',{port:next,previousPort,rulePresent:false,ruleEnabled:false}));}
  catch(error){if(error.message.includes('The selected application port is in use'))throw new Error('The selected application port is in use. Choose another port.',{cause:error});throw error;}
  journal={formatVersion:1,requestId:request.id,current:deployment.installation.current,previousPort,port:next,rulePresent:checked.rulePresent,ruleEnabled:checked.ruleEnabled,phase:'pending'};
  await atomicJson(journalFile,journal);
  options.progress?.('Changing the application port and restarting ALPR. Open the new address when ready.');
  try{run('apply',journal);journal.phase='committed';await atomicJson(journalFile,journal);return result(journal);}
  catch(error){
   try{run('restore',journal);journal.phase='restored';await atomicJson(journalFile,journal);}
   catch{throw new Error('The port change needs administrator recovery. Preserve the installation and check the updater log.',{cause:error});}
   throw new Error('The port change failed. The previous application port was restored.',{cause:error});
  }
 } finally {await lock.close();await rm(lockFile,{force:true});}
}
