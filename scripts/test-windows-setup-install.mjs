import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
function section(source,start,end){const a=source.indexOf(start),b=end?source.indexOf(end,a):source.length;if(a<0||b<=a)throw new Error('Missing installer section');return source.slice(a,b);}
export async function verifyWindowsSetupInstall({compiler,sourceText,failure='none'}) {
 compiler=path.resolve(compiler);
 if(process.platform!=='win32')throw new Error('Installer execution requires Windows');
 if(!['none','exit','error-zero','missing-completion','missing-port'].includes(failure))throw new Error('Unknown fixture failure');
 const source=sourceText??await readFile(path.join(root,'scripts/windows/CommunitySetup.iss'),'utf8');
 const scratch=await mkdtemp(path.join(os.tmpdir(),'alpr-install-gate-'));
 const installed=path.join(scratch,'installed');
 try {
  await mkdir(path.join(scratch,'payload'));await writeFile(path.join(scratch,'payload/probe.txt'),'disposable fixture');
  await writeFile(path.join(scratch,'Setup-Helpers.ps1'),'# Fixture only');await writeFile(path.join(scratch,'setup-prerequisites.json'),'{}');
  await writeFile(path.join(scratch,'Setup.ps1'),`param([string]$Operation,[string]$WorkRoot,[string]$PackageRoot,[string]$ManifestSha256,[switch]$UpdateExisting)\n$ErrorActionPreference='Stop'\nif($Operation -eq 'prepare'){Write-Output 'ALPR_SETUP_PROGRESS:fixture prepared';exit 0}\nif($Operation -eq 'install'){\n if('${failure}' -in @('exit','error-zero')){Write-Output 'ALPR_SETUP_ERROR:Fixture installation refused';if('${failure}' -eq 'exit'){exit 7};exit 0}\n if('${failure}' -ne 'missing-port'){Write-Output 'ALPR_SETUP_PORT:3001'}\n if('${failure}' -ne 'missing-completion'){Write-Output 'ALPR_SETUP_COMPLETE:verified'}\n exit 0\n}\nexit 0\n`);
  const code=section(source,'function Powershell: String;','function InitializeSetup:')+section(source,'procedure SetupOutput(','procedure UninstallOutput(');
  const fixture=`#define ManifestSha256 "${'0'.repeat(64)}"
[Setup]
AppId=ALPR-Install-Gate-${path.basename(scratch)}
AppName=ALPR Disposable Install Gate
AppVersion=0.0.0
DefaultDirName=${installed}
PrivilegesRequired=lowest
Uninstallable=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=yes
DisableReadyPage=yes
CloseApplications=no
RestartApplications=no
SetupLogging=yes
OutputDir=${scratch}
OutputBaseFilename=install-gate
[Files]
Source: "Setup.ps1"; Flags: dontcopy
Source: "Setup-Helpers.ps1"; Flags: dontcopy
Source: "setup-prerequisites.json"; Flags: dontcopy
Source: "payload\\probe.txt"; DestDir: "{tmp}\\payload"; Flags: dontcopy
Source: "payload\\probe.txt"; DestDir: "{app}"
[Code]
var PortsPage:TInputQueryWizardPage;InstalledAppPort:Integer;PasswordPage:TInputQueryWizardPage; InstallModePage:TInputOptionWizardPage; MigrationPage:TInputDirWizardPage; ProgressPage:TOutputProgressWizardPage; NetworkAccessCheck:TNewCheckBox; WorkRoot:String; Prepared,InstallationRunning,InstallationVerified,OperationComplete:Boolean; LastError:String;
procedure InitializeWizard;
begin
 InstallModePage:=CreateInputOptionPage(wpWelcome,'Fixture','Fixture','Disposable test only',True,False);
 InstallModePage.Add('Empty');InstallModePage.Add('Move');InstallModePage.Add('Restore');InstallModePage.Add('Update');InstallModePage.SelectedValueIndex:=3;
 PortsPage:=CreateInputQueryPage(InstallModePage.ID,'Ports','Ports','Ports');PortsPage.Add('App',False);PortsPage.Add('DB',False);PortsPage.Values[0]:='3001';PortsPage.Values[1]:='5434';
 PasswordPage:=CreateInputQueryPage(InstallModePage.ID,'Fixture','Fixture','Fixture');PasswordPage.Add('One',True);PasswordPage.Add('Two',True);
 NetworkAccessCheck:=TNewCheckBox.Create(WizardForm);NetworkAccessCheck.Checked:=False;
 MigrationPage:=CreateInputDirPage(PasswordPage.ID,'Fixture','Fixture','Fixture',False,'');MigrationPage.Add('Fixture');MigrationPage.Values[0]:='${scratch.replaceAll("'","''")}';
 ProgressPage:=CreateOutputProgressPage('Fixture','Disposable test');WorkRoot:='${scratch.replaceAll("'","''")}\\work';
end;
${code}
`;
  await writeFile(path.join(scratch,'fixture.iss'),fixture);
  const build=spawnSync(compiler,['/Q',path.join(scratch,'fixture.iss')],{cwd:scratch,encoding:'utf8',windowsHide:true,timeout:30000});
  if(build.error||build.status!==0)throw new Error('Install gate compilation failed: '+(build.error?.message||build.stdout+build.stderr));
  const logFile=path.join(scratch,'setup.log');
  const run=spawnSync(path.join(scratch,'install-gate.exe'),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/LOG='+logFile],{cwd:scratch,encoding:'utf8',windowsHide:true,timeout:30000});
  const log=await readFile(logFile,'utf8').catch(()=> '');const copied=existsSync(path.join(installed,'probe.txt'));
  if(!log.includes('ALPR_SETUP_PROGRESS:fixture prepared'))throw new Error('Fixture did not reach application preparation:\n'+log);
  if(failure==='exit'||failure==='error-zero'){if(!log.includes('ALPR_SETUP_ERROR:Fixture installation refused'))throw new Error('Fixture failed before the intended child failure:\n'+log);}
  if(run.error)throw new Error('Install gate run failed: '+run.error.message+'\n'+log);
  if(failure==='none') {
   if(run.status!==0||!copied||!log.includes('Installation process succeeded.'))throw new Error('Verified fixture installation did not finish:\n'+log);
  } else if(run.status===0||copied||log.includes('Installation process succeeded.'))throw new Error('Failed application install incorrectly reported success (exit '+run.status+', copied '+copied+'):\n'+log);
  return {verified:true,failure,exitCode:run.status,filesInstalled:copied};
 } finally {
  if(path.dirname(path.resolve(scratch))!==path.resolve(os.tmpdir()))throw new Error('Refusing fixture cleanup outside temporary root');
  await rm(scratch,{recursive:true,force:true});
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [compiler,failure='none']=process.argv.slice(2);if(!compiler)throw new Error('Compiler path required');console.log(await verifyWindowsSetupInstall({compiler,failure}));
}
