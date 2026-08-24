# Signs VRCast Bridge binaries with the project's own certificate.
# The certificate is created once and kept in the current user's personal store.
# Run after building:  powershell -ExecutionPolicy Bypass -File tools/sign.ps1
$ErrorActionPreference = 'Stop'
$subject = 'CN=VRCast Bridge, O=VRCast Bridge'

$cert = Get-ChildItem Cert:/CurrentUser/My -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date) } |
  Sort-Object NotAfter -Descending | Select-Object -First 1

if (-not $cert) {
  Write-Host 'Creating the signing certificate (one time only)...'
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
    -CertStoreLocation Cert:/CurrentUser/My -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature -NotAfter (Get-Date).AddYears(5) `
    -FriendlyName 'VRCast Bridge code signing'
  # The public part is exported next to the app: installing it into Trusted
  # Publishers makes Windows show the publisher name instead of "Unknown".
  Export-Certificate -Cert $cert -FilePath 'launcher/assets/vrcast-code-signing.cer' -Force | Out-Null
}

$targets = @(
  'VRCast Bridge.exe',
  'launcher/bin/publish/VRCast Bridge.exe',
  'tools/VRCast.AudioCapture.exe',
  'tools/VRCast.WindowCapture.exe'
) | Where-Object { Test-Path $_ }

foreach ($file in $targets) {
  # A running app locks its own EXE: skip it and keep signing the rest.
  $result = $null
  try {
    # A timestamp keeps the signature valid after the certificate expires.
    $result = Set-AuthenticodeSignature -FilePath $file -Certificate $cert `
      -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com' -ErrorAction Stop
  } catch {
    try { $result = Set-AuthenticodeSignature -FilePath $file -Certificate $cert -HashAlgorithm SHA256 -ErrorAction Stop }
    catch { '{0,-42} skipped (file in use)' -f $file; continue }
  }
  # A self-signed certificate always reports UnknownError until it is trusted,
  # so report whether the signature landed on the file, not the chain verdict.
  $check = Get-AuthenticodeSignature $file
  $state = if ($check.SignerCertificate) { 'signed' } else { "FAILED: $($result.Status)" }
  '{0,-42} {1}' -f $file, $state
}

Write-Host ''
Write-Host 'To make Windows show the publisher name instead of "Unknown publisher",'
Write-Host 'install the exported certificate once (no admin rights needed):'
Write-Host '  Import-Certificate -FilePath launcher/assets/vrcast-code-signing.cer -CertStoreLocation Cert:/CurrentUser/Root'
