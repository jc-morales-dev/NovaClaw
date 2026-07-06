# Build de NovaClaw para Android: UI (vite) + agente (esbuild) -> assets/agent.zip -> APK
# Uso:  pwsh scripts/build-android.ps1 [-SkipUi] [-SkipApk] [-Release]
param([switch]$SkipUi, [switch]$SkipApk, [switch]$Release)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$agentBuild = Join-Path $root "android-native\agent-build"
$assets = Join-Path $root "android-native\app\src\main\assets"
New-Item -ItemType Directory -Force $agentBuild | Out-Null

Set-Location $root

if (-not $SkipUi) {
    Write-Host "[1/4] vite build (UI)..." -ForegroundColor Cyan
    npx vite build | Out-Null
}

Write-Host "[2/4] esbuild (agente autocontenido)..." -ForegroundColor Cyan
npx esbuild server.ts --bundle --platform=node --target=node18 `
    --outfile="$agentBuild\agent.cjs" --format=cjs --external:vite `
    --external:bufferutil --external:utf-8-validate | Out-Null

Write-Host "[3/4] empaquetar agent.zip..." -ForegroundColor Cyan
if (Test-Path "$agentBuild\dist") { Remove-Item -Recurse -Force "$agentBuild\dist" }
Copy-Item -Recurse -Force "$root\dist" "$agentBuild\dist"
$zip = Join-Path $assets "agent.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "$agentBuild\agent.cjs","$agentBuild\dist" -DestinationPath $zip -CompressionLevel Optimal
$mb = [math]::Round((Get-Item $zip).Length/1MB,2)
Write-Host "    agent.zip = $mb MB" -ForegroundColor Green

if (-not $SkipApk) {
    Write-Host "[4/4] compilar APK..." -ForegroundColor Cyan
    # Auto-detecta un JDK 21 válido. No confía en un $env:JAVA_HOME preexistente
    # porque suele quedar apuntando a una versión que ya se actualizó/borró.
    if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
        $env:JAVA_HOME = (Get-ChildItem "C:\Program Files\Eclipse Adoptium" -Directory | Where-Object Name -like "jdk-21*" | Sort-Object Name -Descending | Select-Object -First 1).FullName
    }
    Set-Location (Join-Path $root "android-native")
    if ($Release) {
        .\gradlew.bat :app:assembleRelease --no-daemon
        $apk = Join-Path $root "android-native\app\build\outputs\apk\release\app-release.apk"
    } else {
        .\gradlew.bat :app:assembleDebug --no-daemon
        $apk = Join-Path $root "android-native\app\build\outputs\apk\debug\app-debug.apk"
    }
    $apkMb = [math]::Round((Get-Item $apk).Length/1MB,1)
    Write-Host "APK listo: $apk ($apkMb MB)" -ForegroundColor Green
}
