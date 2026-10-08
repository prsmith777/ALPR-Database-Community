import {open,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {atomicJson,assertRealDirectory,loadWindowsDeployment} from './windows-deployment.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function port(value){if(!Number.isInteger(value)||value<1024||value>65535)throw new Error('Invalid database port');return value;}
export async function assertNoPendingPortChange(data,except=null){
 for(const name of ['application-port','database-port']){
  if(name===except)continue;
  try{const value=JSON.parse(await readFile(path.join(data,'management','updates',name+'.json'),'utf8'));
   if(value.phase==='pending')throw new Error('Finish the current maintenance recovery before changing connection ports or software');
  }catch(error){if(error.code!=='ENOENT')throw error;}
 }
}
export async function changeWindowsDatabasePort(request,environment=process.env,options={}) {
 if(!uuid.test(request.id))throw new Error('Invalid port request identity');
 const deployment=options.deployment||await loadWindowsDeployment(environment.ALPR_WINDOWS_INSTALLATION,{allowPreview:true});
 const privateRoot=path.join(deployment.data,'management','updates');await assertRealDirectory(privateRoot);await assertRealDirectory(deployment.backupRoot);
 const journalFile=path.join(privateRoot,'database-port.json'),lockFile=path.join(deployment.backupRoot,'maintenance.lock');
 let lock;
 try{lock=await open(lockFile,'wx');}
 catch(error){
  if(error.code!=='EEXIST'||!options.recover)throw new Error('Finish the current maintenance operation before changing the database port');
  const owner=(await readFile(lockFile,'utf8')).trim();if(!/^[1-9]\d{0,9}$/.test(owner))throw new Error('Port maintenance lock needs administrator recovery');
  try{process.kill(Number(owner),0);throw new Error('Port maintenance is still running');}catch(probe){if(probe.code!=='ESRCH')throw probe;}
  await rm(lockFile);lock=await open(lockFile,'wx');
 }
 await lock.writeFile(String(process.pid));
 const run=(operation,record)=>deployment.run(path.join(environment.SystemRoot||process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),[
  '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(deployment.root,'host','Database-Port.ps1'),
  '-Operation',operation,'-Port',String(record.port),'-PreviousPort',String(record.previousPort),'-RequestId',record.requestId,
  ...(record.backupSha256?['-BackupSha256',record.backupSha256]:[]),
 ],{timeout:600000});
 const result=record=>({currentDatabasePort:record.phase==='committed'?record.port:record.previousPort,targetDatabasePort:record.port,
  message:record.phase==='committed'?'PostgreSQL port changed and verified. Your browser and Blue Iris addresses stay the same.':'The previous PostgreSQL port was restored.'});
 try {
  await assertNoPendingPortChange(deployment.data,'database-port');
  let journal;try{journal=JSON.parse(await readFile(journalFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(journal){
   if(journal.formatVersion!==1||!/^\d+\.\d+\.\d+-[0-9a-f]{12}$/.test(journal.current)||!uuid.test(journal.requestId)||!['pending','committed','restored'].includes(journal.phase)||!/^[a-f0-9]{64}$/.test(journal.backupSha256))throw new Error('Port recovery requires administrator assistance');
   port(journal.previousPort);port(journal.port);if(journal.previousPort===journal.port)throw new Error('Port recovery requires administrator assistance');
   if(journal.current!==deployment.installation.current){if(journal.phase==='pending')throw new Error('Port recovery requires administrator assistance');journal=null;}
  }
  if(options.recover){
   if(journal?.requestId!==request.id){if(journal?.phase==='pending')throw new Error('Port recovery request differs');journal=null;}
   if(!journal){await deployment.health();await deployment.attest();return {currentDatabasePort:port(Number(deployment.installation.environment.DB_HOST.split(':').at(-1))),message:'The database port was preserved. No port change was applied.'};}
   if(journal.phase==='pending'){run('restore',journal);journal.phase='restored';await atomicJson(journalFile,journal);}
   else {run('verify',journal);await deployment.health();await deployment.attest();}
   return result(journal);
  }
  if(journal?.phase==='pending')throw new Error('An interrupted port change must be recovered first');
  let state;try{state=JSON.parse(await readFile(path.join(deployment.backupRoot,'updater-state.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(state&&!['accepted','rolled-back'].includes(state.status))throw new Error('Finish the pending software update before changing the database port');
  const previousPort=port(Number(deployment.installation.environment.DB_HOST.split(':').at(-1))),next=port(request.databasePort);
  if(next===Number(deployment.installation.environment.PORT))throw new Error('Application and database ports must differ');
  if(next===previousPort)return {currentDatabasePort:next,targetDatabasePort:next,message:'PostgreSQL already uses this port.'};
  let checked;const record={requestId:request.id,port:next,previousPort};
  try{checked=JSON.parse(run('check',record));}
  catch(error){if(error.message.includes('The selected database port is in use'))throw new Error('The selected database port is in use. Choose another port.',{cause:error});throw error;}
  if(!/^[a-f0-9]{64}$/.test(checked.backupSha256))throw new Error('Invalid database configuration recovery copy');
  journal={formatVersion:1,...record,current:deployment.installation.current,backupSha256:checked.backupSha256,phase:'pending'};
  await atomicJson(journalFile,journal);
  options.progress?.('Changing the local PostgreSQL port and restarting ALPR. Keep this page open.');
  try{run('apply',journal);journal.phase='committed';await atomicJson(journalFile,journal);return result(journal);}
  catch(error){
   try{run('restore',journal);journal.phase='restored';await atomicJson(journalFile,journal);}
   catch{throw new Error('The database port change needs administrator recovery. Preserve the installation and check the updater log.',{cause:error});}
   throw new Error('The database port change failed. The previous PostgreSQL port was restored.',{cause:error});
  }
 }finally{await lock.close();await rm(lockFile,{force:true});}
}
