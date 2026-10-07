@echo off
rem ============================================================
rem  XihaoUC daily collect entry point
rem  Called by the Windows Scheduled Task, or double-click to run.
rem
rem  NOTE: this file is deliberately ASCII-only and uses CRLF line
rem  endings. cmd.exe reads .cmd files in the OEM codepage and needs
rem  CRLF, so non-ASCII text here would be mis-decoded into garbage
rem  commands (that bug shipped once already - keep it ASCII).
rem  Working directory is pinned to the repo root.
rem ============================================================
setlocal
cd /d "%~dp0..\..\.."
if errorlevel 1 (
  echo [ERROR] cannot cd to repo root
  exit /b 1
)

if not exist "_daily\logs" mkdir "_daily\logs"

echo. >> "_daily\logs\scheduler.log"
echo ================ %date% %time% START ================ >> "_daily\logs\scheduler.log"

node "redesign\tools\daily\collect.mjs" %* >> "_daily\logs\scheduler.log" 2>&1
set CODE=%ERRORLEVEL%

echo ---------------- %date% %time% END (exit %CODE%) ---------------- >> "_daily\logs\scheduler.log"

rem keep a loud marker so a failed day is easy to spot
if not "%CODE%"=="0" (
  echo [%date% %time%] collect FAILED, exit code %CODE%. See _daily\logs\scheduler.log >> "_daily\logs\FAILED.log"
)

rem ---- daily Baidu push ----
rem The Baidu push API quota is only about 10 URLs/day, and publish.mjs
rem (which also pushes) is run by hand. Pushing here as well means the daily
rem quota gets spent every day instead of only on the days you publish.
if exist "_daily\baidu-push-token.txt" (
  echo ---------------- %date% %time% daily baidu push ---------------- >> "_daily\logs\scheduler.log"
  node "redesign\tools\baidu-push.mjs" --max=10 >> "_daily\logs\scheduler.log" 2>&1
)

endlocal & exit /b %CODE%
