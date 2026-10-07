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

#ifndef PackageChannel
  #define PackageChannel "preview"
#endif
#if PackageChannel == "preview"
  #define ChannelNotice "This is a development preview for testing."
#else
  #define ChannelNotice "Setup keeps your ALPR data separate from the program files."
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
Name: "{commonprograms}\ALPR Database Community"; Filename: "{code:GetOpenAlprUrl}"; Comment: "Open ALPR Database Community"
Name: "{commonprograms}\ALPR Migration Backup"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{autopf}\ALPR Community\host\ExportMigration.ps1"""; Comment: "Make a verified ALPR backup for another computer"
Name: "{commondesktop}\ALPR Database Community"; Filename: "{code:GetOpenAlprUrl}"; Comment: "Open ALPR Database Community"

[Run]
Filename: "{code:GetOpenAlprUrl}"; Description: "Open ALPR"; Flags: postinstall shellexec runasoriginaluser skipifsilent

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
  PortsPage: TInputQueryWizardPage;
  InstalledAppPort: Integer;
  SourceStoppedCheck: TNewCheckBox;
  ProgressPage: TOutputProgressWizardPage;
  NetworkAccessCheck: TNewCheckBox;
  WorkRoot: String;
  Prepared: Boolean;
  InstallationVerified: Boolean;
  OperationComplete: Boolean;
  InstallationRunning: Boolean;
  LastError: String;

function GetTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall';

function Powershell: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function ParseSetupPort(Value: String): Integer;
var
  I: Integer;
begin
  Result := -1;
  if (Length(Value) < 4) or (Length(Value) > 5) then Exit;
  for I := 1 to Length(Value) do
    if (Value[I] < '0') or (Value[I] > '9') then Exit;
  I := StrToIntDef(Value, -1);
  if (I >= 1024) and (I <= 65535) then Result := I;
end;

function GetOpenAlprUrl(Param: String): String;
begin
  if InstalledAppPort < 1024 then RaiseException('The installed ALPR address has not been verified.');
  Result := 'http://localhost:' + IntToStr(InstalledAppPort);
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

function ShouldSkipPage(PageID: Integer): Boolean; forward;

procedure InitializeWizard;
begin
  InstallModePage := CreateInputOptionPage(wpWelcome, 'Set up ALPR', 'Choose how to start',
    'Create a new installation, move a verified backup, or restore data kept after uninstalling ALPR.', True, False);
  InstallModePage.Add('Start with an empty database');
  InstallModePage.Add('Move an existing ALPR database and images');
  InstallModePage.Add('Restore the ALPR data already on this computer');
  InstallModePage.Add('Update ALPR already installed on this computer');
  InstallModePage.SelectedValueIndex := 0;
#ifndef StartupProbe
  if FileExists(ExpandConstant('{autopf}\ALPR Community\installation.json')) then
    InstallModePage.SelectedValueIndex := 3;
  if FileExists(ExpandConstant('{commonappdata}\ALPR Community\management\uninstalled-installation.json')) and
    not FileExists(ExpandConstant('{autopf}\ALPR Community\installation.json')) then
    InstallModePage.SelectedValueIndex := 2;
#endif
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
  PortsPage := CreateInputQueryPage(MigrationPage.ID, 'Connection ports',
    'Choose how to connect to this installation',
    'If the old ALPR uses port 3000 on this computer, use 3001 below to keep it running. Browser access and Blue Iris use the application port.'#13#10#13#10 +
    'Community creates its own PostgreSQL 17 database. The local database port is separate from your Docker database; normally keep 5433. Setup checks both ports before installing.');
  PortsPage.Add('Application port (browser and Blue Iris):', False);
  PortsPage.Add('Local database port (normally 5433):', False);
  PortsPage.Values[0] := '3000';
  PortsPage.Values[1] := '5433';
  PasswordPage := CreateInputQueryPage(PortsPage.ID, 'Install ALPR Database Community',
    'Choose your administrator password',
    'You will use this password to sign in to ALPR. Setup downloads the required components and starts ALPR automatically. An internet connection is required.'#13#10#13#10 +
    'For migration, this replaces the old setup administrator password. Existing named accounts keep their passwords.'#13#10 +
    '{#ChannelNotice}');
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
  if (ParseSetupPort('3001') <> 3001) or (ParseSetupPort('65535') <> 65535) or
    (ParseSetupPort('1023') <> -1) or (ParseSetupPort('65536') <> -1) or
    (ParseSetupPort('3e03') <> -1) or (ParseSetupPort('+3000') <> -1) or
    (PortsPage.Values[0] <> '3000') or (PortsPage.Values[1] <> '5433') or
    (PortsPage.Edits[1].Top + PortsPage.Edits[1].Height > PortsPage.SurfaceHeight) then
    RaiseException('Connection port controls or validation failed.');
  InstalledAppPort := 3001;
  if GetOpenAlprUrl('') <> 'http://localhost:3001' then RaiseException('Custom port URL was lost.');
  InstalledAppPort := 0;
  if (PasswordPage.Values[0] <> '') or
    (PasswordPage.Values[1] <> '') or (WorkRoot = '') or NetworkAccessCheck.Checked or
    (NetworkAccessCheck.Top + NetworkAccessCheck.Height > PasswordPage.SurfaceHeight) or
    (SourceStoppedCheck.Top + SourceStoppedCheck.Height > MigrationPage.SurfaceHeight) or
    SourceStoppedCheck.Checked or (InstallModePage.SelectedValueIndex <> 0) or
    (ProgressPage.ProgressBar.Position <> 37) then
    RaiseException('Startup probe did not initialize the password page and workspace.');
  InstallModePage.SelectedValueIndex := 1;
  if ShouldSkipPage(MigrationPage.ID) or ShouldSkipPage(PortsPage.ID) or ShouldSkipPage(PasswordPage.ID) then
    RaiseException('Migration pages are missing.');
  InstallModePage.SelectedValueIndex := 2;
  if not ShouldSkipPage(MigrationPage.ID) or not ShouldSkipPage(PortsPage.ID) or not ShouldSkipPage(PasswordPage.ID) then
    RaiseException('Retained recovery must keep the existing password and skip migration selection.');
  InstallModePage.SelectedValueIndex := 3;
  if not ShouldSkipPage(MigrationPage.ID) or not ShouldSkipPage(PortsPage.ID) or not ShouldSkipPage(PasswordPage.ID) then
    RaiseException('An existing installation update must preserve its password and skip migration selection.');
  InstallModePage.SelectedValueIndex := 0;
  Log('ALPR_STARTUP_PROBE_PASSED');
  Abort;
#endif
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := ((PageID = MigrationPage.ID) and (InstallModePage.SelectedValueIndex <> 1)) or
    (((PageID = PortsPage.ID) or (PageID = PasswordPage.ID)) and ((InstallModePage.SelectedValueIndex = 2) or (InstallModePage.SelectedValueIndex = 3)));
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = InstallModePage.ID) and (InstallModePage.SelectedValueIndex = 2) then
    WizardForm.FinishedLabel.Caption := 'ALPR is ready. Your existing records, images, settings, API key and passwords have been kept. Sign in with your existing ALPR password.';
  if (CurPageID = InstallModePage.ID) and (InstallModePage.SelectedValueIndex = 3) then
    WizardForm.FinishedLabel.Caption := 'ALPR was updated. Your records, images, settings, API key and passwords have been kept. Sign in with your existing password and finish the checks in Settings > Software Updates. Future updates can be installed there.';
  if CurPageID = PasswordPage.ID then begin
    WizardForm.NextButton.Caption := 'Install';
    if InstallModePage.SelectedValueIndex = 1 then
      WizardForm.FinishedLabel.Caption := 'Your ALPR data is ready. Existing named accounts use their existing username and password. For setup administrator login, leave the username blank and use the password chosen in Setup. Keep the source and backup until you have checked your records and images.'
    else
      WizardForm.FinishedLabel.Caption := 'Your new ALPR installation is ready. Sign in with the password you chose in Setup. Leave the username blank during first-time setup.';
  end;
end;

function RunSetupOperation(Operation: String; var ResultCode: Integer): Boolean; forward;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Password: String;
  I, ResultCode: Integer;
begin
  Result := True;
  if CurPageID = MigrationPage.ID then begin
    Result := SourceStoppedCheck.Checked and FileExists(MigrationPage.Values[0] + '\migration-backup.json');
    if not Result then MsgBox('Choose a completed ALPR migration backup and pause ingestion on the old installation.', mbError, MB_OK);
    Exit;
  end;
  if CurPageID = PortsPage.ID then begin
    Result := (ParseSetupPort(PortsPage.Values[0]) > 0) and
      (ParseSetupPort(PortsPage.Values[1]) > 0) and
      (StrToIntDef(PortsPage.Values[0], -1) <> StrToIntDef(PortsPage.Values[1], -1));
    if not Result then begin
      MsgBox('Enter different whole-number ports between 1024 and 65535.', mbError, MB_OK);
      Exit;
    end;
    ExtractTemporaryFile('Setup.ps1');
    ExtractTemporaryFile('Setup-Helpers.ps1');
    Result := RunSetupOperation('check-ports', ResultCode) and (ResultCode = 0) and (LastError = '');
    if not Result then begin
      if LastError = '' then LastError := 'Setup could not check the connection ports. Keep the setup log for support.';
      MsgBox(LastError, mbError, MB_OK);
    end;
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
  if Error then LastError := 'Setup could not read the maintenance result.';
  if S = 'ALPR_SETUP_COMPLETE:verified' then OperationComplete := True;
  if Pos('ALPR_SETUP_PORT:', S) = 1 then
    InstalledAppPort := ParseSetupPort(Copy(S, 17, Length(S)));
  if Pos('ALPR_SETUP_ERROR:', S) = 1 then
    LastError := Copy(S, 18, Length(S));
  if Pos('ALPR_SETUP_PROGRESS:', S) = 1 then begin
    ProgressPage.ProgressBar.Style := npbstMarquee;
    if (InstallModePage.SelectedValueIndex = 2) or (InstallModePage.SelectedValueIndex = 3) then
      ProgressPage.SetText(Copy(S, 21, Length(S)), 'Keeping your existing passwords, API key, records, images and settings.')
    else if InstallModePage.SelectedValueIndex = 1 then
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
  OperationComplete := False;
  if Operation = 'install' then InstalledAppPort := 0;
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\Setup.ps1') + '" -Operation ' + Operation +
    ' -WorkRoot "' + WorkRoot + '"';
  if Operation = 'prepare' then
    Parameters := Parameters + ' -PackageRoot "' + ExpandConstant('{tmp}\payload') +
      '" -ManifestSha256 {#ManifestSha256}';
  if ((Operation = 'prepare') or (Operation = 'check-ports')) and
    (InstallModePage.SelectedValueIndex < 2) then
    Parameters := Parameters + ' -AppPort ' + IntToStr(ParseSetupPort(PortsPage.Values[0])) +
      ' -DatabasePort ' + IntToStr(ParseSetupPort(PortsPage.Values[1]));
  if InstallModePage.SelectedValueIndex = 2 then
    Parameters := Parameters + ' -ReuseRetainedData';
  if InstallModePage.SelectedValueIndex = 3 then
    Parameters := Parameters + ' -UpdateExisting';
  if (Operation = 'prepare') and NetworkAccessCheck.Checked and (InstallModePage.SelectedValueIndex <> 2) then
    Parameters := Parameters + ' -ListenOnNetwork';
  if (Operation = 'prepare') and (InstallModePage.SelectedValueIndex = 1) then
    Parameters := Parameters + ' -MigrationBackup "' + MigrationPage.Values[0] + '"';
  Result := ExecAndLogOutput(Powershell, Parameters, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode, @SetupOutput);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Launched: Boolean;
begin
  Result := '';
  if InstallationVerified then Exit;
  InstallationRunning := True;
  ProgressPage.SetProgress(0, 100);
  ProgressPage.ProgressBar.Style := npbstMarquee;
  ProgressPage.SetText('Preparing ALPR…', '');
  ProgressPage.Show;
  try
    if not Prepared then begin
      ExtractTemporaryFile('Setup.ps1');
      ExtractTemporaryFile('Setup-Helpers.ps1');
      ExtractTemporaryFile('setup-prerequisites.json');
      ExtractTemporaryFiles('{tmp}\payload\*');
      Launched := RunSetupOperation('prepare', ResultCode);
      if not Launched then begin
        Result := 'Setup could not start. Close Setup and try again.';
        Exit;
      end;
      if ResultCode = 3010 then begin
        NeedsRestart := True;
        Result := 'Windows needs to restart to finish installing a required component. Run this installer again after restarting.';
        Exit;
      end;
      if (ResultCode <> 0) or (LastError <> '') then begin
        Result := LastError;
        if Result = '' then Result := 'Setup could not finish its checks.';
        Result := Result + #13#10 + 'Setup log: ' + ExpandConstant('{log}');
        Exit;
      end;
      if (InstallModePage.SelectedValueIndex <> 2) and (InstallModePage.SelectedValueIndex <> 3) and
        not SaveStringToFile(WorkRoot + '\administrator-password.txt', UTF8Encode(PasswordPage.Values[0]), False) then begin
        Result := 'Setup could not save the administrator password securely.';
        Exit;
      end;
      PasswordPage.Values[0] := '';
      PasswordPage.Values[1] := '';
      Prepared := True;
      PortsPage.Edits[0].Enabled := False;
      PortsPage.Edits[1].Enabled := False;
    end;
    ProgressPage.SetText('Installing and verifying ALPR…', '');
    Launched := RunSetupOperation('install', ResultCode);
    if (not Launched) or (ResultCode <> 0) or (LastError <> '') or (not OperationComplete) or (InstalledAppPort < 1024) then begin
      Result := LastError;
      if Result = '' then Result := 'ALPR could not verify the installed application. Setup has stopped.';
      Result := Result + #13#10 + 'Your data has been preserved. Close Setup and keep this log: ' + ExpandConstant('{log}');
      Exit;
    end;
    InstallationVerified := True;
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
    SuppressibleMsgBox('ALPR could not be removed safely. Application files and data have been preserved. Contact the maintainer with the uninstall log.', mbError, MB_OK, IDOK);
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
    // Inno destroys UninstallProgressForm before usPostUninstall. Restore
    // normal file-removal progress while the window still exists.
    UninstallProgressForm.ProgressBar.Style := npbstNormal;
    UninstallProgressForm.StatusLabel.Caption := 'Removing program files. Your plate records and images are preserved…';
  end;
  if CurUninstallStep = usDone then
    SuppressibleMsgBox('ALPR has been removed. Your plate records, images, settings and backups are kept in ProgramData for recovery.', mbInformation, MB_OK, IDOK);
end;
