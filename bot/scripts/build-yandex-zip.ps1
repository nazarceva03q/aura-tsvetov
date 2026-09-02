# Builds bot/yandex-deploy.zip for upload to Yandex Cloud Functions via
# "Source code -> ZIP archive". Contains index.js, src/*.js and a minimal
# package.json (no node_modules needed - everything uses only Node built-ins,
# there are no external dependencies).
#
# Run from the bot/ folder after any change to index.js or src/*.js:
#   powershell -ExecutionPolicy Bypass -File scripts/build-yandex-zip.ps1

$ErrorActionPreference = "Stop"
$botDir = Split-Path -Parent $PSScriptRoot
$staging = Join-Path $botDir "_yandex_staging"
$zipPath = Join-Path $botDir "yandex-deploy.zip"

if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null
New-Item -ItemType Directory -Path (Join-Path $staging "src") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $staging "certs") | Out-Null

Copy-Item (Join-Path $botDir "index.js") (Join-Path $staging "index.js")
Copy-Item (Join-Path $botDir "src\*.js") (Join-Path $staging "src\")
# certs/ is required by src/maxApi.js (Russian Trusted Root CA bundle) -
# without it, outbound HTTPS requests to platform-api2.max.ru fail with
# UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Do not forget this on rebuild.
Copy-Item (Join-Path $botDir "certs\*.pem") (Join-Path $staging "certs\")

$pkg = @'
{
  "name": "aura-max-bot",
  "version": "1.0.0",
  "private": true,
  "main": "index.js"
}
'@
Set-Content -Path (Join-Path $staging "package.json") -Value $pkg -Encoding utf8

if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath

Remove-Item -Recurse -Force $staging

Write-Host "Done: $zipPath"
