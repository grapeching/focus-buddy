@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 goto NOPY

echo ============================================
echo  专注伙伴 - 休息测试版 (REST TEST BUILD)
echo ============================================
echo.
echo Starting local server on http://127.0.0.1:8849 ...
start "focus-buddy-rest-test" /min cmd /c "python serve.py 8849"
timeout /t 2 >nul

set "URL=http://127.0.0.1:8849/rest-test.html"

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=%URL% --window-size=1500,900
  goto DONE
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app=%URL% --window-size=1500,900
  goto DONE
)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=%URL% --window-size=1500,900
  goto DONE
)
start "" "%URL%"

:DONE
echo.
echo Opened REST TEST page in an app-style window.
echo This is separate from the official version (start.bat / index.html).
echo A minimized window named "focus-buddy-rest-test" keeps the server running.
echo Close that server window to stop.
echo.
pause
goto :EOF

:NOPY
echo Python not found.
echo Install Python from https://www.python.org/downloads/ then run this file again.
echo (Or visit http://127.0.0.1:8127/rest-test.html if the test server is already running.)
pause
