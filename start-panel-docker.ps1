$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ComposeFile = Join-Path $Here "panel.compose.yml"

$listener = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -ne 0 }

foreach ($item in $listener) {
  try {
    $process = Get-Process -Id $item.OwningProcess -ErrorAction Stop
    if ($process.ProcessName -eq "node") {
      Stop-Process -Id $process.Id -Force
      Write-Host "Stopped local Node panel process: $($process.Id)"
    }
  } catch {
    Write-Warning "Port 8787 is in use by process $($item.OwningProcess). Stop it if Docker cannot bind the port."
  }
}

docker compose -f $ComposeFile up -d --build
if ($LASTEXITCODE -ne 0) {
  throw "Docker compose failed to build or start the panel."
}

Write-Host ""
Write-Host "Panel is running at http://127.0.0.1:8787"
Write-Host "Panel container logs: docker logs -f mc-control-panel"
