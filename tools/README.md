# Offline Python report

Export sessions from **Laporan saya**, then run:

```powershell
python tools\session_report.py publicspeak-sessions.json
python -m unittest discover -s tools
```

Uses Python 3.10+ and the standard library only.

## Run the local camera-analysis app

On Windows, double-click `start_publicspeak.bat`. The first run creates a
Python 3.13 virtual environment and installs the dependencies; leave its
terminal window open while using the app. Then open `http://127.0.0.1:8000`.

To run it manually from the project folder in PowerShell:

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8000
```

On first start, the backend downloads the three MediaPipe models into
`.cache\mediapipe`; an internet connection is needed for this one-time download.
Allow camera access in the browser when prompted. Camera frames are analyzed in
memory on the same device and are not written to disk or sent to a hosted
service. The web page and its JSON API are served from this one local process.
