param(
  [Parameter(Mandatory = $true)][string]$BaseInstaller,
  [Parameter(Mandatory = $true)][string]$UpgradeInstaller,
  [Parameter(Mandatory = $true)][string]$BaseVersion,
  [Parameter(Mandatory = $true)][string]$UpgradeVersion,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
  [ValidateSet('signed-production', 'unsigned-preflight')][string]$ValidationMode = 'signed-production'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$events = [System.Collections.Generic.List[object]]::new()
$script:installEntry = $null

function Add-Evidence([string]$stage, [hashtable]$data) {
  $events.Add([ordered]@{ utc = [DateTime]::UtcNow.ToString('o'); stage = $stage; data = $data })
  $events | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $EvidenceDirectory 'windows-lifecycle-evidence.json') -Encoding utf8
}

function Assert-SignedInstaller([string]$path) {
  $file = Get-Item $path
  if ($ValidationMode -eq 'unsigned-preflight') {
    return [ordered]@{ path = $file.FullName; sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); authenticode = 'unsigned-preflight'; note = '未签名预验，不是生产可信签名证据。' }
  }
  $signature = Get-AuthenticodeSignature $file.FullName
  if ($signature.Status -ne 'Valid') { throw "Authenticode invalid for $($file.Name): $($signature.Status)" }
  if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'SignPath Foundation') { throw "Trusted publisher missing for $($file.Name)" }
  if (-not $signature.TimeStamperCertificate) { throw "Timestamp certificate missing for $($file.Name)" }
  $all = (& signtool verify /all /pa $file.FullName 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $all -notmatch 'RFC3161') { throw "RFC3161 verification failed for $($file.Name): $all" }
  return [ordered]@{
    path = $file.FullName
    sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    authenticode = [string]$signature.Status
    signer = $signature.SignerCertificate.Subject
    timestampSigner = $signature.TimeStamperCertificate.Subject
    signtool = $all
  }
}

function Get-NumxInstall {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entry = Get-ItemProperty $roots -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'NumX Max' } |
    Select-Object -First 1
  if (-not $entry) { return $null }
  $directory = [string]$entry.InstallLocation
  if (-not $directory -and $entry.UninstallString) {
    $uninstall = [string]$entry.UninstallString
    if ($uninstall -match '^"([^"]+)"') { $directory = Split-Path $Matches[1] -Parent }
    else { $directory = Split-Path ($uninstall.Split(' ')[0]) -Parent }
  }
  $exe = Join-Path $directory 'NumX Max.exe'
  $uninstallExe = $null
  if ($entry.UninstallString -match '^"([^"]+)"') { $uninstallExe = $Matches[1] }
  elseif ($entry.UninstallString) { $uninstallExe = ([string]$entry.UninstallString).Split(' ')[0] }
  return [ordered]@{ entry = $entry; directory = $directory; exe = $exe; uninstallExe = $uninstallExe }
}

function Assert-InstalledVersion([string]$expected, [string]$stage) {
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  do {
    $script:installEntry = Get-NumxInstall
    if ($script:installEntry -and (Test-Path $script:installEntry.exe)) { break }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $script:installEntry -or -not (Test-Path $script:installEntry.exe)) { throw "$stage did not produce NumX Max.exe" }
  $version = (Get-Item $script:installEntry.exe).VersionInfo.ProductVersion
  if (-not $version -or -not $version.StartsWith($expected, [StringComparison]::OrdinalIgnoreCase)) { throw "$stage version mismatch: expected $expected, actual $version" }
  Add-Evidence $stage @{ version = $version; directory = $script:installEntry.directory; executableSha256 = (Get-FileHash $script:installEntry.exe -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Invoke-Installer([string]$path, [string]$stage) {
  $process = Start-Process -FilePath $path -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "$stage installer exit code $($process.ExitCode)" }
  Add-Evidence "$stage-installer-exit" @{ exitCode = $process.ExitCode }
}

function Invoke-StartSmoke([string]$stage) {
  if (-not $script:installEntry) { throw 'No installation registered for start smoke' }
  $process = Start-Process -FilePath $script:installEntry.exe -PassThru
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
      Start-Sleep -Seconds 2
      $process.Refresh()
      if ($process.HasExited) { throw "$stage app exited early with code $($process.ExitCode)" }
    } while ($process.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($process.MainWindowHandle -eq 0) { throw "$stage app produced no main window within 90 seconds" }
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
    $screenshot = Join-Path $EvidenceDirectory "$stage.png"
    $bitmap.Save($screenshot, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    Add-Evidence $stage @{ processId = $process.Id; windowTitle = $process.MainWindowTitle; screenshot = $screenshot }
  } finally {
    if (-not $process.HasExited) { & taskkill /PID $process.Id /T /F | Out-Null }
  }
}

function Invoke-Uninstall {
  $entry = Get-NumxInstall
  if (-not $entry -or -not $entry.uninstallExe) { throw 'Uninstaller not found' }
  $process = Start-Process -FilePath $entry.uninstallExe -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Uninstaller exit code $($process.ExitCode)" }
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  do { Start-Sleep -Seconds 2; $remaining = Get-NumxInstall } while ($remaining -and [DateTime]::UtcNow -lt $deadline)
  if ($remaining -or (Test-Path $entry.exe)) { throw 'Application remains installed after uninstall' }
  Add-Evidence 'uninstall' @{ exitCode = $process.ExitCode; executableRemoved = -not (Test-Path $entry.exe); note = 'Canonical server data and production evidence are not touched.' }
}

try {
  if (Get-NumxInstall) { throw 'NumX Max is already installed; use a fresh Windows VM and do not remove an existing user installation.' }
  $base = Assert-SignedInstaller $BaseInstaller
  $upgrade = Assert-SignedInstaller $UpgradeInstaller
  Add-Evidence 'precondition' @{ imageOS = $env:ImageOS; imageVersion = $env:ImageVersion; base = $base; upgrade = $upgrade; validationMode = $ValidationMode; vmType = 'fresh GitHub-hosted Windows VM; not a bare-metal or long-lived user machine' }
  Invoke-Installer $base.path 'base'
  Assert-InstalledVersion $BaseVersion 'install-base'
  Invoke-StartSmoke 'start-base'
  Invoke-Installer $upgrade.path 'upgrade'
  Assert-InstalledVersion $UpgradeVersion 'install-upgrade'
  Invoke-StartSmoke 'start-upgrade'
  Invoke-Installer $base.path 'rollback'
  Assert-InstalledVersion $BaseVersion 'install-rollback'
  Invoke-StartSmoke 'start-rollback'
  Invoke-Uninstall
  Add-Evidence 'complete' @{ ok = $true; note = 'Install/start/upgrade/rollback/uninstall passed on the declared fresh Windows VM.' }
} catch {
  Add-Evidence 'failed' @{ ok = $false; error = $_.Exception.Message }
  throw
}
