[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"


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

# Safety checks for installation location
function Test-InstallationSafety {
    [CmdletBinding()]
    param()
    
    # Define forbidden paths
    $forbiddenPaths = @(
        [System.IO.Path]::Combine($env:SystemRoot, "System32"),
        $env:SystemRoot,
        [System.IO.Path]::Combine($env:USERPROFILE, "Downloads")
    )
    
    # Check if we're in a forbidden directory
    if ($forbiddenPaths -contains $PSScriptRoot) {
        $message = if ($PSScriptRoot -eq [System.IO.Path]::Combine($env:SystemRoot, "System32")) {
            "You are running this script from System32. This is not allowed!"
        } elseif ($PSScriptRoot -eq $env:SystemRoot) {
            "You are running this script from the Windows directory. This is not allowed!"
        } else {
            "You are running this script directly from your Downloads folder. You probably don't want to do that. Please create a new directory and move the script inside it. That is where your installation will live"
        }
        
        Write-LogEntry -Level ERROR -Message $message
        return $false
    }
    
    # Count directories in current location (excluding special directories)
    $directoryCount = (Get-ChildItem -Directory | Where-Object { 
        $_.Name -notmatch '^\.' -and  # Exclude hidden directories
        $_.Name -notin @('auth', 'config', 'storage')  # Exclude directories we'll create
    } | Measure-Object).Count
    
    if ($directoryCount -gt 3) {
        Write-LogEntry -Level ERROR -Message "Oops, this probably isn't a good place to install!"
        Write-LogEntry -Level ERROR -Message "Please create a new directory and run the script from inside that new directory."
        Write-LogEntry -Level ERROR -Message "This helps keep your installation isolated and organized."
        return $false
    }
    
    return $true
}

# Run safety check before proceeding
if (-not (Test-InstallationSafety)) {
    exit 1
}

# Constants
$Script:DEFAULT_APP_PORT = 3000
$Script:DEFAULT_DB_PORT = 5432
$Script:REQUIRED_DIRECTORIES = @("auth", "config", "storage")
$Script:DOWNLOAD_URLS = @{
    Compose = "https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/docker-compose.yml"
    Schema = "https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/schema.sql"
    Migrations = "https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/migrations.sql"
    Update = "https://raw.githubusercontent.com/algertc/ALPR-Database/refs/heads/main/update.ps1"
}

$Script:TIMEZONES = [ordered]@{
    "1" = "America/Los_Angeles"
    "2" = "America/Denver"
    "3" = "America/Chicago"
    "4" = "America/New_York"
    "5" = "Europe/London"
    "6" = "Europe/Paris"
    "7" = "Asia/Tokyo"
    "8" = "Australia/Sydney"
}



# Validation functions
function Test-PortAvailable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int]$Port
    )
    
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
        $listener.Start()
        $listener.Stop()
        return $true
    }
    catch {
        return $false
    }
}

function Test-PortValid {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Port
    )
    
    if (-not [int]::TryParse($Port, [ref]$null)) { 
        return $false 
    }
    
    $portNum = [int]$Port
    return $portNum -ge 1024 -and $portNum -le 65535 -and (Test-PortAvailable -Port $portNum)
}

function Test-DockerAvailable {
    [CmdletBinding()]
    param()
    
    try {
        $null = Get-Command -Name 'docker' -ErrorAction Stop
        return $true
    }
    catch {
        return $false
    }
}

function Test-DockerRunning {
    [CmdletBinding()]
    param()
    
    try {
        $dockerDesktop = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
        if (-not $dockerDesktop) {
            Write-LogEntry -Level ERROR -Message "Docker Desktop is not running"
            return $false
        }

        $null = docker ps 2>&1
        if ($LASTEXITCODE -eq 0) {
            return $true
        }
        
        Write-LogEntry -Level ERROR -Message "Docker daemon is not responding"
        return $false
    }
    catch {
        Write-LogEntry -Level ERROR -Message "Failed to check Docker status: $_"
        return $false
    }
}

# Input handling
function Read-UserInput {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Prompt,
        
        [Parameter()]
        [string]$DefaultValue,
        
        [Parameter()]
        [scriptblock]$ValidationScript,
        
        [Parameter()]
        [string]$ErrorMessage,
        
        [Parameter()]
        [switch]$Required,
        
        [Parameter()]
        [switch]$IsPassword
    )
    
    do {
        Write-MessageWithColor -Message $Prompt -NoNewline
        
        if ($DefaultValue) {
            Write-MessageWithColor -Message " (default: $DefaultValue): " -NoNewline
        }
        elseif ($Required) {
            Write-MessageWithColor -Message " (required): " -NoNewline
        }
        else {
            Write-MessageWithColor -Message ": " -NoNewline
        }

        # Handle password input differently
        $userInput = if ($IsPassword) {
            $secureString = Read-Host -AsSecureString
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureString)
            try {
                [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
            }
            finally {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            }
        }
        else {
            Read-Host
        }

        # Empty input handling
        if ([string]::IsNullOrWhiteSpace($userInput)) {
            if ($DefaultValue) {
                $userInput = $DefaultValue
                Write-LogEntry -Level INFO -Message "Using default value: $DefaultValue"
                break
            }
            elseif ($Required) {
                Write-LogEntry -Level ERROR -Message "Input is required"
                continue
            }
        }

        # Validation
        if ($ValidationScript -and -not [string]::IsNullOrWhiteSpace($userInput)) {
            $validationResult = & $ValidationScript $userInput
            if (-not $validationResult) {
                Write-LogEntry -Level ERROR -Message $ErrorMessage
                continue
            }
        }

        break
    } while ($true)

    return $userInput
}

# File operations
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

function ConvertTo-DotEnvValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Value
    )

    if ($Value.Contains("'") -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw "Passwords cannot contain a single quote or a line break."
    }

    return "'$Value'"
}

function Write-EnvironmentFile {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Config)

    $lines = @(
        "ADMIN_PASSWORD=$(ConvertTo-DotEnvValue $Config.AdminPassword)"
        "DB_PASSWORD=$(ConvertTo-DotEnvValue $Config.DbPassword)"
        "SESSION_COOKIE_SECURE=false"
        "TZ=$(ConvertTo-DotEnvValue $Config.Timezone)"
        "APP_PORT=$(ConvertTo-DotEnvValue ([string]$Config.AppPort))"
        "DB_PORT=$(ConvertTo-DotEnvValue ([string]$Config.DbPort))"
        ""
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), ($lines -join "`n"), $utf8NoBom)
}

# Main installation function
function Install-ALPRDatabase {
    [CmdletBinding()]
    param()
    
    try {
        # Display header
        Write-MessageWithColor "`n=========================================" -ForegroundColor Cyan
        Write-MessageWithColor "`n   ALPR Database Installation Script" -ForegroundColor Cyan
        Write-MessageWithColor "`n=========================================`n" -ForegroundColor Cyan

        # Check requirements
        Write-LogEntry -Level INFO -Message "Checking system requirements..."
        
        if (-not (Test-DockerAvailable)) {
            Write-LogEntry -Level ERROR -Message "Docker is not installed. Visit https://docs.docker.com/get-docker/"
            return
        }
        
        if (-not (Test-DockerRunning)) {
            Write-LogEntry -Level ERROR -Message "Please start Docker Desktop and wait for initialization"
            return
        }
        
        Write-LogEntry -Level SUCCESS -Message "System requirements met!"

        # Create directories
        Write-LogEntry -Level INFO -Message "Creating directories..."
        foreach ($dir in $REQUIRED_DIRECTORIES) {
            $null = New-Item -ItemType Directory -Force -Path $dir
        }
        Write-LogEntry -Level SUCCESS -Message "Directories created!"

        # Download files
        Write-LogEntry -Level INFO -Message "Downloading required files..."
        foreach ($file in $DOWNLOAD_URLS.GetEnumerator()) {
            Get-RequiredFile -Url $file.Value -OutputFile ([System.IO.Path]::GetFileName($file.Value))
        }

        # Get configuration
        Write-MessageWithColor "`n=========================================" -ForegroundColor Cyan
        Write-LogEntry -Level INFO -Message "Configure installation:"
        Write-Host ""

        $config = @{
            AdminPassword = Read-UserInput -Prompt "Create an admin password to log into the web app" -Required -IsPassword `
                -ValidationScript { param($value) $value.Length -ge 12 -and -not $value.Contains("'") } `
                -ErrorMessage "Password must be at least 12 characters and cannot contain a single quote"
            DbPassword = Read-UserInput -Prompt "Create a secure password for your SQL database" -Required -IsPassword `
                -ValidationScript { param($value) $value.Length -ge 12 -and -not $value.Contains("'") } `
                -ErrorMessage "Password must be at least 12 characters and cannot contain a single quote"
        }

        # Timezone selection
        Write-Host "`nSelect your timezone:"
        $TIMEZONES.GetEnumerator() | ForEach-Object { 
            Write-Host "$($_.Key)) $($_.Value)"
        }
        Write-Host "9) Other - manual entry (Must be an official TZ formatted as COUNTRY/REGION)"

        $tzChoice = Read-UserInput -Prompt "Enter a number from the list above (1-9)" -Required
        $config.Timezone = if ($tzChoice -eq "9") {
            Read-UserInput -Prompt "Enter your timezone (e.g., America/Los_Angeles)" -Required
        }
        else {
            $TIMEZONES[$tzChoice]
        }

        Write-LogEntry -Level INFO -Message "Using timezone: $($config.Timezone)"
        Write-Host ""

        # Port configuration
        $config.AppPort = Read-UserInput `
            -Prompt "Enter the port you want to expose the application on" `
            -DefaultValue $DEFAULT_APP_PORT `
            -ValidationScript { param($port) Test-PortValid $port } `
            -ErrorMessage "Invalid port number or port is in use"

        $config.DbPort = Read-UserInput `
            -Prompt "Enter alternate Postgres port (Only change this if you already have another service running on port 5432)" `
            -DefaultValue $DEFAULT_DB_PORT `
            -ValidationScript { 
                param($port) 
                $portNum = [int]$port
                $portNum -ne $config.AppPort -and (Test-PortValid $port)
            } `
            -ErrorMessage "Invalid port, in use, or conflicts with app port"

        Write-LogEntry -Level INFO -Message "Writing configuration to .env..."
        Write-EnvironmentFile -Config $config
        Write-LogEntry -Level SUCCESS -Message "Configuration updated!"

        # Start application
        Write-LogEntry -Level INFO -Message "Starting application..."
        Write-Host ""
        
        if (Get-Command "docker" -ErrorAction SilentlyContinue) {
            if (docker compose version) {
                docker compose up -d
            }
            elseif (Get-Command "docker-compose" -ErrorAction SilentlyContinue) {
                docker-compose up -d
            }
            else {
                throw "Neither 'docker compose' nor 'docker-compose' commands are working. Please ensure Docker Compose is properly installed."
            }
        }

         if ($LASTEXITCODE -eq 0) {
            Write-LogEntry -Level SUCCESS -Message "ALPR Database has been successfully installed and started!"
            Write-MessageWithColor "`n=========================================" -ForegroundColor Green
            Write-MessageWithColor "`n Installation Complete!" -ForegroundColor Green
            Write-MessageWithColor "`n=========================================`n" -ForegroundColor Green
            
            Write-Host "Your application is now running at: " -NoNewline
            Write-MessageWithColor "http://localhost:$($config.AppPort)" -ForegroundColor Cyan
            Write-Host "`nCredentials were saved to the local .env file."
        }
        else {
            throw "Failed to start application. Check Docker logs for more details."
        }
    }
    catch {
        Write-LogEntry -Level ERROR -Message $_.Exception.Message
        Write-LogEntry -Level ERROR -Message "Installation failed. Please check the error messages above."
        return
    }
}

# Run installation
Install-ALPRDatabase
