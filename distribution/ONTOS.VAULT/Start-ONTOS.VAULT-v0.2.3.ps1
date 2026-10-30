#Requires -Version 5.1
<#
ONTOS.VAULT v0.2.3: repair the interactive CLI login path and run the
already-installed, read-only v0.2 password-health audit.

This script must be invoked IN THE EXISTING INTERACTIVE PowerShell session:
    & $scriptPath
Do not start it with another powershell.exe -File: that may discard stdin.
Master passwords and 2FA codes are entered only into official Bitwarden CLI.
No secret data is written by this launcher.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$OriginalPath = $env:Path
$OriginalSession = $env:BW_SESSION
$NewSession = $false
$BwExecutable = $null
$SessionKey = $null
$AuditProgram = Join-Path $env:LOCALAPPDATA 'Programs\ONTOS.VAULT\0.2\Invoke-OntosVault.ps1'

function Find-BitwardenCli {
    $command = Get-Command 'bw.exe' -ErrorAction SilentlyContinue
    if ($null -ne $command -and $command.CommandType -eq 'Application') {
        return [string]$command.Source
    }
    $linkPath = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bw.exe'
    if (Test-Path -LiteralPath $linkPath -PathType Leaf) { return $linkPath }
    $packages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path -LiteralPath $packages -PathType Container) {
        foreach ($d in @(Get-ChildItem -LiteralPath $packages -Directory -Filter 'Bitwarden.CLI_*' -ErrorAction SilentlyContinue)) {
            $candidate = Join-Path $d.FullName 'bw.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    return $null
}

function Read-BwStatus([string]$exe) {
    $json = (& $exe status) -join "`n"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) {
        throw 'Bitwarden CLI status failed.'
    }
    $state = ConvertFrom-Json -InputObject $json
    if ([string]$state.status -notin @('unauthenticated', 'locked', 'unlocked')) {
        throw 'Unexpected Bitwarden CLI status.'
    }
    return $state
}

function Is-SessionKey([string]$s) {
    return $s -cmatch '^[A-Za-z0-9+/=]{40,}$'
}

try {
    if (-not (Test-Path -LiteralPath $AuditProgram -PathType Leaf)) {
        throw ('ONTOS.VAULT v0.2 audit is not installed: {0}' -f $AuditProgram)
    }
    $BwExecutable = Find-BitwardenCli
    if ([string]::IsNullOrWhiteSpace($BwExecutable)) {
        throw 'Bitwarden CLI not found. The prior winget installation must be checked.'
    }
    $env:Path = (Split-Path -Parent $BwExecutable) + ';' + $env:Path
    Write-Host 'ONTOS.VAULT v0.2.3 - interactive login repair' -ForegroundColor Cyan
    Write-Host ('Official Bitwarden CLI: {0}' -f $BwExecutable)
    & $BwExecutable --version
    if ($LASTEXITCODE -ne 0) { throw 'Official CLI executable failed to run.' }

    $state = Read-BwStatus $BwExecutable
    Write-Host ('CLI status: {0}' -f $state.status)
    if ($state.status -eq 'unauthenticated') {
        if ([string]::IsNullOrWhiteSpace($state.serverUrl)) {
            Write-Host 'Server: Bitwarden default. If your account is on vault.bitwarden.eu, configure it before login.' -ForegroundColor DarkYellow
        } else {
            Write-Host ('Server: {0}' -f $state.serverUrl)
        }
        $email = (Read-Host 'Email for your Bitwarden vault').Trim()
        if ([string]::IsNullOrWhiteSpace($email)) { throw 'Email is required; no login attempted.' }
        Write-Host 'The master password and any 2FA code are requested by official bw.exe.' -ForegroundColor Yellow
        $SessionKey = ((& $BwExecutable login $email --raw) -join "`n").Trim()
        $email = $null
        if ($LASTEXITCODE -ne 0) { throw 'Bitwarden CLI login was not completed.' }
        $state = Read-BwStatus $BwExecutable
        if ($state.status -eq 'unauthenticated') { throw 'Bitwarden CLI did not authenticate.' }
    }

    if (-not (Is-SessionKey $SessionKey)) {
        if ((Is-SessionKey $OriginalSession) -and $state.status -eq 'unlocked') {
            $SessionKey = $OriginalSession
        } else {
            Write-Host 'Unlocking vault with official bw.exe to obtain an in-memory session...' -ForegroundColor Cyan
            $SessionKey = ((& $BwExecutable unlock --raw) -join "`n").Trim()
            if ($LASTEXITCODE -ne 0 -or -not (Is-SessionKey $SessionKey)) {
                throw 'Bitwarden unlock did not return a valid session key.'
            }
        }
    }
    if (-not (Is-SessionKey $SessionKey)) { throw 'Missing session key: audit was not started.' }
    $env:BW_SESSION = $SessionKey
    $NewSession = -not ((Is-SessionKey $OriginalSession) -and $SessionKey -ceq $OriginalSession)
    $SessionKey = $null

    $verified = Read-BwStatus $BwExecutable
    if ($verified.status -ne 'unlocked') {
        throw 'Bitwarden does not report an unlocked vault; audit was not started.'
    }
    Write-Host 'Bitwarden unlocked. Starting ONTOS.VAULT read-only audit...' -ForegroundColor Green
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $AuditProgram -Mode Audit -OpenDashboard
    if ($LASTEXITCODE -ne 0) { throw ('Audit exited with code {0}' -f $LASTEXITCODE) }
    Write-Host 'Audit completed; local dashboard generated.' -ForegroundColor Green
} catch {
    Write-Host ('ONTOS.VAULT: {0}' -f $_.Exception.Message) -ForegroundColor Red
    throw
} finally {
    if ($NewSession -and $null -ne $BwExecutable) {
        & $BwExecutable lock 1>$null 2>$null
        Write-Host 'Temporary Bitwarden CLI session locked.' -ForegroundColor DarkGray
    }
    if ([string]::IsNullOrWhiteSpace($OriginalSession)) {
        Remove-Item Env:BW_SESSION -ErrorAction SilentlyContinue
    } else {
        $env:BW_SESSION = $OriginalSession
    }
    $SessionKey = $null
    $env:Path = $OriginalPath
}
