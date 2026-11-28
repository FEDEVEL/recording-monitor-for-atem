# Changelog

## 0.3.0 (2026-11-28)
### Added
- **Beacon dot**: a small always-on-top status dot you drag next to your guest's video (red = recording, yellow = warning, blue = cursor, flashing = stopped). Click it to bring the app to the front; size in ⚙; it never moves or resizes by itself
- **Screen frame on stop**: a flashing red frame around all monitors when the recording stops, until OK (not for a lost connection, as the ATEM may still be recording). Clicks pass through it

### Changed
- **Calm while recording**: dark background with a steady red ● (red = recording, like a camera); nothing blinks while everything is OK and the audio meters are dimmed. Only problems flash
- **Cursor warning** is much more visible: the whole status area flashes blue with "MOVE CURSOR HERE"
- Smoke test also checks the beacon dot and the screen frame

## 0.2.1 (2026-11-26)
### Added
- Automated smoke test against a real ATEM (`npm run smoke-test`), ~50 checks, refuses to run while recording

### Fixed
- Brief yellow "NO CONNECTION" flash when a recording starts: the ATEM sometimes resets its connection for a fraction of a second. Interruptions shorter than 2 s are now ignored (and logged); a real outage still raises the alarm after 2 s

### Changed
- Sounds that can happen while someone is talking are **off by default** (warnings, marks, connection lost/restored, cursor) and can be enabled in ⚙ → *Extra sounds*; they may end up in the recording
- *Test alerts* has a *Lost connection alarm*
- "On top" renamed to **Always on top**

## 0.2.0 (2026-11-26)
### Changed
- Renamed from "ATEM Recording Alert" to **Recording Monitor for ATEM**; existing settings and logs are moved automatically
- Interview **↺ Resume** continues from the value at *End*; the paused time is not counted (logged in the session file)

### Added
- "✕ Ignore" for yellow warnings: temporary; they come back when worse (low disk: 15/10/5 min), after 10 min, or with the next recording
- About line in ⚙ with version, license, GitHub link and a manual "Check for updates"
- Close protection while recording or during an interview ("Keep watching / Quit anyway")
- Crash recovery for the display, logging of unexpected errors
- Single instance: starting the app again brings the existing window to the front
- Alarms bring the window to the front and flash the taskbar
- Window position remembered per monitor setup; off-screen positions are never used
- Security hardening: sandbox, no navigation, no popups, no permissions
- Clock-jump correction for timers, safe settings saving, memory use in the log
- App icon, version number in ⚙, demo mode for screenshots
- Automatic cleanup: logs after 90 days, session files after 365 days
- Audio meters switch (lowest CPU use when off)

### Changed
- Much lower CPU use (meters 10×/s without animations, only changed parts are redrawn, cursor check once per second)

## 0.1.0 (2026-11-26)
### Added
- Recording status display with alarms and sounds for any recording stop, unexpected stops and lost connection
- Yellow warnings (low disk, disk problems, ATEM error flags, no audio, not connected)
- Interview timer with marks, Resume and Resume previous; counts only while recording
- ATEM timecode and session files per recording
- Cursor check during interviews
- Audio meters, event log, responsive layout down to very small windows
