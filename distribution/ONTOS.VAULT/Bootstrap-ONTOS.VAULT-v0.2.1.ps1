#Requires -Version 5.1
<#
ONTOS.VAULT v0.2.1 bootstrap for Windows PowerShell 5.1.
Fetch the immutable Git blob through the official public GitHub API, verify SHA-256,
ensure Bitwarden CLI is installed, and start the signed-off v0.2 local audit.
Never accesses vault data itself or changes any saved credentials.
#>
[CmdletBinding()]
param([switch]$Demo)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ExpectedGitBlob = '08478770664e17d2f9cf28fb36309203cfdae2e6'
$ExpectedSha256 = '65DD15F55772352A7870E17D50136CED8CD710B76EC6FD639B8333B8562A25C'
$GitApiUrl = 'https://api.github.com/repos/OntosGit/ontos-chat-exporter/git/blobs/' + $ExpectedGitBlob
$TempDir = Join-Path $env:TEMP ('OntosVaultBootstrap-' + [guid]::NewGuid().ToString('N'))
$Installer = Join-Path $TempDir 'Install-ONTOS.VAULT-OneFile.ps1'

function Find-BwCli {
    $command = Get-Command 'bw.exe' -ErrorAction SilentlyContinue
    if ($null -ne $command -and $command.CommandType -eq 'Application') { return [string]$command.Source }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bw.exe'),
        (Join-Path $env:ProgramFiles 'WinGet\Links\bw.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}
function Refresh-Path {
    $fromMachine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $fromUser = [Environment]::GetEnvironmentVariable('Path', 'User')
    $linkDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
    $env:Path = @($env:Path, $fromMachine, $fromUser, $linkDir) -join ';'
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

    Write-Host 'ONTOS.VAULT: downloading exact pinned source from GitHub API...' -ForegroundColor Cyan
    $headers = @{ 'User-Agent' = 'ONTOS-VAULT-Verified-Installer'; 'Accept' = 'application/vnd.github+json' }
    $response = Invoke-RestMethod -Uri $GitApiUrl -Headers $headers -Method Get -ErrorAction Stop
    if ([string]$response.sha -cne $ExpectedGitBlob) { throw 'GitHub blob ID mismatch. No code was run.' }
    if ([string]$response.encoding -ne 'base64' -or [string]::IsNullOrWhiteSpace([string]$response.content)) {
        throw 'GitHub API returned an unexpected response. No code was run.'
    }
    $bytes = [Convert]::FromBase64String(([string]$response.content -replace '\s', ''))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $actualHash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
    } finally { $sha.Dispose() }
    if ($actualHash -cne $ExpectedSha256) {
        throw ('SHA-256 mismatch: expected {0}, received {1}. No code was run.' -f $ExpectedSha256,$actualHash)
    }
    [IO.File]::WriteAllBytes($Installer, $bytes)
    if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash -cne $ExpectedSha256) {
        throw 'The written installer has failed its second SHA-256 verification.'
    }
    Write-Host 'ONTOS.VAULT: Git blob and SHA-256 verified.' -ForegroundColor Green

    if (-not $Demo) {
        Refresh-Path
        $bw = Find-BwCli
        if ([string]::IsNullOrWhiteSpace($bw)) {
            $winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
            if ($null -eq $winget) {
                throw 'Bitwarden CLI is missing and winget is unavailable. Install Microsoft App Installer / winget.'
            }
            Write-Host 'Installing the official Bitwarden CLI via winget...' -ForegroundColor Cyan
            & $winget.Source install -e --id Bitwarden.CLI --source winget --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) { throw ('Bitwarden CLI installation failed (winget exit {0}).' -f $LASTEXITCODE) }
            Refresh-Path
            $bw = Find-BwCli
        }
        if ([string]::IsNullOrWhiteSpace($bw)) {
            throw 'Bitwarden CLI installation completed but bw.exe is not visible. Open a new PowerShell and rerun this bootstrap.'
        }
        $cliDir = Split-Path -Parent $bw
        $env:Path = $cliDir + ';' + $env:Path
        Write-Host ('Bitwarden CLI found: {0}' -f $bw) -ForegroundColor Green
        & $bw --version
        if ($LASTEXITCODE -ne 0) { throw 'Bitwarden CLI did not start.' }
        $statusText = (& $bw status) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Could not read Bitwarden CLI login status.' }
        $status = ConvertFrom-Json -InputObject $statusText
        if ([string]$status.status -eq 'unauthenticated') {
            Write-Host 'One-time login to the OFFICIAL Bitwarden CLI follows. Credentials stay on this computer.' -ForegroundColor Yellow
            Write-Host 'For an EU Bitwarden account, configure its server with bw config server before login.' -ForegroundColor DarkYellow
            & $bw login
            if ($LASTEXITCODE -ne 0) { throw 'Bitwarden CLI login failed.' }
            $statusText = (& $bw status) -join "`n"
            if ($LASTEXITCODE -ne 0) { throw 'Could not verify Bitwarden CLI login.' }
            $status = ConvertFrom-Json -InputObject $statusText
        }
        if ([string]$status.status -notin @('locked','unlocked')) {
            throw 'Bitwarden CLI was not authenticated. Installation succeeded; local audit was not started.'
        }
    }

    $params = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Installer)
    if (-not $Demo) { $params += '-StartAudit' }
    Write-Host 'Installing/verifying ONTOS.VAULT and starting the selected mode...' -ForegroundColor Cyan
    & powershell.exe @params
    if ($LASTEXITCODE -ne 0) { throw ('ONTOS.VAULT installer or audit returned exit code {0}.' -f $LASTEXITCODE) }
    Write-Host 'ONTOS.VAULT: completed successfully.' -ForegroundColor Green
} catch {
    Write-Host ('ONTOS.VAULT: stopped safely: {0}' -f $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}