@echo off
rem Launch the document builder server and open the app in a browser.
rem Double-click this file, or run it from a terminal. Close the window to stop.
rem Reports root and template config are auto-detected from .\local (override with
rem extra args, e.g.  start.bat --port 9000  or  start.bat --root D:\path).
cd /d "%~dp0"
echo Starting document builder...  (close this window to stop the server)
.venv\Scripts\python.exe builder\server.py --open %*
