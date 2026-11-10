@echo off
rem Visitor Sign-In on this PC: double-click to start it, and keep this window open.
rem Needs Node.js 22 or newer from https://nodejs.org/ (the LTS installer).
cd /d "%~dp0\.."
where node >nul 2>nul || (echo Install Node.js from https://nodejs.org/ first, then double-click this again. & pause & exit /b 1)
node server\visitor-server.mjs %*
pause
