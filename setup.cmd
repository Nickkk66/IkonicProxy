@echo off
rem Double-click launcher for the setup menu, so it does not have to be run
rem from an already-open terminal. The window stays open on failure.
cd /d "%~dp0"
node scripts\setup.js
if errorlevel 1 pause
