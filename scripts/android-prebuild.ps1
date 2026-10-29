param([string]$Abi = 'arm64-v8a,x86_64')
. "$PSScriptRoot/android-env.ps1"
$env:ABI_FILTERS = $Abi
Push-Location "$MeloRoot/android-app/apps/mobile"
try {
    & node node_modules/expo/bin/cli prebuild --platform android --no-install
    if ($LASTEXITCODE -ne 0) { throw 'Expo prebuild failed' }
} finally { Pop-Location }
