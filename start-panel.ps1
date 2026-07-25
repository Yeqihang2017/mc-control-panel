$ErrorActionPreference = "Stop"

$Node = "C:\Users\YQH\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path $Node)) {
  $Node = "node"
}

& $Node (Join-Path $Here "server.js")
