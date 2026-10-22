#requires -Version 5.1
param([string]$PackageRoot, [string]$ResultFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'Setup-Helpers.ps1')
$form = $null
$work = $null
try {
    Assert-SetupHost
    if (-not $PackageRoot) {
        $root = Assert-SetupDirectory "$env:ProgramFiles\ALPR Community"
        $installation = Get-Content -Raw -LiteralPath (Join-Path $root 'installation.json') | ConvertFrom-Json
        if ($installation.profile -ne 'windows-native' -or $installation.installRoot -ne $root -or $installation.current -notmatch '^\d+\.\d+\.\d+-[0-9a-f]{12}$') { throw 'Invalid installed ALPR identity' }
        $PackageRoot = Join-Path $root ('releases\' + $installation.current)
    }
    $PackageRoot = Assert-SetupDirectory $PackageRoot
    $node = Join-Path $PackageRoot 'runtime\node.exe'
    $script = Join-Path $PackageRoot 'host\docker-migration-export.mjs'
    $work = Join-Path $env:LOCALAPPDATA ('ALPR Docker Export\' + [Guid]::NewGuid().ToString('N'))
    Protect-SetupDirectory (Split-Path -Parent $work)
    Protect-SetupDirectory $work
    function Invoke-Exporter([string]$Command, [object]$Request) {
        $id = [Guid]::NewGuid().ToString('N')
        $requestFile = Join-Path $work ($id + '-request.json')
        $outputFile = Join-Path $work ($id + '-result.json')
        [IO.File]::WriteAllText($requestFile, ($Request | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
        $arguments = @(('"' + $script + '"'),$Command,('"' + $requestFile + '"'),('"' + $outputFile + '"'))
        $process = Start-Process -FilePath $node -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work ($id + '-output.log')) -RedirectStandardError (Join-Path $work ($id + '-error.log'))
        $exitCode = Wait-SetupChildProcess $process { [Windows.Forms.Application]::DoEvents() }
        if ($exitCode -ne 0) {
            $detail = Get-Content -Raw -LiteralPath (Join-Path $work ($id + '-error.log'))
            throw ($detail + [Environment]::NewLine + 'Your source data is preserved. Diagnostic folder: ' + $work)
        }
        return (Get-Content -Raw -LiteralPath $outputFile | ConvertFrom-Json)
    }
    $form = New-Object Windows.Forms.Form
    $form.Text = 'Back up ALPR from Docker'
    $form.Width = 740; $form.Height = 435; $form.StartPosition = 'CenterScreen'
    $label = New-Object Windows.Forms.Label
    $label.Text = 'Reading Docker containers. Keep Docker Desktop running in Linux-container mode.'
    $label.SetBounds(20,15,680,60)
    $form.Controls.Add($label); $form.Show()
    $sources = Invoke-Exporter 'list' @{}
    $label.Text = 'Choose the ORIGINAL Docker ALPR application and its PostgreSQL container. This does not select or back up native Windows Community. Database inspection may download PostgreSQL client tools into Docker.'
    $apps = @($sources.containers | Where-Object { $_.application })
    $databases = @($sources.containers | Where-Object { $_.database })
    if ($apps.Count -eq 0 -or $databases.Count -eq 0) { throw 'No supported Docker ALPR application/database pair found. Run this on the computer that hosts the original Docker installation.' }
    $appLabel = New-Object Windows.Forms.Label; $appLabel.Text = 'Original ALPR application:'; $appLabel.SetBounds(20,85,650,22)
    $appBox = New-Object Windows.Forms.ComboBox; $appBox.DropDownStyle = 'DropDownList'; $appBox.SetBounds(20,110,680,28)
    foreach ($item in $apps) { [void]$appBox.Items.Add($item.name + ' | ' + $item.image) }
    $dbLabel = New-Object Windows.Forms.Label; $dbLabel.Text = 'Original PostgreSQL database:'; $dbLabel.SetBounds(20,150,650,22)
    $dbBox = New-Object Windows.Forms.ComboBox; $dbBox.DropDownStyle = 'DropDownList'; $dbBox.SetBounds(20,175,680,28)
    foreach ($item in $databases) { [void]$dbBox.Items.Add($item.name + ' | ' + $item.image) }
    $notice = New-Object Windows.Forms.Label; $notice.SetBounds(20,220,680,65)
    $notice.Text = 'The next step shows the source version and record count. Export pauses only the selected Docker app and restarts it afterward. Other database writers must be paused. Existing native Community data is never replaced or merged.'
    $button = New-Object Windows.Forms.Button; $button.Text = 'Review source'; $button.SetBounds(410,315,140,35); $button.DialogResult = 'OK'
    $cancel = New-Object Windows.Forms.Button; $cancel.Text = 'Cancel'; $cancel.SetBounds(565,315,130,35); $cancel.DialogResult = 'Cancel'
    $form.Controls.AddRange(@($appLabel,$appBox,$dbLabel,$dbBox,$notice,$button,$cancel))
    $button.Enabled = $false
    $appBox.Add_SelectedIndexChanged({ $button.Enabled = $appBox.SelectedIndex -ge 0 -and $dbBox.SelectedIndex -ge 0 })
    $dbBox.Add_SelectedIndexChanged({ $button.Enabled = $appBox.SelectedIndex -ge 0 -and $dbBox.SelectedIndex -ge 0 })
    $form.AcceptButton = $button; $form.CancelButton = $cancel
    # Deliberate selection prevents silently choosing an empty Community source.
    $form.Hide()
    if ($form.ShowDialog() -ne 'OK') { exit 0 }
    if ($appBox.SelectedIndex -lt 0 -or $dbBox.SelectedIndex -lt 0) { throw 'Choose both source containers, then run this tool again.' }
    $app = $apps[$appBox.SelectedIndex]; $database = $databases[$dbBox.SelectedIndex]
    $form.Controls.Clear(); $form.ControlBox = $false
    $label = New-Object Windows.Forms.Label; $label.SetBounds(20,20,680,65); $label.Text = 'Inspecting the selected Docker database. No source application has been stopped.'
    $bar = New-Object Windows.Forms.ProgressBar; $bar.SetBounds(20,95,680,22); $bar.Style = 'Marquee'
    $form.Controls.AddRange(@($label,$bar)); $form.Show()
    $request = @{appId=$app.id;databaseId=$database.id;workParent=$work}
    $preview = Invoke-Exporter 'preview' $request
    $form.Hide()
    $message = "Source application: $($app.name)`r`nDatabase container: $($database.name)`r`n$($preview.sourceLabel) on PostgreSQL $($preview.serverMajor)`r`nPlate reads: $($preview.plateReads)`r`n`r`nIs this the original database you want? Pause every OTHER database writer before continuing. ALPR will stop only this Docker application, verify the backup, then restart it."
    if ($preview.plateReads -eq '0') { $message += "`r`n`r`nWARNING: this source has ZERO plate reads. Cancel if you expected historical records." }
    if ([Windows.Forms.MessageBox]::Show($message,'Confirm original Docker source','OKCancel','Warning') -ne 'OK') { exit 0 }
    $dialog = New-Object Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Choose a private local folder for the Docker ALPR backup'
    if ($dialog.ShowDialog() -ne 'OK') { exit 0 }
    $parent = Join-Path (Assert-SetupDirectory $dialog.SelectedPath) 'ALPR Docker Migration Backups'
    Protect-SetupDirectory $parent
    $destination = Join-Path $parent ('Docker-ALPR-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
    $request = @{appId=$app.id;databaseId=$database.id;destination=$destination;confirmation=$preview.confirmation;expected=$preview;writersPaused=$true}
    $label.Text = 'Exporting and verifying database, images and settings. Keep this window open; the selected original Docker app will restart when finished.'
    $form.Show()
    $result = Invoke-Exporter 'export' $request
    $form.Close(); $form = $null
    if ($ResultFile) { [IO.File]::WriteAllText($ResultFile, $result.destination, (New-Object Text.UTF8Encoding($false))) }
    [void][Windows.Forms.MessageBox]::Show("Verified Docker backup: $($result.destination)`r`nPlate reads: $($result.plateReads)`r`n`r`nKeep the entire folder. For Windows import choose Move an existing ALPR database and images. Pause source ingestion again before importing. Existing native data cannot be merged; back it up before planning a fresh target.",'Docker backup complete','OK','Information')
} catch {
    if ($form) { $form.Close(); $form = $null }
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'Docker migration backup','OK','Error')
    exit 1
} finally { if ($form) { $form.Close() } }
