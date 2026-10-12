# Install the same self-contained Triangle Bridge skill for all three apps.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'triangle_bridge.mjs') install-skills
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
