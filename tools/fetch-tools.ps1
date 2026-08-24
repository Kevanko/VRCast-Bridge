# Downloads the third-party binaries VRCast Bridge embeds into its EXE.
# They are not stored in the repository: they are large and belong to their authors.
# Run once before building:  powershell -ExecutionPolicy Bypass -File tools/fetch-tools.ps1
$ErrorActionPreference = 'Stop'
$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-File($name, $url, $target) {
  if (Test-Path $target) { Write-Host ("{0,-14} already present" -f $name); return }
  Write-Host ("{0,-14} downloading..." -f $name)
  Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing
}

# yt-dlp — extracts video from YouTube and 1800+ other sites (Unlicense)
Get-File 'yt-dlp' 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' (Join-Path $tools 'yt-dlp.exe')

# MediaMTX — the local RTSP server that makes the link instant (MIT)
$mediamtx = Join-Path $tools 'mediamtx.exe'
if (-not (Test-Path $mediamtx)) {
  Write-Host 'mediamtx       downloading...'
  $release = Invoke-RestMethod 'https://api.github.com/repos/bluenviron/mediamtx/releases/latest' -UseBasicParsing
  $asset = $release.assets | Where-Object { $_.name -match 'windows_amd64\.zip$' } | Select-Object -First 1
  $zip = Join-Path $env:TEMP 'mediamtx.zip'
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
  $unpacked = Join-Path $env:TEMP 'mediamtx-unpack'
  Remove-Item $unpacked -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip -DestinationPath $unpacked -Force
  Copy-Item (Join-Path $unpacked 'mediamtx.exe') $mediamtx -Force
  Remove-Item $zip, $unpacked -Recurse -Force -ErrorAction SilentlyContinue
} else { Write-Host 'mediamtx       already present' }

# plink (PuTTY) — password SSH used to deploy your own relay server (MIT)
Get-File 'plink' 'https://the.earth.li/~sgtatham/putty/latest/w64/plink.exe' (Join-Path $tools 'plink.exe')

# cloudflared — free public tunnel for the "for friends" mode (Apache-2.0)
Get-File 'cloudflared' 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' (Join-Path $tools 'cloudflared.exe')

Write-Host ''
Write-Host 'Done. Pinggy (the backup tunnel) is optional: put pinggy.exe next to the others if you want it.'
Write-Host 'Now build the helpers and the launcher:'
Write-Host '  dotnet publish audio-helper/VRCast.AudioCapture.csproj -c Release -o audio-helper/bin/publish'
Write-Host '  copy audio-helper\bin\publish\VRCast.AudioCapture.exe tools\'
Write-Host '  cargo build --release --manifest-path capture-helper/Cargo.toml'
Write-Host '  copy capture-helper\target\release\vrcast-window-capture.exe tools\VRCast.WindowCapture.exe'
Write-Host '  dotnet publish launcher/VRCastBridge.Launcher.csproj -c Release -o launcher/bin/publish'
