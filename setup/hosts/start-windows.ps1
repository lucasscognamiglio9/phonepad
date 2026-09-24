$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
if (-not $tailscale) { $tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe' }
if (-not (Test-Path $tailscale)) { throw 'Instalá Tailscale e iniciá sesión antes de abrir PhonePad.' }
$status = & $tailscale status --json | ConvertFrom-Json
$dns = $status.Self.DNSName.TrimEnd('.')
if ($status.BackendState -ne 'Running' -or $dns -notmatch '\.ts\.net$') { throw 'Tailscale debe estar conectado y tener MagicDNS activo.' }
Write-Host "PhonePad: https://$dns"
$serveStatus = (& $tailscale serve status --json | Out-String).Trim()
if ($serveStatus -match '127\.0\.0\.1:8081') {
    # PhonePad is already configured.
} elseif ($serveStatus -eq '{}' -or $serveStatus -eq 'null') {
    & $tailscale serve --bg --https=443 http://127.0.0.1:8081
} else {
    throw 'Ya existe otra configuración Tailscale Serve. Revisala antes de iniciar PhonePad.'
}
$daemon = Start-Process -FilePath (Join-Path $PSScriptRoot 'phonepad-daemon.exe') -ArgumentList @('--gateway-port', '8081', '--local-share-port', '8082', '--public-url', "https://$dns") -PassThru
Start-Sleep -Seconds 2
Start-Process 'http://127.0.0.1:8082/share'
Wait-Process -Id $daemon.Id
