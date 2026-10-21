@echo off
chcp 65001 >nul
cd /d "%~dp0"

netstat -ano | findstr ":3456" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo 本地服务已在运行，正在打开页面…
  start "" http://127.0.0.1:3456/
  exit /b
)

echo.
echo   末日回响 · 本地叙事服务
echo   ----------------------------------------
echo   启动后请访问：http://127.0.0.1:3456
echo   关闭此窗口即可停止服务
echo.
start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:3456/"
node server.js
pause
