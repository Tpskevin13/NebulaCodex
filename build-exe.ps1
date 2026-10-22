$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$project = Join-Path $root "windows-launcher\NebulaCodex.Launcher.csproj"
$output = Join-Path $root "release"
$nugetConfig = Join-Path $root "NuGet.Config"

# Mantiene la configuración y las cachés de compilación dentro del proyecto.
$env:DOTNET_CLI_HOME = Join-Path $root ".dotnet-home"
$env:NUGET_PACKAGES = Join-Path $root ".nuget\packages"
$env:APPDATA = Join-Path $root ".appdata\roaming"
$env:LOCALAPPDATA = Join-Path $root ".appdata\local"
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = "1"
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$env:DOTNET_NOLOGO = "1"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw "Falta el SDK de .NET 10 para generar NebulaCodex.exe."
}

& dotnet restore $project --configfile $nugetConfig --ignore-failed-sources --nologo
if ($LASTEXITCODE -ne 0) {
  throw "Falló la restauración del proyecto del lanzador (código $LASTEXITCODE)."
}

& dotnet publish $project --configuration Release --self-contained false --output $output -p:UseAppHost=true --no-restore --nologo
if ($LASTEXITCODE -ne 0) {
  throw "Falló la generación del ejecutable (código $LASTEXITCODE)."
}

Write-Host "Ejecutable generado: $(Join-Path $output 'NebulaCodex.exe')" -ForegroundColor Green
