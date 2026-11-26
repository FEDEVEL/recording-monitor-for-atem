# Changelog

## Unreleased
### Changed
- Sounds that can happen while someone is talking are **off by default** (warnings, marks, connection lost/restored, cursor) and can be enabled in ⚙ → *Extra sounds*; they may end up in the recording
- *Test alerts* has a *Lost connection alarm*
- "On top" renamed to **Always on top**

## 0.2.0 (2026-11-26)
### Changed
- Renamed from "ATEM Recording Alert" to **Recording Monitor for ATEM**; existing settings and logs are moved automatically

### Changed
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
