#requires -Version 5.1
param()
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-STA','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $PSCommandPath + '"'))
    exit
}
. (Join-Path $PSScriptRoot 'Setup-Helpers.ps1')
Add-Type -AssemblyName System.Windows.Forms
$form = $null
try {
    Assert-SetupHost
    $root = Assert-SetupDirectory "$env:ProgramFiles\ALPR Community"
    if ([IO.Path]::GetFullPath($PSScriptRoot) -ne (Join-Path $root 'host')) { throw 'Run the installed ALPR Migration Backup shortcut' }
    $choice = [Windows.Forms.MessageBox]::Show('ALPR will pause briefly while it makes a verified copy of your database, images and settings, then restart. Choose a local folder for the backup.','ALPR Migration Backup','OKCancel','Information')
    if ($choice -ne 'OK') { exit }
    $dialog = New-Object Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Choose where to save your ALPR migration backup'
    if ($dialog.ShowDialog() -ne 'OK') { exit }
    $parent = Join-Path (Assert-SetupDirectory $dialog.SelectedPath) 'ALPR Migration Backups'
    Protect-SetupDirectory $parent
    $destination = Join-Path $parent ('ALPR-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
    $logRoot = Join-Path "$env:ProgramData\ALPR Community\management" ('migration-log-' + [Guid]::NewGuid().ToString('N'))
    Protect-SetupDirectory $logRoot
    $env:ALPR_WINDOWS_INSTALLATION = Join-Path $root 'installation.json'
    $installation = Get-Content -Raw -LiteralPath $env:ALPR_WINDOWS_INSTALLATION | ConvertFrom-Json
    if ($installation.installRoot -ne $root -or $installation.profile -ne 'windows-native' -or
        $installation.current -notmatch '^\d+\.\d+\.\d+-[0-9a-f]{12}$') { throw 'Invalid protected ALPR installation' }
    # Migration dependencies live beside the selected release's app, rather
    # than beside the fixed host shortcuts copied during initial installation.
    $release = Assert-SetupDirectory (Join-Path $root ('releases\' + $installation.current))
    $form = New-Object Windows.Forms.Form
    $form.Text = 'ALPR Migration Backup'; $form.Width = 540; $form.Height = 170
    $form.StartPosition = 'CenterScreen'; $form.ControlBox = $false
    $label = New-Object Windows.Forms.Label
    $label.Text = 'Creating and verifying your backup. ALPR will restart when this finishes.'
    $label.SetBounds(20,20,480,45)
    $bar = New-Object Windows.Forms.ProgressBar
    $bar.SetBounds(20,75,480,20); $bar.Style = 'Marquee'; $bar.MarqueeAnimationSpeed = 30
    $form.Controls.AddRange(@($label,$bar)); $form.Show()
    $arguments = @(('"' + (Join-Path $release 'host\windows-migration.mjs') + '"'),'export',('"' + $destination + '"'))
    $process = Start-Process -FilePath (Join-Path $release 'runtime\node.exe') -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'output.log') -RedirectStandardError (Join-Path $logRoot 'error.log')
    while (-not $process.HasExited) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 200; $process.Refresh() }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "The backup could not complete. Your source data is preserved. Keep the diagnostic log: $logRoot" }
    $form.Close(); $form = $null
    [void][Windows.Forms.MessageBox]::Show("Your verified backup is ready:`r`n$destination`r`n`r`nCopy this entire folder to the new computer. In ALPR Setup, choose Move an existing ALPR database and images.",'ALPR Migration Backup','OK','Information')
} catch {
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'ALPR Migration Backup','OK','Error')
} finally { if ($form) { $form.Close() } }
