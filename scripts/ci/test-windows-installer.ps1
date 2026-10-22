# Prueba el instalador de Windows en una máquina real: instala en silencio, comprueba accesos directos,
# PATH y registro, abre la app, desinstala y prueba también la versión portátil.
# Uso: test-windows-installer.ps1 -Installer <setup.exe> -Portable <portable.zip> -Version <x.y.z>
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Portable,
  [Parameter(Mandatory = $true)][string]$Version
)
$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  Write-Host "::error title=Instalador de Windows::$message"
  exit 1
}
function Assert([bool]$condition, [string]$message) {
  if (-not $condition) { Fail $message }
  Write-Host "ok: $message"
}
function Invoke-Cmd([string]$line) {
  # Ejecuta una línea de cmd.exe (las rutas del runner no llevan espacios) y devuelve @{ Output; Code }
  $out = & cmd.exe /d /c $line 2>&1
  return @{ Output = ($out | Out-String).Trim(); Code = $LASTEXITCODE }
}

try {
  $temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
  $dir = Join-Path $temp 'NebulaCodexInstalado'
  $log = Join-Path $temp 'nebulacodex-setup.log'
  $installerPath = (Resolve-Path $Installer).Path
  $portablePath = (Resolve-Path $Portable).Path

  Write-Host "== instalar en silencio"
  $p = Start-Process -FilePath $installerPath -Wait -PassThru -ArgumentList @(
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/DIR=$dir", "/LOG=$log", '/TASKS=desktopicon,addtopath')
  if ($p.ExitCode -ne 0) {
    if (Test-Path $log) { Get-Content $log -Tail 40 | ForEach-Object { Write-Host $_ } }
    Fail "el instalador terminó con código $($p.ExitCode)"
  }
  Assert (Test-Path "$dir\bin\nebulacodex.cmd") 'bin\nebulacodex.cmd instalado'
  Assert (Test-Path "$dir\runtime\node.exe") 'runtime\node.exe instalado'
  Assert (Test-Path "$dir\app\dist\index.js") 'app\dist\index.js instalado'
  Assert (Test-Path "$dir\nebulacodex.ico") 'icono instalado'
  Assert (Test-Path "$dir\unins000.exe") 'desinstalador instalado'

  Write-Host "== versión y ayuda"
  $r = Invoke-Cmd "$dir\bin\nebulacodex.cmd --version"
  Assert ($r.Code -eq 0 -and $r.Output -eq "NebulaCodex $Version") "--version devuelve 'NebulaCodex $Version' (obtuve: '$($r.Output)')"
  $r = Invoke-Cmd "$dir\bin\nebulacodex.cmd --help"
  Assert ($r.Output -match '/providers') '--help menciona /providers'
  $r = Invoke-Cmd "$dir\bin\nebulacodex.cmd < NUL"
  Assert ($r.Output -match 'terminal interactiva') 'sin terminal interactiva la app avisa y sale (arranca bien con el Node incluido)'

  Write-Host "== accesos directos, PATH y registro"
  $shell = New-Object -ComObject WScript.Shell
  $desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'NebulaCodex.lnk'
  $menuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'NebulaCodex.lnk'
  Assert (Test-Path $desktopLink) 'acceso directo en el escritorio'
  Assert (Test-Path $menuLink) 'acceso directo en el menú Inicio'
  $target = $shell.CreateShortcut($desktopLink).TargetPath
  Assert ($target -ieq "$dir\bin\nebulacodex.cmd") "el acceso directo apunta a nebulacodex.cmd (apunta a '$target')"
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | ForEach-Object { $_.TrimEnd('\') }
  Assert ($userPath -contains "$dir\bin") 'el PATH del usuario incluye la carpeta bin'
  $uninstallKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { $_.PSChildName -like '{B3E5C0D2-6F0A-4C57-9B7E-2D4A1F8E7C31}*' }
  Assert ($null -ne $uninstallKey) 'entrada en Aplicaciones instaladas (desinstalar)'
  Assert ((Get-ItemProperty $uninstallKey.PSPath).DisplayVersion -eq $Version) 'la versión instalada figura en el registro'

  Write-Host "== desinstalar en silencio"
  Start-Process -FilePath "$dir\unins000.exe" -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait
  # El desinstalador se relanza desde una copia temporal: se espera a que termine de borrar.
  $deadline = (Get-Date).AddSeconds(90)
  while ((Test-Path $dir) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 2 }
  Assert (-not (Test-Path $dir)) 'se borró la carpeta de instalación'
  Assert (-not (Test-Path $desktopLink)) 'se borró el acceso directo del escritorio'
  Assert (-not (Test-Path $menuLink)) 'se borró el acceso directo del menú Inicio'
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | ForEach-Object { $_.TrimEnd('\') }
  Assert (-not ($userPath -contains "$dir\bin")) 'se quitó la carpeta bin del PATH'

  Write-Host "== versión portátil"
  $portableDir = Join-Path $temp 'NebulaCodexPortable'
  if (Test-Path $portableDir) { Remove-Item $portableDir -Recurse -Force }
  Expand-Archive -Path $portablePath -DestinationPath $portableDir
  $launcher = Get-ChildItem $portableDir -Recurse -Filter 'NebulaCodex.cmd' | Select-Object -First 1
  Assert ($null -ne $launcher) 'NebulaCodex.cmd presente en el .zip'
  $r = Invoke-Cmd "$($launcher.FullName) --version"
  Assert ($r.Code -eq 0 -and $r.Output -eq "NebulaCodex $Version") "la versión portátil devuelve 'NebulaCodex $Version' (obtuve: '$($r.Output)')"

  Write-Host "Instalador de Windows: todo OK"
} catch {
  Fail ($_ | Out-String)
}
