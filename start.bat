@echo off
setlocal
cd /d "%~dp0"

rem Keep this file ASCII only. cmd.exe mis-parses batch files that contain
rem UTF-8 CJK text: it drops a few bytes at some line starts, which turns the
rem line into a bogus command (e.g. "echo xxx" becomes "'xxx' is not
rem recognized"). English messages here, Chinese docs in HANDOFF.md.

rem Inherited from Electron-based terminals: makes electron.exe run as node.
set "ELECTRON_RUN_AS_NODE="

rem A second instance would quit immediately and focus the old window, which
rem runs the OLD code. Ask the user to close the running one first.
powershell -NoProfile -Command "if (Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '%~dp0*' }) { exit 1 }"
if errorlevel 1 (
  echo Workspace Bridge is already running.
  echo Close the app window first, then run this file again.
  pause
  exit /b 1
)

rem Dependencies are installed once. If node_modules is there, skip.
if not exist "node_modules\" (
  echo [1/3] Installing dependencies, first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed. See the errors above.
    pause
    exit /b 1
  )
)

rem npm 11 does not run install scripts by default, so electron may be missing.
if not exist "node_modules\electron\dist\electron.exe" (
  echo [2/3] Downloading Electron...
  call node node_modules\electron\install.js
  if errorlevel 1 (
    echo Electron download failed. See the errors above.
    pause
    exit /b 1
  )
)

rem Rebuild only when a source file is newer than the last build output.
rem Use "start.bat build" to force a rebuild.
set "FORCE="
if /i "%~1"=="build" set "FORCE=1"
if defined FORCE goto do_build
powershell -NoProfile -Command "$out = Get-Item 'out\main\index.js' -ErrorAction SilentlyContinue; if (-not $out) { exit 1 }; $src = Get-ChildItem 'src','electron.vite.config.ts','package.json','tsconfig.json' -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($src -and $src.LastWriteTime -gt $out.LastWriteTime) { exit 1 }; exit 0"
if errorlevel 1 goto do_build

echo [3/3] Sources unchanged, skipping build.
goto launch

:do_build
echo [3/3] Building...
call npm run build
if errorlevel 1 (
  echo Build failed. See the errors above.
  pause
  exit /b 1
)

:launch
echo Starting...
start "" "node_modules\electron\dist\electron.exe" .
