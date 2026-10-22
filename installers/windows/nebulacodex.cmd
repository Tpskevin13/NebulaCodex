@echo off
rem Lanzador de NebulaCodex para Windows: usa el Node.js incluido en la instalacion.
setlocal
set "NEBULA_ROOT=%~dp0.."
set "NEBULA_NODE=%NEBULA_ROOT%\runtime\node.exe"
if not exist "%NEBULA_NODE%" (
  echo NebulaCodex: no se encontro el Node.js incluido en "%NEBULA_ROOT%\runtime".
  if "%~1"=="" pause
  exit /b 1
)

rem La interfaz usa caracteres Unicode: se pasa la consola a UTF-8 y se restaura al salir.
set "NEBULA_OLDCP="
for /f "tokens=2 delims=:" %%a in ('chcp 2^>nul') do set "NEBULA_OLDCP=%%a"
set "NEBULA_OLDCP=%NEBULA_OLDCP: =%"
chcp 65001 >nul 2>&1

"%NEBULA_NODE%" "%NEBULA_ROOT%\app\dist\index.js" %*
set "NEBULA_RC=%ERRORLEVEL%"

if defined NEBULA_OLDCP chcp %NEBULA_OLDCP% >nul 2>&1
if not "%NEBULA_RC%"=="0" if "%~1"=="" (
  echo.
  echo NebulaCodex termino con el codigo %NEBULA_RC%.
  pause
)
endlocal & exit /b %NEBULA_RC%
