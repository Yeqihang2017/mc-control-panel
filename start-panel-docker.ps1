$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ComposeFile = Join-Path $Here "panel.compose.yml"
$EnvFile = Join-Path $Here ".env"

function Convert-ToDockerHostPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  if ($IsLinux -or $IsMacOS) {
    return $resolved.Replace("\", "/")
  }

  if ($resolved -match "^([A-Za-z]):\\(.*)$") {
    $drive = $Matches[1].ToLowerInvariant()
    $rest = $Matches[2].Replace("\", "/")
    return "/run/desktop/mnt/host/$drive/$rest"
  }

  return $resolved.Replace("\", "/")
}

$HostDataDir = Convert-ToDockerHostPath -Path $Here
@"
PANEL_HOST_DATA_DIR=$HostDataDir
"@ | Set-Content -LiteralPath $EnvFile -Encoding ASCII

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

docker compose --env-file $EnvFile -f $ComposeFile up -d --build
if ($LASTEXITCODE -ne 0) {
  throw "Docker compose failed to build or start the panel."
}

Write-Host ""
Write-Host "Docker host data path: $HostDataDir"
Write-Host "Panel is running at http://127.0.0.1:8787"
Write-Host "Panel container logs: docker logs -f mc-control-panel"
