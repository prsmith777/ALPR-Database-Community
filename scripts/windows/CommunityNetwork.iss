#ifndef OutputRoot
  #error OutputRoot is required
#endif
#ifndef OutputName
  #error OutputName is required
#endif
#ifndef PackageVersion
  #define PackageVersion "0.1.46"
#endif
#ifndef PreviousUninstallerSha256
  #define PreviousUninstallerSha256 "0000000000000000000000000000000000000000000000000000000000000000"
#endif

[Setup]
AppId={{C16EE1EB-3CB8-432E-8470-33FD80BB47C5}
AppName=ALPR Community Network Access
AppVersion={#PackageVersion}
DefaultDirName={tmp}\ALPR Network Access
CreateAppDir=no
Uninstallable=no
#ifdef StartupProbe
PrivilegesRequired=lowest
#else
PrivilegesRequired=admin
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
OutputDir={#OutputRoot}
OutputBaseFilename={#OutputName}
CloseApplications=no
RestartApplications=no
SetupLogging=yes

#ifndef StartupProbe
[Files]
Source: "Network.ps1"; Flags: dontcopy
Source: "Network-Helpers.ps1"; Flags: dontcopy
Source: "Setup-Helpers.ps1"; Flags: dontcopy
Source: "Uninstall.ps1"; Flags: dontcopy
#endif

[Code]
var
  AccessPage: TInputOptionWizardPage;
  Applied: Boolean;
  LastError, NetworkURLs: String;

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
  AccessPage := CreateInputOptionPage(wpWelcome, 'ALPR network access', 'Choose who can connect',
    'ALPR will briefly restart to apply your choice. Your existing password and stored data stay in place.', True, False);
  AccessPage.Add('Allow other computers and cameras on my local network');
  AccessPage.Add('Only this computer');
  AccessPage.SelectedValueIndex := 0;
#ifdef StartupProbe
  if (AccessPage.Values[0] <> True) or (AccessPage.Values[1] <> False) then RaiseException('Network choices did not initialize.');
  Log('ALPR_STARTUP_PROBE_PASSED');
  Abort;
#endif
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = AccessPage.ID then WizardForm.NextButton.Caption := 'Apply';
end;

procedure NetworkOutput(const S: String; const Error, FirstLine: Boolean);
begin
  Log(S);
  if Pos('ALPR_SETUP_ERROR:', S) = 1 then LastError := Copy(S, 18, Length(S));
  if Pos('ALPR_NETWORK_URL:', S) = 1 then NetworkURLs := NetworkURLs + Copy(S, 18, Length(S)) + #13#10;
  if Pos('ALPR_SETUP_PROGRESS:', S) = 1 then begin
    WizardForm.PreparingMemo.Lines.Text := Copy(S, 21, Length(S));
    WizardForm.Refresh;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Parameters, Operation: String; ResultCode: Integer;
begin
  Result := '';
  if Applied then Exit;
  ExtractTemporaryFile('Network.ps1');
  ExtractTemporaryFile('Network-Helpers.ps1');
  ExtractTemporaryFile('Setup-Helpers.ps1');
  ExtractTemporaryFile('Uninstall.ps1');
  Operation := 'disable';
  if AccessPage.Values[0] then Operation := 'enable';
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\Network.ps1') +
    '" -Operation ' + Operation + ' -ExpectedUninstallerSha256 {#PreviousUninstallerSha256}';
  if not ExecAndLogOutput(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Parameters, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode, @NetworkOutput) then Result := 'Windows could not start the network access tool.'
  else if ResultCode <> 0 then begin
    Result := LastError;
    if Result = '' then Result := 'Network access could not be changed. Contact the maintainer.';
    Result := Result + #13#10#13#10 + 'Support log: ' + ExpandConstant('{log}');
  end else begin
    Applied := True;
    if Operation = 'enable' then
      WizardForm.FinishedLabel.Caption := 'Local network access is enabled. Open one of these addresses on your other device and sign in with your existing ALPR password:'#13#10#13#10 + NetworkURLs
    else WizardForm.FinishedLabel.Caption := 'ALPR is now available only on this computer at http://localhost:3000.';
  end;
end;
