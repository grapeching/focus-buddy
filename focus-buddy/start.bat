@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 goto NOPY

echo Starting local server on http://127.0.0.1:8848 ...
start "focus-buddy-server" /min cmd /c "python serve.py 8848"
timeout /t 2 >nul

set "URL=http://127.0.0.1:8848/index.html"

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=%URL% --window-size=1400,880
  goto DONE
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app=%URL% --window-size=1400,880
  goto DONE
)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=%URL% --window-size=1400,880
  goto DONE
)
start "" "%URL%"

:DONE
echo.
echo Opened in an app-style window (no browser toolbar).
echo A minimized window named "focus-buddy-server" keeps running - close it to stop.
echo.
pause
goto :EOF

:NOPY
echo Python not found.
echo Install Python from https://www.python.org/downloads/ then run this file again.
echo (Any static server works - this app is plain HTML/JS, no build step.)
pause
