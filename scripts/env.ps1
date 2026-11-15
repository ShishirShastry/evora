# Puts the project's portable Node.js on PATH for the current PowerShell session
# and keeps the npm cache inside the project folder.
#
# Usage (from the project folder):   . .\scripts\env.ps1
#
# Not needed if Node.js >= 20.19 is installed system-wide and already on PATH.

$root = Split-Path -Parent $PSScriptRoot
$nodeDir = Join-Path $root '.tools\node'

if (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe')) {
  if (-not (($env:PATH -split ';') -contains $nodeDir)) {
    $env:PATH = "$nodeDir;$env:PATH"
  }
  $env:npm_config_cache = Join-Path $root '.tools\npm-cache'
  $env:npm_config_update_notifier = 'false'
  Write-Host "Using Node $(node --version) and npm $(npm --version) from $nodeDir"
} else {
  Write-Warning "No portable Node.js found at $nodeDir. Install Node.js >= 20.19 or restore .tools\node."
}
