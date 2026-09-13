# T02 integration test. Never run installer/uninstaller operations on a user machine.
param([Parameter(Mandatory=$true)][string]$ForkInstaller)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'This test is restricted to disposable GitHub-hosted Windows runners.'
}

$testRoot = Join-Path $env:RUNNER_TEMP ('mdw-coexist-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$upstreamDirectory = Join-Path $testRoot 'upstream'
$forkDirectory = Join-Path $testRoot 'fork'
$upstreamSetup = Join-Path $testRoot 'upstream-0.7.3.exe'
$evidencePath = Join-Path $env:GITHUB_WORKSPACE 't02-coexistence.json'
$evidence = [ordered]@{
  schema = 1
  os = [System.Environment]::OSVersion.VersionString
  upstream_version = '0.7.3'
  fork_installer_sha256 = (Get-FileHash -Algorithm SHA256 $ForkInstaller).Hash.ToLowerInvariant()
  checks = [ordered]@{}
  status = 'running'
  limitations = @('Windows Server CI is not Windows 11 user-device acceptance.',
                 'Window creation is not document readability or IME verification.',
                 'File-association restoration and signed updates belong to later acceptance.')
}
$launched = @()
$sentinels = @()

function Save-Evidence {
  $evidence | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $evidencePath
}

function Install-Silent([string]$Setup, [string]$Directory) {
  # NSIS requires /D to be last; the runner-temporary path has no shell expansion.
  $process = Start-Process -FilePath $Setup -ArgumentList @('/S', ('/D=' + $Directory)) -PassThru
  if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'Installer timeout' }
  if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
}

try {
  Invoke-WebRequest -Uri 'https://github.com/Vesperino/MerMarkEditor/releases/download/v0.7.3/MerMark.Editor_0.7.3_x64-setup.exe' -OutFile $upstreamSetup
  $expectedHash = '0bb3755565b8dc5d07398effd25a296ae438f228c6aa664d0d966ee27bf89e26'
  if ((Get-FileHash -Algorithm SHA256 $upstreamSetup).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Pinned upstream installer SHA-256 mismatch'
  }
  $evidence.upstream_installer_sha256 = $expectedHash
  Install-Silent $upstreamSetup $upstreamDirectory
  $upstreamBinary = Join-Path $upstreamDirectory 'mdreader.exe'
  if (-not (Test-Path $upstreamBinary)) { throw 'Upstream binary missing after installation' }
  $upstreamBinaryHash = (Get-FileHash -Algorithm SHA256 $upstreamBinary).Hash

  # Distinct sentinels in both Windows Tauri data bases. No user data is involved.
  foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
    foreach ($identifier in @('com.mermark.editor', 'io.github.aharada54914.mdworkbench')) {
      $directory = Join-Path $base $identifier
      New-Item -ItemType Directory -Force -Path $directory | Out-Null
      $path = Join-Path $directory 't02-synthetic-sentinel.txt'
      if (Test-Path $path) { throw 'Unexpected existing test sentinel' }
      $value = [guid]::NewGuid().ToString()
      Set-Content -Path $path -Value $value -Encoding utf8
      $sentinels += @{path=$path; hash=(Get-FileHash -Algorithm SHA256 $path).Hash}
    }
  }
  Install-Silent (Resolve-Path $ForkInstaller).Path $forkDirectory
  $forkBinary = Join-Path $forkDirectory 'md-workbench.exe'
  if (-not (Test-Path $forkBinary)) { throw 'Fork binary missing after installation' }
  if ((Get-FileHash -Algorithm SHA256 $upstreamBinary).Hash -ne $upstreamBinaryHash) {
    throw 'Fork installation modified the upstream executable'
  }
  $evidence.checks.separate_installed_binaries = $true

  $document = Join-Path $testRoot 'synthetic.md'
  Set-Content -Path $document -Value '# Synthetic coexistence test' -Encoding utf8
  foreach ($binary in @($upstreamBinary, $forkBinary)) {
    $process = Start-Process -FilePath $binary -ArgumentList @($document) -PassThru
    $launched += $process
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      Start-Sleep -Milliseconds 200
      $process.Refresh()
      if ($process.HasExited) { throw "Application exited before window creation: $binary" }
    } while ($process.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($process.MainWindowHandle -eq 0) { throw "No application window: $binary" }
  }
  foreach ($process in $launched) {
    $process.Refresh()
    if ($process.HasExited -or $process.MainWindowHandle -eq 0) { throw 'Applications did not coexist' }
  }
  $evidence.checks.simultaneous_native_windows = $true
  foreach ($sentinel in $sentinels) {
    if ((Get-FileHash -Algorithm SHA256 $sentinel.path).Hash -ne $sentinel.hash) {
      throw 'Application data sentinel was changed'
    }
  }
  $evidence.checks.separate_data_sentinels_unchanged = $true

  foreach ($process in $launched) {
    $null = $process.CloseMainWindow()
    if (-not $process.WaitForExit(15000)) { $process.Kill(); $process.WaitForExit() }
  }
  $uninstaller = Join-Path $forkDirectory 'uninstall.exe'
  if (-not (Test-Path $uninstaller)) { throw 'Fork uninstaller missing' }
  $remove = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -PassThru
  if (-not $remove.WaitForExit(60000)) { $remove.Kill(); throw 'Uninstaller timeout' }
  if ($remove.ExitCode -ne 0) { throw "Uninstaller failed: $($remove.ExitCode)" }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((Test-Path $forkBinary) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if (Test-Path $forkBinary) { throw 'Fork executable remains after uninstall' }
  if ((Get-FileHash -Algorithm SHA256 $upstreamBinary).Hash -ne $upstreamBinaryHash) {
    throw 'Fork uninstall changed or removed upstream executable'
  }
  foreach ($sentinel in $sentinels | Where-Object { $_.path -like '*com.mermark.editor*' }) {
    if ((Get-FileHash -Algorithm SHA256 $sentinel.path).Hash -ne $sentinel.hash) {
      throw 'Fork uninstall changed upstream data'
    }
  }
  $evidence.checks.fork_uninstall_preserves_upstream = $true
  $evidence.status = 'passed'
} catch {
  $evidence.status = 'failed'
  $evidence.error = $_.Exception.Message
  throw
} finally {
  Save-Evidence
  foreach ($process in $launched) {
    if (-not $process.HasExited) { $process.Kill() }
  }
  # The entire runner is discarded; do not run broad registry/data cleanup.
}
