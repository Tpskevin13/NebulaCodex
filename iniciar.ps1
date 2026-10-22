param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $AppArguments
)

$ErrorActionPreference = "Stop"
try { $Host.UI.RawUI.WindowTitle = "NebulaCodex" } catch { }
try {
  $raw = $Host.UI.RawUI
  $maxSize = $raw.MaxPhysicalWindowSize
  # Un tamaño fijo amplio evita abrir casi a pantalla completa y mantiene estable el primer render.
  $width = [Math]::Min(120, $maxSize.Width)
  $height = [Math]::Min(34, $maxSize.Height)
  $bufferWidth = [Math]::Max($raw.BufferSize.Width, $width)
  $bufferHeight = [Math]::Max($raw.BufferSize.Height, $height)
  $raw.BufferSize = [System.Management.Automation.Host.Size]::new($bufferWidth, $bufferHeight)
  $raw.WindowSize = [System.Management.Automation.Host.Size]::new($width, $height)
} catch { }
$app = $PSScriptRoot

# Cuando el script se ejecuta desde release/, la aplicación está en la carpeta padre.
if (-not (Test-Path -LiteralPath (Join-Path $app "package.json"))) {
  $parent = Split-Path -Parent $app
  if (Test-Path -LiteralPath (Join-Path $parent "package.json")) {
    $app = $parent
  }
}

$work = if ($env:NEBULACODEX_WORKDIR) { $env:NEBULACODEX_WORKDIR } else { $env:USERPROFILE }
if (-not $work -or -not (Test-Path -LiteralPath $work)) {
  $work = "$($env:SystemDrive)\"
}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Falta Node.js 18 o mayor. Instalalo desde https://nodejs.org y volvé a abrir NebulaCodex." -ForegroundColor Red
  Read-Host "Presiona Enter para cerrar" | Out-Null
  exit 1
}
$nodeVersion = (& node --version 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v?(\d+)\.') {
  Write-Host "No pude detectar la versión de Node.js. Instalá Node.js 18 o mayor." -ForegroundColor Red
  Read-Host "Presiona Enter para cerrar" | Out-Null
  exit 1
}
if ([int]$Matches[1] -lt 18) {
  Write-Host "NebulaCodex necesita Node.js 18 o mayor; está instalada la versión $nodeVersion." -ForegroundColor Red
  Read-Host "Presiona Enter para cerrar" | Out-Null
  exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "No se encontró npm. Reinstalá Node.js 18 o mayor con npm incluido." -ForegroundColor Red
  Read-Host "Presiona Enter para cerrar" | Out-Null
  exit 1
}

Push-Location -LiteralPath $app
try {
  $modules = Join-Path $app "node_modules"
  $lock = Join-Path $app "package-lock.json"
  $installMarker = Join-Path $modules ".package-lock.json"
  $needsInstall = -not (Test-Path -LiteralPath $modules)
  if (-not $needsInstall -and (Test-Path -LiteralPath $lock)) {
    $needsInstall = -not (Test-Path -LiteralPath $installMarker) -or
      ((Get-Item -LiteralPath $lock).LastWriteTime -gt (Get-Item -LiteralPath $installMarker).LastWriteTime)
  }
  if ($needsInstall) {
    Write-Host "Instalando dependencias..."
    & npm install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) {
      throw "Falló la instalación de dependencias (código $LASTEXITCODE)."
    }
  }

  $entry = Join-Path $app "dist\index.js"
  $needsBuild = -not (Test-Path -LiteralPath $entry)
  if (-not $needsBuild) {
    $entryTime = (Get-Item -LiteralPath $entry).LastWriteTime
    $source = Get-ChildItem -LiteralPath (Join-Path $app "src") -Recurse -File |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $configTime = (Get-Item -LiteralPath (Join-Path $app "tsconfig.json")).LastWriteTime
    $needsBuild = ($source -and $source.LastWriteTime -gt $entryTime) -or ($configTime -gt $entryTime)
  }
  if ($needsBuild) {
    Write-Host "Compilando NebulaCodex..."
    & npm run build --silent
    if ($LASTEXITCODE -ne 0) {
      throw "Falló la compilación (código $LASTEXITCODE)."
    }
  }
}
catch {
  Write-Host "No se pudo iniciar NebulaCodex: $_" -ForegroundColor Red
  Read-Host "Presiona Enter para cerrar" | Out-Null
  exit 1
}
finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $work)) {
  Write-Host "No se encontró la carpeta de trabajo: $work" -ForegroundColor Red
  Read-Host "Presiona Enter para cerrar" | Out-Null
  exit 1
}
Set-Location -LiteralPath $work

$entry = Join-Path $app "dist\index.js"
& node $entry @AppArguments
exit $LASTEXITCODE
