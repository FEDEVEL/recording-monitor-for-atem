# ATEM Recording Alert

Small desktop app that watches an **ATEM Mini Pro ISO** over the network and makes it impossible to miss
that recording has stopped.

## What it shows
- **Big status panel**
  - grey **NOT RECORDING**: idle, ready
  - green **● RECORDING 00:12:34**: recording, all fine
  - yellow **● RECORDING**: recording, but there is a warning (see the yellow bars)
  - flashing red **RECORDING STOPPED** / **UNEXPECTED RECORDING STOP!** / **LOST CONNECTION**: stays until you click *OK*
- **Yellow warning bars**: low disk space (< 30 min), no disk, disk unformatted/removed, ATEM error flags
  while recording (e.g. dropping frames), recording timer not advancing, no audio on MASTER for 20 s, not connected.
- **Interview timer** (blue bar): press **▶ START INTERVIEW** when the interview really begins.
  The big timer shows the interview length (independent of the recording timer). **⚑ Mark** notes a moment
  (e.g. something to cut), **■ End** stops the timer, **↺ Resume** undoes an accidental End, **▶ New** starts
  timing the next interview. Each press gives a short beep (rising = start, falling = end, blip = mark).
  The timer survives an app restart. *Start* is only possible while the ATEM is recording (greyed out otherwise);
  interview time only counts while recording, so when recording stops a running interview ends with it
  ("ended because recording stopped"). *Resume* and *New* also work only while recording. When a new recording starts, an ended interview is
  cleared; for up to 60 min a small **↺ Resume previous** button lets you continue it (the pause between recordings
  is not counted).
- **Cursor check**: while the interview timer runs, a flashing orange banner appears if the mouse cursor has been
  outside this app's window for more than 3 s (it could be visible over the cameras / shared screen in the
  recording). Optional soft beep. Both can be switched in ⚙ (*Cursor check*, *Cursor beep*).
- **Session files**: one text file per recording (⚙ → *Open session files*) with computer time, position in the
  recording file and **ATEM timecode** (the same timecode the ATEM writes into the recorded files, so it matches
  the DaVinci Resolve timeline) for: recording start, interview start/end, marks, recording stop/alarms. Useful for editing.
  A `~` before the recording time means approximate (the app was started while the ATEM was already recording).
- **Audio meters** for every channel that is switched on in the ATEM mixer, plus MASTER.

## Sounds (in your headphones, from the computer's default audio output)
| Event | Sound |
|---|---|
| Recording started | 3 short high beeps |
| Recording stopped (any stop) | 3 long low beeps |
| Stopped **with an error** (disk error/full/removed…) | 3 long beeps + siren, repeating every 6 s until *OK* |
| Lost connection to ATEM while recording | siren, repeating until *OK* |
| Connection back and still recording | rising 3 beeps |
| New yellow warning | 2 short beeps |

Use **Test alerts ▾** to hear and see every alert without touching the ATEM.

## "Unexpected" vs. normal stop
The ATEM does not say *who* pressed stop. So **every stop raises a red alert**. If the ATEM reports an error
at the moment of stopping (disk error, full, removed, unformatted, dropping frames), or the connection
dropped, it is highlighted as **UNEXPECTED** and the siren keeps going until acknowledged.

## Event log (our own "crash log")
The ATEM itself keeps no accessible crash log, so the app writes one: every connection change, every
recording state change with the raw ATEM error code and disk status, and a heartbeat line every minute
while recording. Click **Open logs**.
Old files are deleted automatically (at start and once a day): daily logs after **90 days**, session files after
**365 days** (`logRetentionDays` / `sessionRetentionDays` in `settings.json`; 0 = keep forever). Only files the
app created are touched.
- Windows: `%APPDATA%\ATEM Recording Alert\logs\`
- macOS: `~/Library/Application Support/ATEM Recording Alert/logs/`

## Running
### Windows (final setup)
Copy `dist/ATEM-Recording-Alert-<version>-portable.exe` to the PC and run it. No installation needed.
The app isn't code-signed, so Windows SmartScreen will warn the first time: click *More info → Run anyway*.
Windows Firewall may ask about network access: allow it on **private** networks (the ATEM uses UDP port 9910).

### macOS (development)
```bash
npm ci             # install the exact pinned versions from package-lock.json
npm start          # run the app
npm run probe      # print raw ATEM recording state + audio levels in the terminal
npm run dist:win   # build the Windows portable .exe into dist/
```

## Dependency safety
- All versions are **pinned exactly** in `package.json`, and `package-lock.json` holds a SHA-512 checksum
  for every package. `npm ci` installs exactly those files and fails if anything differs.
- `.npmrc` sets `ignore-scripts=true` (packages can't run code while being installed) and `save-exact=true`.
  Electron downloads its runtime on the first `npm start` instead.
- Updating is a deliberate step: `npm install <pkg>@<version>`, then `npm audit --omit=dev`.

## CPU use
Measured on an M4 Pro Mac: about **12 % of one CPU core with audio meters on**, about **0.7 % with meters off**
(⚙ → *Audio meters*). Almost all of the cost is the ATEM's audio level stream (~420 messages/s) and drawing the
meters. Switching the meters off also disables the "no audio on MASTER" warning. Cursor check runs once per second.

## Settings
IP address, *On top* and volume are in the footer. They are saved in `settings.json` next to the logs
folder. That file also holds `lowDiskWarnMinutes`, `silenceWarnSeconds` and `silenceThresholdDb` if you want to tune the warnings.

## Files
- `main.js`: ATEM connection (library [`atem-connection`](https://github.com/Sofie-Automation/sofie-atem-connection)), alert logic, logging
- `preload.js`: bridge to the UI
- `renderer/`: UI (`app.js`), sounds (`sounds.js`, generated, no audio files), styles
- `tools/probe.js`: command-line diagnostic
