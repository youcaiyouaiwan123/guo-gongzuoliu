@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

cd /d "%~dp0"
title 海芯 AI 本地开发服务

echo.
echo ========================================
echo   海芯 AI 本地开发服务
echo ========================================
echo.

if not exist "package.json" (
  echo [错误] 当前目录缺少 package.json：%CD%
  goto :failed
)

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 22.13.0 或更高版本。
  goto :failed
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm，请重新安装包含 npm 的 Node.js。
  goto :failed
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)"
if errorlevel 1 (
  for /f "delims=" %%V in ('node --version') do set "NODE_VERSION=%%V"
  echo [错误] 当前 Node.js 版本为 !NODE_VERSION!，项目要求 22.13.0 或更高版本。
  goto :failed
)

netstat -ano -p tcp | findstr /R /C:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo [错误] 端口 3000 已被占用，请关闭占用该端口的程序后重试。
  goto :failed
)

if not exist "node_modules\.bin\vinext.cmd" (
  echo [准备] 未检测到完整依赖，正在执行 npm ci...
  call npm ci
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络和 npm 配置。
    goto :failed
  )
)

if not defined DEFAULT_ADMIN_USERNAME set "DEFAULT_ADMIN_USERNAME=admin"
if not defined DEFAULT_ADMIN_PASSWORD set "DEFAULT_ADMIN_PASSWORD=admin123456"
if not defined PLATFORM_CREDENTIALS_KEY set "PLATFORM_CREDENTIALS_KEY=local-development-platform-key-0123456789abcdef"
if not defined HAIXIN_GATEWAY_ADMIN_SECRET set "HAIXIN_GATEWAY_ADMIN_SECRET=local-development-gateway-key-0123456789abcdef"

set "REMOVE_DEV_VARS_AFTER_EXIT=0"
if not exist ".dev.vars" (
  (
    set DEFAULT_ADMIN_USERNAME
    set DEFAULT_ADMIN_PASSWORD
    set PLATFORM_CREDENTIALS_KEY
    set HAIXIN_GATEWAY_ADMIN_SECRET
  ) > ".dev.vars"
  set "REMOVE_DEV_VARS_AFTER_EXIT=1"
  if not exist ".dev.vars" (
    echo [错误] 无法创建本地 Worker 环境配置 .dev.vars。
    goto :failed
  )
  for %%K in (DEFAULT_ADMIN_USERNAME DEFAULT_ADMIN_PASSWORD PLATFORM_CREDENTIALS_KEY HAIXIN_GATEWAY_ADMIN_SECRET) do (
    findstr /B /C:"%%K=" ".dev.vars" >nul
    if errorlevel 1 (
      echo [错误] 本地 Worker 环境配置缺少 %%K。
      goto :failed
    )
  )
)

echo [启动] 地址：http://localhost:3000
if "!REMOVE_DEV_VARS_AFTER_EXIT!"=="1" (
  echo [登录] 本地管理员：%DEFAULT_ADMIN_USERNAME%
  echo [登录] 本地密码：%DEFAULT_ADMIN_PASSWORD%
) else (
  echo [登录] 使用现有 .dev.vars 中的管理员配置。
)
echo [提示] 按 Ctrl+C 可以停止服务。
echo [提示] 服务就绪后请在浏览器打开上面的地址。
echo.

call npm run dev -- --host localhost --port 3000 --strictPort
set "DEV_EXIT_CODE=!ERRORLEVEL!"
if "!REMOVE_DEV_VARS_AFTER_EXIT!"=="1" del /q ".dev.vars" >nul 2>nul
if not "!DEV_EXIT_CODE!"=="0" (
  echo.
  echo [错误] 开发服务异常退出。
  goto :failed
)

endlocal
exit /b 0

:failed
if "!REMOVE_DEV_VARS_AFTER_EXIT!"=="1" if exist ".dev.vars" del /q ".dev.vars" >nul 2>nul
echo.
pause
endlocal
exit /b 1
