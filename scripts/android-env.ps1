$ErrorActionPreference = 'Stop'
$script:MeloRoot = Split-Path $PSScriptRoot -Parent
$script:MeloTools = if ($env:MELO_TOOLCHAIN_ROOT) { $env:MELO_TOOLCHAIN_ROOT } else { "$MeloRoot/experiments/phase2/vendor" }
if (!$env:JAVA_HOME -or !(Test-Path "$env:JAVA_HOME/bin/javac.exe")) { $env:JAVA_HOME = "$MeloTools/jdk/jdk-17.0.20.1+1" }
if (!$env:ANDROID_HOME) { $env:ANDROID_HOME = "$MeloTools/android-sdk" }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
if (!$env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME = "$MeloTools/gradle-home" }
$env:ANDROID_USER_HOME = "$MeloTools/android-user"
$env:TEMP = "$MeloTools/tmp"
$env:TMP = $env:TEMP
$env:EXPO_NO_TELEMETRY = '1'
$env:SENTRY_DISABLE_AUTO_UPLOAD = 'true'
if (!$env:GRADLE_XMX) { $env:GRADLE_XMX = '1536m' }
if (!$env:KOTLIN_XMX) { $env:KOTLIN_XMX = '512m' }
if (!$env:GRADLE_WORKERS) { $env:GRADLE_WORKERS = '1' }
if (!$env:CMAKE_BUILD_PARALLEL_LEVEL) { $env:CMAKE_BUILD_PARALLEL_LEVEL = '1' }
$env:JAVA_TOOL_OPTIONS = "-Djava.io.tmpdir=$($env:TEMP.Replace('\','/')) -Dhttps.protocols=TLSv1.2"
New-Item -ItemType Directory -Force "$MeloRoot/verification/build",$env:TEMP | Out-Null
