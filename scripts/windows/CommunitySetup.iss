; Build with scripts/build-windows-setup.mjs. All paths and hashes come from
; the verified package, never from end-user command-line overrides.
#ifndef PackageRoot
  #error PackageRoot is required
#endif
#ifndef ManifestSha256
  #error ManifestSha256 is required
#endif
#ifndef PackageVersion
  #error PackageVersion is required
#endif
#ifndef OutputRoot
  #error OutputRoot is required
#endif
#ifndef OutputName
  #error OutputName is required
#endif

[Setup]
AppId={{0E2897C1-7F04-4670-A216-664A0B5DA3A3}
AppName=ALPR Database Community
AppVersion={#PackageVersion}
AppPublisher=ALPR Database Community
AppPublisherURL=https://github.com/prsmith777/ALPR-Database-Community
#ifdef StartupProbe
; This build only creates the wizard controls, then exits. No elevation,
; payload, shortcuts, uninstaller, or application installation is permitted.
DefaultDirName={tmp}\ALPR Startup Probe
PrivilegesRequired=lowest
Uninstallable=no
#else
DefaultDirName={autopf}\ALPR Community Setup
PrivilegesRequired=admin
#endif
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=yes
DisableReadyPage=yes
UsePreviousAppDir=no
UsePreviousGroup=no
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.19045
SetupMutex=Global\ALPRCommunityWindowsSetup
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=yes
OutputDir={#OutputRoot}
OutputBaseFilename={#OutputName}
#ifndef StartupProbe
SetupIconFile={#PackageRoot}\app\public\license-plate.ico
#endif
UninstallDisplayName=ALPR Database Community
UninstallDisplayIcon={uninstallexe}
CloseApplications=no
RestartApplications=no
SetupLogging=yes
UninstallLogging=yes

#ifndef StartupProbe
[Files]
Source: "Setup.ps1"; Flags: dontcopy
Source: "Setup-Helpers.ps1"; Flags: dontcopy
Source: "setup-prerequisites.json"; Flags: dontcopy
Source: "{#PackageRoot}\*"; DestDir: "{tmp}\payload"; Flags: dontcopy recursesubdirs createallsubdirs
Source: "Uninstall.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "Setup-Helpers.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PackageRoot}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{commonprograms}\ALPR Database Community"; Filename: "http://localhost:3000"; Comment: "Open ALPR Database Community"
Name: "{commondesktop}\ALPR Database Community"; Filename: "http://localhost:3000"; Comment: "Open ALPR Database Community"

[Run]
Filename: "http://localhost:3000"; Description: "Open ALPR"; Flags: postinstall shellexec runasoriginaluser skipifsilent

[UninstallDelete]
; InitializeUninstall verifies fixed roots and service ownership, then stops
; and unregisters both services before allowing this code-only deletion.
Type: filesandordirs; Name: "{autopf}\ALPR Community"
#endif

[Code]
var
  PasswordPage: TInputQueryWizardPage;
  WorkRoot: String;
  Prepared: Boolean;
  InstallationRunning: Boolean;
  LastError: String;

function GetTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall';

function Powershell: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function InitializeSetup: Boolean;
var
  Version: TWindowsVersion;
  DisplayVersion: String;
begin
  GetWindowsVersionEx(Version);
  RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'DisplayVersion', DisplayVersion);
  Result := (Version.ProductType = VER_NT_WORKSTATION) and
    (((Version.Build = 19045) and (DisplayVersion = '22H2')) or (Version.Build >= 22000));
#ifdef StartupProbe
  // Windows Server CI can exercise wizard startup without being an install target.
  Log('ALPR_STARTUP_PROBE_OS_CHECK=' + IntToStr(Ord(Result)));
  Result := True;
#else
  if not Result then
    MsgBox('ALPR requires Windows 10 22H2 or Windows 11 on an x64 computer.', mbError, MB_OK);
#endif
end;

procedure InitializeWizard;
begin
  PasswordPage := CreateInputQueryPage(wpWelcome, 'Install ALPR Database Community',
    'Choose your administrator password',
    'You will use this password to sign in to ALPR. Setup downloads the required components and starts ALPR automatically. An internet connection is required.'#13#10#13#10 +
    'This is a development preview for testing.');
  PasswordPage.Add('Administrator password (12 to 128 characters):', True);
  PasswordPage.Add('Confirm password:', True);
  WorkRoot := ExpandConstant('{commonappdata}\ALPR Community Setup\') +
    GetDateTimeString('yyyymmddhhnnss', #0, #0) + '-' + IntToStr(GetTickCount and $7FFFFFFF);
  WizardForm.FinishedLabel.Caption := 'ALPR is ready. Sign in with the password you chose in Setup. Leave the username blank during first-time setup.';
#ifdef StartupProbe
  if (PasswordPage.Values[0] <> '') or
    (PasswordPage.Values[1] <> '') or (WorkRoot = '') then
    RaiseException('Startup probe did not initialize the password page and workspace.');
  Log('ALPR_STARTUP_PROBE_PASSED');
  Abort;
#endif
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = PasswordPage.ID then
    WizardForm.NextButton.Caption := 'Install';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Password: String;
  I: Integer;
begin
  Result := True;
  if CurPageID <> PasswordPage.ID then Exit;
  Password := PasswordPage.Values[0];
  Result := (Length(Password) >= 12) and (Length(Password) <= 128) and
    (Password = PasswordPage.Values[1]);
  for I := 1 to Length(Password) do
    if Ord(Password[I]) < 32 then Result := False;
  if not Result then
    MsgBox('Enter matching passwords containing 12 to 128 characters.', mbError, MB_OK);
end;

procedure SetupOutput(const S: String; const Error, FirstLine: Boolean);
begin
  Log(S);
  if Pos('ALPR_SETUP_ERROR:', S) = 1 then
    LastError := Copy(S, 18, Length(S));
  if Pos('ALPR_SETUP_PROGRESS:', S) = 1 then begin
    WizardForm.PreparingMemo.Lines.Text := Copy(S, 21, Length(S));
    WizardForm.StatusLabel.Caption := Copy(S, 21, Length(S));
    WizardForm.Refresh;
  end;
end;

function RunSetupOperation(Operation: String; var ResultCode: Integer): Boolean;
var
  Parameters: String;
begin
  LastError := '';
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\Setup.ps1') + '" -Operation ' + Operation +
    ' -WorkRoot "' + WorkRoot + '"';
  if Operation = 'prepare' then
    Parameters := Parameters + ' -PackageRoot "' + ExpandConstant('{tmp}\payload') +
      '" -ManifestSha256 {#ManifestSha256}';
  Result := ExecAndLogOutput(Powershell, Parameters, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode, @SetupOutput);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if Prepared then Exit;
  InstallationRunning := True;
  try
    ExtractTemporaryFile('Setup.ps1');
    ExtractTemporaryFile('Setup-Helpers.ps1');
    ExtractTemporaryFile('setup-prerequisites.json');
    ExtractTemporaryFiles('{tmp}\payload\*');
    if not RunSetupOperation('prepare', ResultCode) then begin
      Result := 'Setup could not start. Close Setup and try again.';
      Exit;
    end;
    if ResultCode = 3010 then begin
      NeedsRestart := True;
      Result := 'Windows needs to restart to finish installing a required component. Run this installer again after restarting.';
      Exit;
    end;
    if ResultCode <> 0 then begin
      Result := LastError;
      if Result = '' then Result := 'Setup could not finish its checks.';
      Result := Result + #13#10#13#10 + 'Close Setup and try again. Setup log: ' + ExpandConstant('{log}');
      Exit;
    end;
    if not SaveStringToFile(WorkRoot + '\administrator-password.txt', UTF8Encode(PasswordPage.Values[0]), False) then begin
      Result := 'Setup could not save the administrator password securely.';
      Exit;
    end;
    PasswordPage.Values[0] := '';
    PasswordPage.Values[1] := '';
    Prepared := True;
  finally
    InstallationRunning := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep <> ssInstall then Exit;
  InstallationRunning := True;
  try
    if not Prepared or not RunSetupOperation('install', ResultCode) or (ResultCode <> 0) then begin
      if LastError = '' then LastError := 'ALPR could not finish installing.';
      RaiseException(LastError + #13#10 + 'Its data has been preserved. Setup log: ' + ExpandConstant('{log}'));
    end;
  finally
    InstallationRunning := False;
  end;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if InstallationRunning then Cancel := False;
end;

procedure DeinitializeSetup;
var
  ResultCode: Integer;
begin
#ifndef StartupProbe
  if FileExists(ExpandConstant('{tmp}\Setup.ps1')) then
    RunSetupOperation('cleanup', ResultCode);
#endif
end;

function InitializeUninstall: Boolean;
var
  ResultCode: Integer;
  Script: String;
begin
  Script := ExpandConstant('{app}\Uninstall.ps1');
  Result := ExecAndLogOutput(Powershell, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    Script + '" -CheckOnly', '', SW_HIDE, ewWaitUntilTerminated, ResultCode, nil) and (ResultCode = 0);
  if not Result then
    MsgBox('ALPR could not be removed safely. Application files and data have been preserved. Contact the maintainer with the uninstall log.', mbError, MB_OK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then begin
    if not ExecAndLogOutput(Powershell, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\Uninstall.ps1') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode, nil) or (ResultCode <> 0) then
      RaiseException('ALPR services could not be removed. Application files and data have been preserved.');
  end;
  if CurUninstallStep = usDone then
    MsgBox('ALPR has been removed. Your plate records, images, settings and backups are kept in ProgramData for recovery.', mbInformation, MB_OK);
end;
