param(
    [ValidateSet('arm64-v8a', 'x86_64', 'arm64-v8a,x86_64')]
    [string]$Abi = 'arm64-v8a,x86_64',
    [string[]]$Tasks = @(':app:assembleRelease'),
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$Log = 'release.txt',
    [string]$SigningConfigPath = $env:MELO_SIGNING_CONFIG,
    [switch]$Offline
)
. "$PSScriptRoot/android-env.ps1"
if (!$SigningConfigPath) { $SigningConfigPath = "$MeloRoot/artifacts/private/internal-signing.json" }
if (!(Test-Path -LiteralPath $SigningConfigPath -PathType Leaf)) {
    throw 'Existing internal signing configuration required. Set -SigningConfigPath or MELO_SIGNING_CONFIG; no new key will be generated.'
}
$configFile = (Resolve-Path -LiteralPath $SigningConfigPath).Path
try {
    $signing = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    throw 'Internal signing configuration could not be read as UTF-8 JSON.'
}
if (!$signing.path -or !$signing.password) {
    throw 'Internal signing configuration is incomplete or its existing keystore is unavailable.'
}
$keyFile = if ([System.IO.Path]::IsPathRooted($signing.path)) { $signing.path } else { Join-Path (Split-Path $configFile -Parent) $signing.path }
if (!(Test-Path -LiteralPath $keyFile -PathType Leaf)) {
    throw 'Internal signing configuration is incomplete or its existing keystore is unavailable.'
}
$keyFile = (Resolve-Path -LiteralPath $keyFile).Path
$env:ABI_FILTERS = $Abi
$env:NODE_ENV = 'production'
& node "$PSScriptRoot/fix-worklets-lint.cjs"
if ($LASTEXITCODE -ne 0) { throw 'Worklets lint compatibility check failed' }
$previousKey = $env:MELO_KEYSTORE
$previousPassword = $env:MELO_KEYSTORE_PASSWORD
try {
    $env:MELO_KEYSTORE = $keyFile
    $env:MELO_KEYSTORE_PASSWORD = $signing.password
    Push-Location "$MeloRoot/android-app/apps/mobile/android"
    try {
        $gradle = if (Test-Path "$MeloTools/gradle-9.3.1/bin/gradle.bat") { "$MeloTools/gradle-9.3.1/bin/gradle.bat" } else { './gradlew.bat' }
        $options = @(
            "-PreactNativeArchitectures=$Abi",
            "-Dorg.gradle.jvmargs=-Xmx$env:GRADLE_XMX -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8",
            "-Pkotlin.daemon.jvmargs=-Xmx$env:KOTLIN_XMX",
            '-Porg.gradle.parallel=false',
            '--init-script', "$PSScriptRoot/android-windows.init.gradle",
            '--console=plain', '--stacktrace', "--max-workers=$env:GRADLE_WORKERS"
        )
        if ($Offline) { $options += '--offline' }
        & $gradle @Tasks @options *> "$MeloRoot/verification/build/$Log"
        $result = $LASTEXITCODE
        Get-Content "$MeloRoot/verification/build/$Log" -Tail 45
        if ($result -ne 0) { throw "Android build failed; see verification/build/$Log" }
    } finally { Pop-Location }
} finally {
    $env:MELO_KEYSTORE = $previousKey
    $env:MELO_KEYSTORE_PASSWORD = $previousPassword
    $signing = $null
}
