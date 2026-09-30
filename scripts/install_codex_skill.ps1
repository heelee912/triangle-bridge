param([string]$SkillsRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $SkillsRoot) {
  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
  $SkillsRoot = Join-Path $codexHome 'skills'
}
$repository = Split-Path -Parent $PSScriptRoot
$destination = Join-Path ([IO.Path]::GetFullPath($SkillsRoot)) 'claude-code-bridge'
$files = @{
  'SKILL.md' = 'skills\claude-code-bridge\SKILL.md'
  'agents\openai.yaml' = 'skills\claude-code-bridge\agents\openai.yaml'
  'scripts\claude_code_bridge.mjs' = 'scripts\claude_code_bridge.mjs'
  'scripts\claude_live_stdin.ps1' = 'scripts\claude_live_stdin.ps1'
  'scripts\claude_peer_transport.mjs' = 'scripts\claude_peer_transport.mjs'
  'scripts\claude_peer_pipe.ps1' = 'scripts\claude_peer_pipe.ps1'
  'scripts\codex_bridge.mjs' = 'scripts\codex_bridge.mjs'
  'scripts\codex_app_pipe.mjs' = 'scripts\codex_app_pipe.mjs'
}

foreach ($relative in $files.Keys) {
  $source = Join-Path $repository $files[$relative]
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing skill resource: $source" }
}
foreach ($relative in $files.Keys) {
  $source = Join-Path $repository $files[$relative]
  $target = Join-Path $destination $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  if (Test-Path -LiteralPath $target -PathType Leaf) {
    $existing = [IO.File]::ReadAllText($target).Replace("`r`n", "`n")
    $incoming = [IO.File]::ReadAllText($source).Replace("`r`n", "`n")
    if ($existing -ceq $incoming) { continue }
  }
  Copy-Item -LiteralPath $source -Destination $target -Force
}
@{ok=$true;skillPath=$destination;resources=$files.Count} | ConvertTo-Json -Compress
