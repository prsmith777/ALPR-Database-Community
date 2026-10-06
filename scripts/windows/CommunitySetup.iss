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
Source: "Network-Helpers.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PackageRoot}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{commonprograms}\ALPR Database Community"; Filename: "http://localhost:3000"; Comment: "Open ALPR Database Community"
Name: "{commonprograms}\ALPR Migration Backup"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{autopf}\ALPR Community\host\ExportMigration.ps1"""; Comment: "Make a verified ALPR backup for another computer"
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
  InstallModePage: TInputOptionWizardPage;
  MigrationPage: TInputDirWizardPage;
  SourceStoppedCheck: TNewCheckBox;
  ProgressPage: TOutputProgressWizardPage;
  NetworkAccessCheck: TNewCheckBox;
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
  InstallModePage := CreateInputOptionPage(wpWelcome, 'Set up ALPR', 'Choose how to start',
    'Create a new installation, or move a verified ALPR backup from Linux or Windows.', True, False);
  InstallModePage.Add('Start with an empty database');
  InstallModePage.Add('Move an existing ALPR database and images');
  InstallModePage.SelectedValueIndex := 0;
  MigrationPage := CreateInputDirPage(InstallModePage.ID, 'Move your ALPR data', 'Choose your migration backup folder',
    'Select the folder containing migration-backup.json. The backup and original computer remain available for recovery.', False, '');
  MigrationPage.Add('ALPR migration backup:');
  SourceStoppedCheck := TNewCheckBox.Create(WizardForm);
  SourceStoppedCheck.Parent := MigrationPage.Surface;
  SourceStoppedCheck.Top := MigrationPage.Edits[0].Top + MigrationPage.Edits[0].Height + ScaleY(12);
  SourceStoppedCheck.Width := MigrationPage.SurfaceWidth;
  SourceStoppedCheck.Height := ScaleY(36);
  SourceStoppedCheck.Caption := 'I have paused ingestion on the old ALPR installation';
  ProgressPage := CreateOutputProgressPage('Setting up ALPR', 'Please wait while Setup completes the current step');
  PasswordPage := CreateInputQueryPage(MigrationPage.ID, 'Install ALPR Database Community',
    'Choose your administrator password',
    'You will use this password to sign in to ALPR. Setup downloads the required components and starts ALPR automatically. An internet connection is required.'#13#10#13#10 +
    'For migration, this replaces the old setup administrator password. Existing named accounts keep their passwords.'#13#10 +
    'This is a development preview for testing.');
  PasswordPage.Add('Administrator password (12 to 128 characters):', True);
  PasswordPage.Add('Confirm password:', True);
  NetworkAccessCheck := TNewCheckBox.Create(WizardForm);
  NetworkAccessCheck.Parent := PasswordPage.Surface;
  NetworkAccessCheck.Left := 0;
  NetworkAccessCheck.Top := PasswordPage.Edits[1].Top + PasswordPage.Edits[1].Height + ScaleY(12);
  NetworkAccessCheck.Width := PasswordPage.SurfaceWidth;
  NetworkAccessCheck.Height := ScaleY(20);
  NetworkAccessCheck.Caption := 'Allow access from other devices on my local network';
  NetworkAccessCheck.Checked := False;
  WorkRoot := ExpandConstant('{commonappdata}\ALPR Community Setup\') +
    GetDateTimeString('yyyymmddhhnnss', #0, #0) + '-' + IntToStr(GetTickCount and $7FFFFFFF);
  WizardForm.FinishedLabel.Caption := 'ALPR is ready. Sign in with the password you chose in Setup. Leave the username blank during first-time setup.';
#ifdef StartupProbe
  ProgressPage.ProgressBar.Style := npbstMarquee;
  ProgressPage.ProgressBar.Style := npbstNormal;
  ProgressPage.SetProgress(37, 100);
  if (PasswordPage.Values[0] <> '') or
    (PasswordPage.Values[1] <> '') or (WorkRoot = '') or NetworkAccessCheck.Checked or
    (NetworkAccessCheck.Top + NetworkAccessCheck.Height > PasswordPage.SurfaceHeight) or
    (SourceStoppedCheck.Top + SourceStoppedCheck.Height > MigrationPage.SurfaceHeight) or
    SourceStoppedCheck.Checked or (InstallModePage.SelectedValueIndex <> 0) or
    (ProgressPage.ProgressBar.Position <> 37) then
    RaiseException('Startup probe did not initialize the password page and workspace.');
  Log('ALPR_STARTUP_PROBE_PASSED');
  Abort;
#endif
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = MigrationPage.ID) and (InstallModePage.SelectedValueIndex = 0);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = PasswordPage.ID then begin
    WizardForm.NextButton.Caption := 'Install';
    if InstallModePage.SelectedValueIndex = 1 then
      WizardForm.FinishedLabel.Caption := 'Your ALPR data is ready. Existing named accounts use their existing username and password. For setup administrator login, leave the username blank and use the password chosen in Setup. Keep the source and backup until you have checked your records and images.'
    else
      WizardForm.FinishedLabel.Caption := 'Your new ALPR installation is ready. Sign in with the password you chose in Setup. Leave the username blank during first-time setup.';
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Password: String;
  I: Integer;
begin
  Result := True;
  if CurPageID = MigrationPage.ID then begin
    Result := SourceStoppedCheck.Checked and FileExists(MigrationPage.Values[0] + '\migration-backup.json');
    if not Result then MsgBox('Choose a completed ALPR migration backup and pause ingestion on the old installation.', mbError, MB_OK);
    Exit;
  end;
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
    ProgressPage.ProgressBar.Style := npbstMarquee;
    if InstallModePage.SelectedValueIndex = 1 then
      ProgressPage.SetText(Copy(S, 21, Length(S)), 'Your migration backup and original data are preserved.')
    else
      ProgressPage.SetText(Copy(S, 21, Length(S)), 'Starting with an empty database and new settings.');
    WizardForm.PreparingMemo.Lines.Text := Copy(S, 21, Length(S));
    WizardForm.StatusLabel.Caption := Copy(S, 21, Length(S));
    WizardForm.Refresh;
  end;
  if Pos('ALPR_SETUP_PERCENT:', S) = 1 then begin
    ProgressPage.ProgressBar.Style := npbstNormal;
    ProgressPage.SetProgress(StrToIntDef(Copy(S, 20, Length(S)), 0), 100);
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
  if (Operation = 'prepare') and NetworkAccessCheck.Checked then
    Parameters := Parameters + ' -ListenOnNetwork';
  if (Operation = 'prepare') and (InstallModePage.SelectedValueIndex = 1) then
    Parameters := Parameters + ' -MigrationBackup "' + MigrationPage.Values[0] + '"';
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
  ProgressPage.SetProgress(0, 100);
  ProgressPage.ProgressBar.Style := npbstMarquee;
  ProgressPage.SetText('Preparing the application files…', '');
  ProgressPage.Show;
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
    ProgressPage.Hide;
    InstallationRunning := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep <> ssInstall then Exit;
  InstallationRunning := True;
  ProgressPage.SetProgress(0, 100);
  ProgressPage.ProgressBar.Style := npbstMarquee;
  ProgressPage.SetText('Installing ALPR…', '');
  ProgressPage.Show;
  try
    if not Prepared or not RunSetupOperation('install', ResultCode) or (ResultCode <> 0) then begin
      if LastError = '' then LastError := 'ALPR could not finish installing.';
      RaiseException(LastError + #13#10 + 'Its data has been preserved. Setup log: ' + ExpandConstant('{log}'));
    end;
  finally
    ProgressPage.Hide;
    InstallationRunning := False;
  end;
end;

procedure UninstallOutput(const S: String; const Error, FirstLine: Boolean);
begin
  Log(S);
  if Pos('ALPR_SETUP_PROGRESS:', S) = 1 then begin
    UninstallProgressForm.StatusLabel.Caption := Copy(S, 21, Length(S));
    UninstallProgressForm.Refresh;
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
    UninstallProgressForm.ProgressBar.Style := npbstMarquee;
    UninstallProgressForm.StatusLabel.Caption := 'Stopping ALPR and preserving your data…';
    if not ExecAndLogOutput(Powershell, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\Uninstall.ps1') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode, @UninstallOutput) or (ResultCode <> 0) then
      RaiseException('ALPR services could not be removed. Application files and data have been preserved.');
    UninstallProgressForm.StatusLabel.Caption := 'Removing program files. Your plate records and images are preserved…';
  end;
  if CurUninstallStep = usPostUninstall then begin
    UninstallProgressForm.ProgressBar.Style := npbstNormal;
    UninstallProgressForm.ProgressBar.Position := UninstallProgressForm.ProgressBar.Max;
  end;
  if CurUninstallStep = usDone then
    MsgBox('ALPR has been removed. Your plate records, images, settings and backups are kept in ProgramData for recovery.', mbInformation, MB_OK);
end;
