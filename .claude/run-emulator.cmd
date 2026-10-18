@echo off
for %%I in ("%~dp0..") do set "GAME_DIR=%%~fI"
if not defined EMULATOR_DIR set "EMULATOR_DIR=%GAME_DIR%\..\Translator_emulator"
set "EMU_PLAYERS=2"
set "EMU_CARDS=local"
rem Ports are assigned in memdecks_data/ports.json so several games can run at once.
set "EMU_PORT=4106"
set "EMU_GAME_PORT=4006"
set "EMU_CLIENT_PORT=5178"
cd /d "%EMULATOR_DIR%"
call npm start
