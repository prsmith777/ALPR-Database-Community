#ifndef PackageRoot
  #error PackageRoot is required
#endif
#ifndef ManifestSha256
  #error ManifestSha256 is required
#endif
#ifndef PackageVersion
  #error PackageVersion is required
#endif
#ifndef FromCommit
  #define FromCommit "2709afd8b262b997196ddb2b0f2aa2c3304132b6"
#endif
#ifndef OutputRoot
  #error OutputRoot is required
#endif
#ifndef OutputName
  #error OutputName is required
#endif

[Setup]
AppId={{DB046851-9807-4164-B82D-1B45581E85DA}
AppName=ALPR Community Settings Repair
AppVersion={#PackageVersion}
DefaultDirName={tmp}\ALPR Community Repair
CreateAppDir=no
Uninstallable=no
#ifdef StartupProbe
PrivilegesRequired=lowest
#else
PrivilegesRequired=admin
SetupIconFile={#PackageRoot}\app\public\license-plate.ico
#endif
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.19045
SetupMutex=Global\ALPRCommunityWindowsSetup
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=yes
OutputDir={#OutputRoot}
OutputBaseFilename={#OutputName}
CloseApplications=no
RestartApplications=no
SetupLogging=yes

#ifndef StartupProbe
[Files]
Source: "Repair.ps1"; Flags: dontcopy
Source: "Setup-Helpers.ps1"; Flags: dontcopy
Source: "{#PackageRoot}\*"; DestDir: "{tmp}\payload"; Flags: dontcopy recursesubdirs createallsubdirs

[Run]
Filename: "http://localhost:3000/settings/general"; Description: "Open ALPR Settings"; Flags: postinstall shellexec runasoriginaluser skipifsilent
#endif

[Code]
var
  RepairPage: TOutputMsgWizardPage;
  WorkRoot, LastError: String;
  Repaired: Boolean;

function GetTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall';

function InitializeSetup: Boolean;
var Version: TWindowsVersion; DisplayVersion: String;
begin
  GetWindowsVersionEx(Version);
  RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'DisplayVersion', DisplayVersion);
  Result := (Version.ProductType = VER_NT_WORKSTATION) and
    (((Version.Build = 19045) and (DisplayVersion = '22H2')) or (Version.Build >= 22000));
#ifdef StartupProbe
  Log('ALPR_STARTUP_PROBE_OS_CHECK=' + IntToStr(Ord(Result)));
  Result := True;
#else
  if not Result then MsgBox('ALPR requires Windows 10 22H2 or Windows 11 on an x64 computer.', mbError, MB_OK);
#endif
end;

procedure InitializeWizard;
begin
  RepairPage := CreateOutputMsgPage(wpWelcome, 'Repair ALPR Settings', 'Keep your existing installation',
    'Click Repair to fix the Settings page. ALPR will briefly restart. Your password, settings, plate records, and images stay in place.'#13#10#13#10 +
    'This repair applies to the Windows preview installed during this test.');
  WorkRoot := ExpandConstant('{commonappdata}\ALPR Community Setup\') +
    GetDateTimeString('yyyymmddhhnnss', #0, #0) + '-' + IntToStr(GetTickCount and $7FFFFFFF);
  WizardForm.FinishedLabel.Caption := 'The Settings repair completed. Use your existing ALPR password to sign in.';
#ifdef StartupProbe
  if WorkRoot = '' then RaiseException('Repair workspace was not initialized.');
  Log('ALPR_STARTUP_PROBE_PASSED');
  Abort;
#endif
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = RepairPage.ID then WizardForm.NextButton.Caption := 'Repair';
end;

procedure RepairOutput(const S: String; const Error, FirstLine: Boolean);
begin
  Log(S);
  if Pos('ALPR_SETUP_ERROR:', S) = 1 then LastError := Copy(S, 18, Length(S));
  if Pos('ALPR_SETUP_PROGRESS:', S) = 1 then begin
    WizardForm.PreparingMemo.Lines.Text := Copy(S, 21, Length(S));
    WizardForm.Refresh;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Parameters: String; ResultCode: Integer;
begin
  Result := '';
  if Repaired then Exit;
  ExtractTemporaryFile('Repair.ps1');
  ExtractTemporaryFile('Setup-Helpers.ps1');
  ExtractTemporaryFiles('{tmp}\payload\*');
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\Repair.ps1') +
    '" -PackageRoot "' + ExpandConstant('{tmp}\payload') + '" -ManifestSha256 {#ManifestSha256}' +
    ' -FromCommit {#FromCommit} -WorkRoot "' + WorkRoot + '"';
  if not ExecAndLogOutput(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Parameters, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode, @RepairOutput) then Result := 'Windows could not start the repair.'
  else if ResultCode <> 0 then begin
    Result := LastError;
    if Result = '' then Result := 'The repair could not complete. Contact the maintainer.';
    Result := Result + #13#10#13#10 + 'Repair log: ' + ExpandConstant('{log}');
  end else Repaired := True;
end;
