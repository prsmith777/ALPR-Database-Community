# Set strict mode and error handling
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Script version
$Script:VERSION = 2

# Output functions
function Write-MessageWithColor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Message,
        
        [Parameter()]
        [ConsoleColor]$ForegroundColor = [ConsoleColor]::White,
        
        [Parameter()]
        [switch]$NoNewline
    )
    
    Write-Host $Message -ForegroundColor $ForegroundColor -NoNewline:$NoNewline
}

function Write-LogEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet("INFO", "SUCCESS", "WARNING", "ERROR")]
        [string]$Level,
        
        [Parameter(Mandatory)]
        [string]$Message
    )
    
    $color = switch ($Level) {
        "INFO" { [ConsoleColor]::Cyan }
        "SUCCESS" { [ConsoleColor]::Green }
        "WARNING" { [ConsoleColor]::Yellow }
        "ERROR" { [ConsoleColor]::Red }
    }
    
    Write-MessageWithColor -Message "[$Level] " -ForegroundColor $color
    Write-Host $Message
}

# Function to get either docker compose or docker-compose command
function Get-DockerComposeCommand {
    try {
        $null = docker compose version 2>$null
        return "docker compose"
    }
    catch {
        try {
            $null = docker-compose version 2>$null
            return "docker-compose"
        }
        catch {
            Write-LogEntry -Level ERROR -Message "Neither 'docker compose' nor 'docker-compose' commands are working."
            Write-LogEntry -Level ERROR -Message "Please ensure Docker Compose is properly installed."
            exit 1
        }
    }
}

# Function to normalize compose file for comparison
function Get-ComposeStructure {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath
    )
    
    $content = Get-Content -Path $FilePath -Raw
    
    # Normalize line endings
    $content = $content.Replace("`r`n", "`n")
    
    # Remove all empty lines and comments
    $content = ($content -split "`n" | Where-Object { $_ -and -not $_.TrimStart().StartsWith('#') }) -join "`n"
    
    # Normalize environment variables
    $content = $content -replace '(ADMIN|DB|POSTGRES)_PASSWORD=["'']?[^"''\s]*["'']?', '$1_PASSWORD=placeholder'
    $content = $content -replace 'TZ=["'']?[^"''\s]*["'']?', 'TZ=placeholder'
    
    # Normalize ports
    $content = $content -replace '"?(?:127\.0\.0\.1:)?\d+:\d+"?', 'port:port'
    
    # Normalize DB host settings
    $content = $content -replace 'DB_HOST=["'']?[^"''\s]*["'']?', 'DB_HOST=placeholder'
    
    # Normalize image tags
    $content = $content -replace ':(latest|nightly|dev|\d+\.\d+\.\d+)', ':VERSION'
    
    # Extract only the structure (services, volumes, networks)
    $yamlStructure = @()
    $inService = $false
    
    foreach ($line in $content -split "`n") {
        if ($line -match '^services:|^volumes:|^networks:') {
            $inService = $true
            $yamlStructure += $line
            continue
        }
        
        if ($inService -and $line -match '^\s+\w+:') {
            $yamlStructure += $line
        }
    }
    
    return ($yamlStructure -join "`n")
}

function Get-LegacyComposeValue {
    param(
        [Parameter(Mandatory)][string]$Pattern,
        [Parameter(Mandatory)][string]$Content
    )
    if ($Content -match $Pattern) {
        return $matches[1].Trim()
    }
    return $null
}

function ConvertTo-DotEnvValue {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value.Contains("'") -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw "Automatic migration cannot encode a password containing a single quote or line break. Create .env manually from .env.example."
    }
    return "'$Value'"
}

function Write-MigratedEnvironment {
    param([Parameter(Mandatory)][string]$ComposeContent)

    if (Test-Path ".env") {
        Write-LogEntry -Level INFO -Message "Keeping existing .env configuration."
        return
    }

    $adminPassword = Get-LegacyComposeValue -Pattern 'ADMIN_PASSWORD=([^#\r\n]*)' -Content $ComposeContent
    $dbPassword = Get-LegacyComposeValue -Pattern 'DB_PASSWORD=([^#\r\n]*)' -Content $ComposeContent
    if (-not $dbPassword) {
        $dbPassword = Get-LegacyComposeValue -Pattern 'POSTGRES_PASSWORD=([^#\r\n]*)' -Content $ComposeContent
    }
    if (-not $adminPassword -or -not $dbPassword) {
        throw "Could not migrate existing passwords. Create .env from .env.example before updating."
    }

    $timezone = Get-LegacyComposeValue -Pattern 'TZ=([^#\r\n]*)' -Content $ComposeContent
    $appPort = Get-LegacyComposeValue -Pattern '"(?:127\.0\.0\.1:)?(\d+):3000"' -Content $ComposeContent
    $dbPort = Get-LegacyComposeValue -Pattern '"(?:127\.0\.0\.1:)?(\d+):5432"' -Content $ComposeContent
    if (-not $timezone) { $timezone = "America/Los_Angeles" }
    if (-not $appPort) { $appPort = "3000" }
    if (-not $dbPort) { $dbPort = "5432" }

    $lines = @(
        "ADMIN_PASSWORD=$(ConvertTo-DotEnvValue $adminPassword)"
        "DB_PASSWORD=$(ConvertTo-DotEnvValue $dbPassword)"
        "SESSION_COOKIE_SECURE=false"
        "TZ=$(ConvertTo-DotEnvValue $timezone)"
        "APP_PORT=$(ConvertTo-DotEnvValue $appPort)"
        "DB_PORT=$(ConvertTo-DotEnvValue $dbPort)"
        ""
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), ($lines -join "`n"), $utf8NoBom)
    Write-LogEntry -Level SUCCESS -Message "Existing configuration migrated to .env."
}

function Test-ComposeConfiguration {
    if ((Get-DockerComposeCommand) -eq "docker compose") {
        docker compose config | Out-Null
    }
    else {
        docker-compose config | Out-Null
    }
    return $LASTEXITCODE -eq 0
}

# Function to download files
function Get-RequiredFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Url,
        
        [Parameter(Mandatory)]
        [string]$OutputFile
    )
    
    try {
        $ProgressPreference = 'SilentlyContinue'  # Speeds up download
        Invoke-WebRequest -Uri $Url -OutFile $OutputFile -UseBasicParsing
        Write-LogEntry -Level SUCCESS -Message "Downloaded: $OutputFile"
    }
    catch {
        Write-LogEntry -Level ERROR -Message "Failed to download $OutputFile from $Url"
        throw
    }
}

# Main update function
function Update-ALPRDatabase {
    # Display header
    Write-MessageWithColor "`n=========================================" -ForegroundColor Cyan
    Write-MessageWithColor "`n   ALPR Database Update Script" -ForegroundColor Cyan
    Write-MessageWithColor "`n=========================================`n" -ForegroundColor Cyan
    
    # Display main menu
    Write-Host "What would you like to do?"
    Write-Host "1) Update"
    Write-Host "2) Revert to a previous version`n"
    
    $choice = Read-Host "Enter your choice (1-2)"
    
    switch ($choice) {
        "1" {
            # Update path
            Write-Host "`nSelect release type:"
            Write-Host "1) Stable (recommended)"
            Write-Host "2) Nightly (pre-release / latest updates)`n"
            
            $releaseType = Read-Host "Enter your choice (1-2)"
            
            # Set branch based on release type
            $branch = if ($releaseType -eq "1") { "main" } else { "dev" }
            $imageTag = if ($releaseType -eq "1") { "latest" } else { "nightly" }
            
            # Check for script updates first
            Write-LogEntry -Level INFO -Message "Checking for script updates..."
            $remoteScriptUrl = "https://raw.githubusercontent.com/algertc/ALPR-Database/$branch/update.ps1"
            
            try {
                $remoteScript = (Invoke-WebRequest -Uri $remoteScriptUrl -UseBasicParsing).Content
                if ($remoteScript -match '\$Script:VERSION\s*=\s*(\d+)') {
                    $remoteVersion = [int]$matches[1]
                    if ($remoteVersion -gt $Script:VERSION) {
                        Write-LogEntry -Level INFO -Message "A new version of the update script is available."
                        Write-LogEntry -Level INFO -Message "Downloading and executing new version..."
                        Get-RequiredFile -Url $remoteScriptUrl -OutputFile "update_new.ps1"
                        & .\update_new.ps1
                        exit
                    }
                }
            }
            catch {
                Write-LogEntry -Level INFO -Message "No script updates found."
            }
            
            # Verify required directories exist
            Write-LogEntry -Level INFO -Message "Checking required directories..."
            "auth", "config", "storage" | ForEach-Object {
                if (-not (Test-Path $_)) {
                    New-Item -ItemType Directory -Force -Path $_
                }
            }
            Write-LogEntry -Level SUCCESS -Message "Directory structure verified!"
            
            # Check for compose file updates
            Write-LogEntry -Level INFO -Message "Checking for compose file updates..."
            $remoteComposeUrl = "https://raw.githubusercontent.com/algertc/ALPR-Database/$branch/docker-compose.yml"
            
            if (Test-Path "docker-compose.yml") {
                # Download remote compose file
                Get-RequiredFile -Url $remoteComposeUrl -OutputFile "docker-compose.remote.yml"
                
                # Compare structural changes only
                $localStructure = Get-ComposeStructure -FilePath "docker-compose.yml"
                $remoteStructure = Get-ComposeStructure -FilePath "docker-compose.remote.yml"
                
                if ($localStructure -ne $remoteStructure) {
                    Write-LogEntry -Level WARNING -Message "Changes detected in docker-compose.yml"
                    Write-Host "`nStructural changes detected in compose file:"
                    $localLines = $localStructure -split "`n"
                    $remoteLines = $remoteStructure -split "`n"
                    
                    $differences = Compare-Object -ReferenceObject $localLines -DifferenceObject $remoteLines
                    foreach ($diff in $differences) {
                        $marker = if ($diff.SideIndicator -eq "<=") { "-" } else { "+" }
                        Write-Host "$marker $($diff.InputObject)"
                    }
                    
                    $updateCompose = Read-Host "`n*IMPORTANT - PLEASE READ*  This update required a modification to the docker-compose file. It looks like your compose file is missing this change. The script will attempt to insert this change into your docker-compose.yml file automatically. If you encounter any issues after updating, you may need to manually compare your file against the file in the repository and ensure everything is up to date. Would you like to automatically update your compose file with the latest changes? Your configuration will be kept (y/n)"
                    
                    if ($updateCompose -eq "y") {
                        # Update image tag based on release type
                        $composeContent = Get-Content "docker-compose.remote.yml" -Raw
                        $composeContent = $composeContent -replace ':latest', ":$imageTag"
                        
                        # Migrate legacy inline configuration before replacing the template.
                        $currentCompose = Get-Content "docker-compose.yml" -Raw
                        Write-MigratedEnvironment -ComposeContent $currentCompose
                        Copy-Item "docker-compose.yml" "docker-compose.yml.pre-env-migration" -Force
                        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
                        [System.IO.File]::WriteAllText(
                            (Join-Path (Get-Location) "docker-compose.yml"),
                            $composeContent,
                            $utf8NoBom
                        )
                        if (Test-ComposeConfiguration) {
                            Remove-Item "docker-compose.yml.pre-env-migration" -Force
                            Write-LogEntry -Level SUCCESS -Message "Compose file updated successfully!"
                        }
                        else {
                            Move-Item "docker-compose.yml.pre-env-migration" "docker-compose.yml" -Force
                            throw "The new Compose configuration was invalid; the original file was restored."
                        }
                    }
                }
                
                # Cleanup temporary files
                Remove-Item -Force "docker-compose.remote.yml" -ErrorAction SilentlyContinue
            }
            else {
                Write-LogEntry -Level ERROR -Message "No docker-compose.yml found in current directory!"
                exit 1
            }
            
            # Update migrations file
            Write-LogEntry -Level INFO -Message "Updating migrations file..."
            Get-RequiredFile -Url "https://raw.githubusercontent.com/algertc/ALPR-Database/$branch/migrations.sql" -OutputFile "migrations.sql"
            Write-LogEntry -Level SUCCESS -Message "Migrations file updated!"
            
            # Get appropriate docker compose command
            $dockerComposeCmd = Get-DockerComposeCommand
            
            # Stop running containers
            Write-LogEntry -Level INFO -Message "Stopping running containers..."
            Invoke-Expression "$dockerComposeCmd down"
            
            # Pull latest images
            Write-LogEntry -Level INFO -Message "Pulling latest images..."
            Invoke-Expression "$dockerComposeCmd pull"
            
            # Start containers
            Write-LogEntry -Level INFO -Message "Starting updated containers..."
            Invoke-Expression "$dockerComposeCmd up -d"
            
            Write-LogEntry -Level SUCCESS -Message "Update completed successfully!"
        }
        
        "2" {
            Write-LogEntry -Level WARNING -Message "Restore functionality will be available in a future update."
            exit 0
        }
        
        default {
            Write-LogEntry -Level ERROR -Message "Invalid choice. Please try again."
            exit 1
        }
    }
}

# Run update
Update-ALPRDatabase
