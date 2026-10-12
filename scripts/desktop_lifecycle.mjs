import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const apps = new Set(['codex', 'claude', 'antigravity']);
// Resolve the current user's installed desktop app. Never search for model CLI
// binaries, pass debugger flags, stop a process, or change a sign-in/profile.
const installationScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$app = $env:TRIANGLE_DESKTOP_APP
$names = @{ codex = 'Codex'; claude = 'Claude'; antigravity = 'Antigravity' }
$packages = @{ codex = 'OpenAI.Codex'; claude = 'Claude'; antigravity = 'Antigravity' }
$applicationIds = @{ codex = 'App'; claude = 'Claude'; antigravity = 'Antigravity' }
$name = $names[$app]
$candidates = [System.Collections.Generic.List[string]]::new()
$desktopPatterns = @{ codex = '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(ChatGPT|Codex)\.exe$'; claude = '\\WindowsApps\\Claude_[^\\]+\\app\\Claude\.exe$'; antigravity = '\\Programs\\Antigravity\\Antigravity\.exe$' }
foreach ($running in @(Get-Process -Name $name,ChatGPT -ErrorAction SilentlyContinue)) {
  if ($running.Path -match $desktopPatterns[$app]) { $candidates.Add($running.Path) }
}
foreach ($package in @(Get-AppxPackage -Name $packages[$app] -ErrorAction SilentlyContinue | Sort-Object Version -Descending)) {
  [xml]$manifest = Get-Content -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml') -Raw
  foreach ($application in $manifest.SelectNodes('//*[local-name()="Application"]')) {
    if ($application.Executable -and ($application.Id -eq $applicationIds[$app] -or [IO.Path]::GetFileName($application.Executable) -ieq ($name + '.exe'))) {
      $candidates.Add((Join-Path $package.InstallLocation $application.Executable))
    }
  }
}
foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
  if (-not $base) { continue }
  if ($base -eq $env:LOCALAPPDATA) {
    $candidates.Add((Join-Path $base ('Programs\' + $name + '\' + $name + '.exe')))
    $candidates.Add((Join-Path $base ($name + '\' + $name + '.exe')))
  } else {
    $candidates.Add((Join-Path $base ($name + '\' + $name + '.exe')))
  }
}
foreach ($hive in @('HKCU:', 'HKLM:')) {
  $key = $hive + '\Software\Microsoft\Windows\CurrentVersion\App Paths\' + $name + '.exe'
  $registered = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
  if ($registered -and $registered.'(default)') { $candidates.Add($registered.'(default)') }
  $uninstall = $hive + '\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
  foreach ($entry in @(Get-ItemProperty -Path $uninstall -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match ('^' + $name + '(\s|$)') })) {
    if ($entry.InstallLocation) { $candidates.Add((Join-Path $entry.InstallLocation ($name + '.exe'))) }
  }
}
$executable = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $executable) { throw ('Installed ' + $name + ' desktop app was not found') }
$processName = [IO.Path]::GetFileNameWithoutExtension($executable)
$processes = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $executable })
@{ executable = $executable; pids = @($processes | ForEach-Object { $_.Id }); windowCount = @($processes | Where-Object { $_.MainWindowHandle -ne 0 }).Count } | ConvertTo-Json -Compress
`;

export async function desktopInstallation(app) {
  if (!apps.has(app)) throw new Error(`Unknown desktop app: ${app}`);
  if (process.platform !== 'win32') throw new Error('Desktop app startup currently requires Windows');
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', installationScript],
      { env: { ...process.env, TRIANGLE_DESKTOP_APP: app }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Cannot inspect ${app} desktop installation: ${error.stderr?.trim().split(/\r?\n/)[0] || error.code || 'Windows installation query failed'}`);
  }
}

export async function launchDesktop(app) {
  const installation = await desktopInstallation(app);
  await new Promise((resolve, reject) => {
    const child = spawn(installation.executable, [], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { app, action: installation.pids.length ? 'open-existing' : 'launch', previousPids: installation.pids };
}

export async function ensureDesktopReady(app, { probe, launch = launchDesktop, timeoutMs = 45000,
  intervalMs = 500, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  if (!apps.has(app)) throw new Error(`Unknown desktop app: ${app}`);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Startup timeout must be a positive number');
  probe ||= async () => {
    const state = await desktopInstallation(app);
    return state.windowCount ? { app, pids: state.pids } : null;
  };
  let lastError;
  const check = async () => {
    try { return await probe(); } catch (error) {
      if (error.desktopIdentityMismatch) throw error;
      lastError = error;
      return null;
    }
  };
  const existing = await check();
  if (existing) return { app, started: false, ready: existing };
  const deadline = now() + timeoutMs;
  const launched = await launch(app); // Exactly once, before any session mutation.
  do {
    const ready = await check();
    if (ready) return { app, started: true, launched, ready };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  } while (now() < deadline);
  throw new Error(`${app} desktop was opened but did not become ready within ${timeoutMs} ms${lastError ? ': ' + lastError.message : ''}`);
}
