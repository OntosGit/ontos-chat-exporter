#Requires -Version 5.1
<#
ONTOS.VAULT v0.2.5: isolated fresh Bitwarden login and safe counts.
Avoids 'bw unlock', a problematic path in some 2026 CLI builds.
Runs in the CURRENT interactive Windows PowerShell session.
Region and email are explicit parameters; no Read-Host prompts.
The official CLI requests the master password and second factor.
No passwords, item JSON, OTPs or session keys are printed or exported.
The isolated CLI profile is removed when this run ends.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('US','EU')]
    [string]$Region,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AccountEmail
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$OldProfile = [Environment]::GetEnvironmentVariable('BITWARDENCLI_APPDATA_DIR','Process')
$OldSession = [Environment]::GetEnvironmentVariable('BW_SESSION','Process')
$CliFolder = Join-Path $env:TEMP ('ONTOS-VAULT-CLI-' + [guid]::NewGuid().ToString('N'))
$bw = $null
$token = $null
$json = $null
$entries = $null
$loginItems = $null
$loggedIn = $false

function Find-BwExe {
    $cmd = Get-Command bw.exe -ErrorAction SilentlyContinue
    if ($null -ne $cmd -and $cmd.CommandType -eq 'Application') { return [string]$cmd.Source }
    $packages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path -LiteralPath $packages -PathType Container) {
        foreach ($d in (Get-ChildItem -LiteralPath $packages -Directory -Filter 'Bitwarden.CLI_*' -ErrorAction SilentlyContinue)) {
            $candidate = Join-Path $d.FullName 'bw.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    throw 'Bitwarden CLI executable not found; no changes made.'
}

try {
    $bw = Find-BwExe
    Write-Host 'ONTOS.VAULT v0.2.5 - explicit-region verification' -ForegroundColor Cyan
    & $bw --version
    if ($LASTEXITCODE -ne 0) { throw 'Bitwarden CLI version check failed.' }

    # Explicit parameters avoid Read-Host consuming a stray newline from a pasted wrapper.
    $region = $Region.ToUpperInvariant()
    $email = $AccountEmail.Trim()
    if ($email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw 'Invalid AccountEmail. No login attempted.' }
    Write-Host ('Region is explicitly pinned: {0}' -f $region) -ForegroundColor Yellow

    New-Item -ItemType Directory -Path $CliFolder -Force | Out-Null
    $env:BITWARDENCLI_APPDATA_DIR = $CliFolder
    Remove-Item Env:BW_SESSION -ErrorAction SilentlyContinue

    $server = if ($region -eq 'EU') { 'https://vault.bitwarden.eu' } else { 'https://vault.bitwarden.com' }
    & $bw config server $server | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure isolated CLI region.' }
    Write-Host ('Isolated CLI profile configured for: {0}' -f $region) -ForegroundColor Cyan
    Write-Host 'Logging in with official bw.exe. Master password and 2FA stay in the CLI prompt.' -ForegroundColor Yellow

    # Capture stdout so the session secret never appears in terminal history.
    $token = ((& $bw login $email --raw) -join "`n").Trim()
    $email = $null
    if ($LASTEXITCODE -ne 0 -or $token -cnotmatch '^[A-Za-z0-9+/=]{40,}$') {
        throw 'Fresh CLI login did not return a valid session. No audit performed.'
    }
    $env:BW_SESSION = $token
    $token = $null
    $loggedIn = $true

    $sraw = (& $bw status) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'CLI status check failed.' }
    $status = ConvertFrom-Json -InputObject $sraw
    $sraw = $null
    if ([string]$status.status -ne 'unlocked') {
        throw ('Fresh login session not unlocked (status: {0}). No audit performed.' -f $status.status)
    }

    # Always synchronize AFTER logging in. Never use 'bw unlock' in this run.
    & $bw sync | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Bitwarden sync failed.' }

    # 'bw list items' contains secrets; keep its JSON entirely in memory.
    $json = (& $bw list items) -join "`n"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) {
        throw 'Could not list vault items. No item data was printed.'
    }
    try {
        $parsed = ConvertFrom-Json -InputObject $json -ErrorAction Stop
    } catch {
        throw 'CLI list items returned invalid JSON. Contents were not printed.'
    } finally {
        $json = $null
    }
    $entries = @()
    if ($null -ne $parsed) { $entries = @($parsed) }
    if ($entries.Count -eq 1 -and $entries[0] -is [array]) { $entries = @($entries[0]) }
    $parsed = $null
    $loginItems = @($entries | Where-Object { $null -ne $_ -and $_.type -eq 1 })
    $withPassword = @($loginItems | Where-Object { $null -ne $_.login -and -not [string]::IsNullOrWhiteSpace([string]$_.login.password) }).Count

    Write-Host '=== ONTOS.VAULT DIRECT COUNTS ===' -ForegroundColor Green
    Write-Host ('SERVER_REGION={0}' -f $region)
    Write-Host ('CLI_SESSION=FRESH_LOGIN_OK')
    Write-Host ('TOTAL_ITEMS={0}' -f $entries.Count)
    Write-Host ('LOGIN_ITEMS={0}' -f $loginItems.Count)
    Write-Host ('LOGINS_WITH_PASSWORD={0}' -f $withPassword)
    Write-Host ('NON_LOGIN_ITEMS={0}' -f ($entries.Count - $loginItems.Count))
    Write-Host 'SECRETS_PRINTED=NO'
    Write-Host 'LOCAL_EXPORT=NONE'
    if ($loginItems.Count -lt 300) {
        Write-Host 'COUNT_MISMATCH: compare email and server region with the browser vault showing 461 passwords.' -ForegroundColor Yellow
    } else {
        Write-Host 'VAULT_COUNT_PLAUSIBLE: ready for a separate verified ONTOS.VAULT audit.' -ForegroundColor Green
    }
} catch {
    Write-Host ('ONTOS.VAULT probe stopped: {0}' -f $_.Exception.Message) -ForegroundColor Red
    throw
} finally {
    $token = $null
    $json = $null
    $parsed = $null
    $entries = $null
    $loginItems = $null
    if ($loggedIn -and $null -ne $bw) {
        & $bw logout 1>$null 2>$null
    }
    if ([string]::IsNullOrWhiteSpace($OldSession)) {
        Remove-Item Env:BW_SESSION -ErrorAction SilentlyContinue
    } else { $env:BW_SESSION = $OldSession }
    if ([string]::IsNullOrWhiteSpace($OldProfile)) {
        Remove-Item Env:BITWARDENCLI_APPDATA_DIR -ErrorAction SilentlyContinue
    } else { $env:BITWARDENCLI_APPDATA_DIR = $OldProfile }
    if (Test-Path -LiteralPath $CliFolder) {
        Remove-Item -LiteralPath $CliFolder -Recurse -Force -ErrorAction SilentlyContinue
    }
}
