param(
    [Parameter(Mandatory=$true)][string]$SourceDirectory,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$Jdk = $env:JAVA_HOME
)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $SourceDirectory).Path
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputRoot) { throw 'Use a new output directory; existing builds are never overwritten.' }
if (!(Test-Path -LiteralPath "$Jdk/bin/javac.exe")) { throw 'Set -Jdk or JAVA_HOME to a JDK (tested with JDK 17, Java 8 target).' }
$javaFiles = @(Get-ChildItem -LiteralPath $sourceRoot -Filter '*.java' -Recurse -File)
if (!$javaFiles.Count) { throw 'No Java source files found' }
$classes = Join-Path $outputRoot 'classes'
New-Item -ItemType Directory -Path $classes | Out-Null
$argumentsFile = Join-Path $outputRoot 'sources.txt'
$argumentsText = ($javaFiles | ForEach-Object { '"' + $_.FullName.Replace('\','/') + '"' }) -join "`n"
[IO.File]::WriteAllText($argumentsFile, $argumentsText, [Text.UTF8Encoding]::new($false))
& "$Jdk/bin/javac.exe" -encoding UTF-8 --release 8 -d $classes "@$argumentsFile"
if ($LASTEXITCODE -ne 0) { throw 'Jaudiotagger compilation failed' }
Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Where-Object { $_.Extension -ne '.java' } | ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($sourceRoot, $_.FullName)
    $target = Join-Path $classes $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target
}
& "$Jdk/bin/jar.exe" --create --file (Join-Path $outputRoot 'jaudiotagger-3.0.1.jar') -C $classes .
if ($LASTEXITCODE -ne 0) { throw 'Jaudiotagger packaging failed' }
Get-FileHash -LiteralPath (Join-Path $outputRoot 'jaudiotagger-3.0.1.jar') -Algorithm SHA256
