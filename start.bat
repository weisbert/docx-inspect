@echo off
rem Launch the document builder server and open the app in a browser.
rem Double-click this file, or run it from a terminal. Close the window to stop.
rem Reports root and template config are auto-detected from .\local (override with
rem extra args, e.g.  start.bat --port 9000  or  start.bat --root D:\path).
cd /d "%~dp0"
rem Force UTF-8 for Python stdio so printing U+2212 / U+26A0 etc. never hits a
rem cp936 (GBK) UnicodeEncodeError on this locale.
set PYTHONUTF8=1
echo Starting document builder...  (close this window to stop the server)
.venv\Scripts\python.exe builder\server.py --open %*
