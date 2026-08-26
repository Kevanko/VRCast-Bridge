@echo off
setlocal enabledelayedexpansion
set SHARE=C:\Users\WDAGUtilityAccount\Desktop\vrcast
set LOG=%SHARE%\started.txt
echo start %DATE% %TIME% > "%LOG%"

copy /y "%SHARE%\VRCast Bridge.exe" "C:\Windows\Temp\VRCastSetup.exe" >> "%LOG%" 2>&1
echo installing %TIME% >> "%LOG%"
start "" "C:\Windows\Temp\VRCastSetup.exe" --install

set APP=%LOCALAPPDATA%\Programs\VRCast Bridge\VRCast Bridge.exe
set /a TRY=0
:wait_app
ping -n 6 127.0.0.1 > nul
set /a TRY+=1
if exist "%APP%" goto app_ready
if !TRY! GEQ 60 goto no_app
goto wait_app

:no_app
echo FAIL: app not installed in 5 min >> "%LOG%"
goto finish

:app_ready
echo installed %TIME% >> "%LOG%"

set NODEEXE=
set /a TRY=0
:wait_node
ping -n 6 127.0.0.1 > nul
set /a TRY+=1
if exist "%LOCALAPPDATA%\VRCastBridge\node\node.exe" set NODEEXE=%LOCALAPPDATA%\VRCastBridge\node\node.exe
if defined NODEEXE goto run
if !TRY! GEQ 150 goto no_node
goto wait_node

:no_node
echo FAIL: node not found in 15 min >> "%LOG%"
goto finish

:run
echo node ready %TIME% >> "%LOG%"
copy /y "%SHARE%\scenario.js" "C:\Windows\Temp\scenario.mjs" > nul
"%NODEEXE%" "C:\Windows\Temp\scenario.mjs" > "%SHARE%\scenario-output.txt" 2>&1
echo scenario finished %TIME% >> "%LOG%"

:finish
copy /y "%LOCALAPPDATA%\VRCastBridge\launcher.log" "%SHARE%\sandbox-launcher.log" > nul 2>&1
copy /y "%LOCALAPPDATA%\VRCastBridge\vrcast.log" "%SHARE%\sandbox-vrcast.log" > nul 2>&1
copy /y "%LOCALAPPDATA%\VRCastBridge\crash.log" "%SHARE%\sandbox-crash.log" > nul 2>&1
echo done %TIME% >> "%LOG%"
