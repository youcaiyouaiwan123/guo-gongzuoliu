@echo off
REM Haixin AI desktop entry. Usage: haixin.cmd <start|stop|open>; no arg = start.
REM Keep this file PURE ASCII: chcp 65001 + non-ASCII bytes here desync cmd.exe parsing.
REM Chinese messages come from fetch-runtime.ps1 and launcher.mjs (their own UTF-8 output).
setlocal enableextensions
chcp 65001 >nul

set "HX=%LOCALAPPDATA%\HaixinAI"
set "NODE=%HX%\runtime\node.exe"
set "WRANGLER=%HX%\node_modules\wrangler\bin\wrangler.js"
set "LOGDIR=%HX%\logs"
set "LOG=%LOGDIR%\launch.log"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=start"

if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
echo.>> "%LOG%"
echo ==== %DATE% %TIME%  mode=%MODE% ====>> "%LOG%"
echo HX=%HX%>> "%LOG%"

if not exist "%NODE%" goto noruntime
if not exist "%WRANGLER%" goto noruntime
goto run

:noruntime
REM Runtime not present yet: stop/open are no-ops (never started); do not trigger a download.
if /I "%MODE%"=="stop" ( echo Haixin AI is not running.& echo [noruntime] stop skipped>> "%LOG%" & goto done_ok )
if /I "%MODE%"=="open" ( echo Haixin AI is not running; start it first.& echo [noruntime] open skipped>> "%LOG%" & goto done_ok )

echo.
echo ============================================================
echo   Haixin AI first run: preparing runtime (download ~82MB).
echo   Please keep your network connected.
echo ============================================================
echo.
echo [fetch] downloading runtime...>> "%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch-runtime.ps1" 2>&1
set "RC=%errorlevel%"
echo [fetch] powershell rc=%RC%>> "%LOG%"
if not "%RC%"=="0" (
  echo.
  echo [FAILED] Could not prepare the runtime ^(code %RC%^).
  echo   1. This PC cannot reach the download server ^(try another network / disable proxy^).
  echo   2. Antivirus blocked it. Add %HX% to the whitelist and retry.
  echo Log: %LOG%
  echo.
  pause
  goto done_fail
)
if not exist "%NODE%" (
  echo [FAILED] node.exe missing after download ^(possibly removed by antivirus^). Whitelist %HX% and retry.
  echo [fetch] node.exe missing after download>> "%LOG%"
  pause
  goto done_fail
)

:run
echo [run] "%NODE%" launcher.mjs %MODE%>> "%LOG%"
"%NODE%" "%~dp0..\launcher.mjs" %MODE%
set "RC=%errorlevel%"
echo [run] launcher rc=%RC%>> "%LOG%"
if not "%RC%"=="0" (
  echo.
  echo [FAILED] Haixin AI failed to start ^(code %RC%^). The real reason is printed above.
  echo Logs: %LOGDIR%\supervisor-boot.log  and  %LOGDIR%\supervisor.log
  echo.
  pause
  goto done_fail
)
goto done_ok

:done_fail
endlocal
exit /b 1

:done_ok
endlocal
exit /b 0
