// Recording Monitor for ATEM - main process
// Connects to the ATEM, watches recording status, decides alerts, writes an event log.
const { app, BrowserWindow, ipcMain, shell, powerSaveBlocker, screen, dialog, session, net } = require('electron')
const path = require('path')
const fs = require('fs')
const { Atem } = require('atem-connection')

// ---------- Constants (values from the ATEM protocol) ----------
const REC_STATE = { 0: 'idle', 1: 'recording', 128: 'stopping' }
const REC_ERROR_NONE = 2
const REC_ERRORS = [
  // [bit, short name, human text]
  [4, 'MediaFull', 'Disk is full'],
  [8, 'MediaError', 'Disk error (disk disconnected or failed?)'],
  [16, 'MediaUnformatted', 'Disk is not formatted'],
  [32, 'DroppingFrames', 'Dropping frames (disk too slow?)'],
  [32768, 'Unknown', 'Unknown recording error'],
]
const DISK_STATUS = { 1: 'idle', 2: 'unformatted', 4: 'active', 8: 'recording', 32: 'removed' }
const PROJECT_URL = 'https://github.com/FEDEVEL/recording-monitor-for-atem'
const LATEST_RELEASE_API = 'https://api.github.com/repos/FEDEVEL/recording-monitor-for-atem/releases/latest'
const AUDIO_NAMES = { 1: 'HDMI 1', 2: 'HDMI 2', 3: 'HDMI 3', 4: 'HDMI 4', 1301: 'Mic 1', 1302: 'Mic 2' }

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  ip: '192.168.0.40',
  alwaysOnTop: false,
  bounds: { width: 900, height: 900 },
  lowDiskWarnMinutes: 30,
  silenceWarnSeconds: 20,
  silenceThresholdDb: -50,
  volume: 0.6,
  cursorCheck: true, // warn when the mouse leaves this window during an interview
  cursorBeep: false, // ...and beep
  cursorGraceSeconds: 3,
  audioMeters: true, // off = ATEM stops sending audio levels (lowest CPU)
  warnIgnoreMinutes: 10, // an ignored yellow warning comes back after this time at the latest
  logRetentionDays: 90, // daily logs (atem-alert-YYYY-MM-DD.log) older than this are deleted
  sessionRetentionDays: 365, // session files (logs/sessions/*.txt) older than this are deleted
}
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
let settings = { ...DEFAULT_SETTINGS }
function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
}
function saveSettings() {
  try {
    // write to a temp file first, then rename: a crash mid-save can't leave a half-written settings file
    const tmp = settingsFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2))
    fs.renameSync(tmp, settingsFile())
  } catch (e) {
    log('ERROR', 'Could not save settings: ' + e.message)
  }
}

// ---------- Event log (our own "crash log") ----------
const logDir = () => path.join(app.getPath('userData'), 'logs')
const pad = (n, w = 2) => String(n).padStart(w, '0')
// Local date/time with UTC offset, e.g. 2026-11-26 10:19:39.123 +01:00
function localStamp(d = new Date()) {
  const off = -d.getTimezoneOffset()
  const tz = (off >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60)
  return `${localDate(d)} ${localTime(d)}.${pad(d.getMilliseconds(), 3)} ${tz}`
}
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
function log(level, msg, data) {
  const now = new Date()
  const line =
    `${localStamp(now)} [${level}] ${msg}` +
    (data ? ' ' + JSON.stringify(data, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) : '')
  console.log(line)
  try {
    fs.mkdirSync(logDir(), { recursive: true })
    const day = localDate(now)
    fs.appendFileSync(path.join(logDir(), `atem-alert-${day}.log`), line + '\n')
  } catch {
    /* ignore */
  }
  send('log', { time: now.getTime(), level, msg })
}

// ---------- Session file: one readable file per recording, for editing later ----------
// e.g. logs/sessions/2026-11-26 10-15-02 Test 1.txt
let sessionFile = null
function startSession(title) {
  const d = new Date()
  const safe = String(st.rec.filename || 'recording').replace(/[^\w\- ]+/g, '_').slice(0, 60)
  const dir = path.join(logDir(), 'sessions')
  try {
    fs.mkdirSync(dir, { recursive: true })
    sessionFile = path.join(dir, `${localDate(d)} ${localTime(d).replace(/:/g, '-')} ${safe}.txt`)
    fs.appendFileSync(
      sessionFile,
      `ATEM session log - ${title}\nDate: ${localDate(d)}   ATEM file name: ${st.rec.filename || '?'}\n` +
        `Columns: computer clock | position in recording file | ATEM timecode (as in the recorded files) | event\n\n`
    )
  } catch (e) {
    log('ERROR', 'Could not create session file: ' + e.message)
    sessionFile = null
  }
}
function sessionWrite(event, atStop = false) {
  if (!sessionFile) startSession('started without recording')
  const rt = recTimeNow(atStop)
  const recCol = rt ? (rt.approx ? '~' : ' ') + fmtDur(rt.sec) : '   (not rec)'
  const tc = atemTcNow() || '--:--:--:--'
  try {
    fs.appendFileSync(sessionFile, `${localTime()}  ${recCol.padEnd(10)}  ${tc}  ${event}\n`)
  } catch {}
}
// ---------- ATEM timecode ----------
// The ATEM sends its clock ("Time" command). In time-of-day mode this is the same timecode that is
// written into the recorded files, so it matches the timeline in DaVinci Resolve.
let lastTc = null // { h, m, s, f, at }
let maxFrameSeen = 0
function onAtemTime(p) {
  lastTc = { h: p.hour, m: p.minute, s: p.second, f: p.frame, at: Date.now() }
  if (p.frame > maxFrameSeen) maxFrameSeen = p.frame
}
function tcFps() {
  // estimate frame rate from the highest frame number seen
  for (const fps of [24, 25, 30, 50, 60]) if (maxFrameSeen < fps) return fps
  return 60
}
// Current ATEM timecode as "HH:MM:SS:FF" (extrapolated from the last message), or null if unknown
function atemTcNow() {
  if (!lastTc || st.connection !== 'connected' || Date.now() - lastTc.at > 5000) return null
  const fps = tcFps()
  const day = 24 * 3600 * fps
  let frames = ((lastTc.h * 60 + lastTc.m) * 60 + lastTc.s) * fps + lastTc.f
  frames = (frames + Math.round(((Date.now() - lastTc.at) / 1000) * fps)) % day
  const f = frames % fps, tsec = Math.floor(frames / fps)
  return `${pad(Math.floor(tsec / 3600))}:${pad(Math.floor(tsec / 60) % 60)}:${pad(tsec % 60)}:${pad(f)}`
}

// Current position in the recording: ATEM's own duration if it sends one, else our stopwatch
function recTimeNow(atStop = false) {
  if ((!atStop && st.rec.state !== 'recording') || !st.recStartedAt) return null
  const atemSec = st.rec.durationSec
  if (atemSec && atemSec > 0) return { sec: atemSec, approx: false }
  return { sec: (Date.now() - st.recStartedAt) / 1000, approx: !st.recStartExact }
}

// ---------- Cleanup of old files ----------
// Deletes only files this app creates: logs/atem-alert-YYYY-MM-DD.log and logs/sessions/*.txt
function cleanupOldFiles() {
  const DAY = 24 * 3600 * 1000
  const removed = []
  const sweep = (dir, pattern, maxAgeDays, ageOf) => {
    if (!(maxAgeDays > 0)) return // 0 or missing = keep forever
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!pattern.test(name)) continue
      const file = path.join(dir, name)
      try {
        if (Date.now() - ageOf(name, file) > maxAgeDays * DAY) {
          fs.unlinkSync(file)
          removed.push(name)
        }
      } catch {}
    }
  }
  // daily logs: age from the date in the file name (the log of today is never touched)
  sweep(logDir(), /^atem-alert-\d{4}-\d{2}-\d{2}\.log$/, settings.logRetentionDays, (name) => {
    const [y, m, d] = name.slice(11, 21).split('-').map(Number)
    return new Date(y, m - 1, d + 1).getTime() // end of that day
  })
  // session files: age from last modification
  sweep(path.join(logDir(), 'sessions'), /\.txt$/, settings.sessionRetentionDays, (_n, file) => fs.statSync(file).mtimeMs)
  if (removed.length) log('APP', `Cleanup: deleted ${removed.length} old file(s)`, { files: removed })
}

// ---------- App state ----------
let win = null
let atem = null
const st = {
  connection: 'connecting', // connecting | connected | disconnected
  model: '',
  rec: { state: 'unknown', errorRaw: REC_ERROR_NONE, errors: [], durationSec: null, timeAvailableSec: null, disks: [] },
  recStartedAt: null, // local timestamp when recording started (fallback timer)
  recStartExact: false, // false if we connected while it was already recording (start time unknown)
  // interview timer: state none | running | ended
  interview: { state: 'none', startedAt: null, endedAt: null, startRec: null, marks: 0, lastMark: null },
  alarm: null, // { level: 'red', kind, title, detail, time } - stays until acknowledged / recording restarts
  warnings: [], // [{ id, text }]
  ignoredWarnings: [], // yellow warnings the user ignored for now: [{ id, text, until }]
  cursorOutside: false, // mouse has been outside this window for longer than the grace time (during interview)
}
let cursorOutsideSince = null
// Ignored ("snoozed") warnings: id -> { until, level }. An ignored warning comes back when
// - 10 minutes have passed, - it gets worse (level rises, e.g. less disk space),
// - the problem went away (then a new occurrence warns again), - a recording starts or stops.
let ignored = {}
function clearIgnored() {
  ignored = {}
}
let lastDurationValue = null
let lastDurationChangeAt = null
let lastLoudAudioAt = Date.now()
let levelsBuffer = {} // key -> { l, r, lp, rp } in dB
let audioChannels = [] // which inputs are enabled in the mixer

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
function publish() {
  send('state', { ...st, ip: settings.ip, settings, version: app.getVersion(), now: Date.now() })
}
function fireEvent(type, extra) {
  if (type === 'rec-stop' || type === 'rec-stop-unexpected' || type === 'conn-lost') demandAttention()
  send('event', { type, ...extra })
}

function tcToSec(tc) {
  if (!tc) return null
  return tc.hours * 3600 + tc.minutes * 60 + tc.seconds
}
function fmtDur(sec) {
  if (sec == null) return '--:--:--'
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60)
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':')
}
function decodeErrors(raw) {
  if (raw === REC_ERROR_NONE || raw == null) return []
  if (raw === 0) return [{ name: 'NoMedia', text: 'No disk / no media' }]
  const out = REC_ERRORS.filter(([bit]) => (raw & bit) === bit).map(([, name, text]) => ({ name, text }))
  if (!out.length) out.push({ name: 'Raw' + raw, text: `Unrecognised error code ${raw}` })
  return out
}

// Read everything we care about from the library state into st.rec
function readRecording() {
  const r = atem.state?.recording
  if (!r) return
  const disks = Object.values(r.disks || {})
    .filter(Boolean)
    .map((d) => ({ id: d.diskId, name: d.volumeName, timeAvailableSec: d.recordingTimeAvailable, status: DISK_STATUS[d.status] || String(d.status) }))
  st.rec = {
    state: r.status ? REC_STATE[r.status.state] || 'unknown(' + r.status.state + ')' : 'unknown',
    errorRaw: r.status ? r.status.error : REC_ERROR_NONE,
    errors: decodeErrors(r.status ? r.status.error : REC_ERROR_NONE),
    durationSec: tcToSec(r.duration),
    timeAvailableSec: r.status ? r.status.recordingTimeAvailable : null,
    disks,
    filename: r.properties?.filename,
  }
}

function readAudioChannels() {
  const inputs = atem.state?.fairlight?.inputs || {}
  const list = []
  for (const [id, input] of Object.entries(inputs)) {
    if (!input) continue
    for (const [src, s] of Object.entries(input.sources || {})) {
      const mix = s?.properties?.mixOption // 1 off, 2 on, 4 AFV
      list.push({ key: `${id}:${src}`, name: AUDIO_NAMES[id] || `Input ${id}`, enabled: mix !== 1 })
    }
  }
  list.push({ key: 'master', name: 'MASTER', enabled: true, master: true })
  audioChannels = list
  send('audioChannels', audioChannels)
}

// ---------- Recording transition logic ----------
let prevRecState = null
function onRecordingChanged(reason) {
  const before = { state: prevRecState, errors: st.rec.errors.map((e) => e.name) }
  readRecording()
  const now = st.rec.state
  if (now !== prevRecState || reason === 'errors') {
    log('REC', `Recording state ${prevRecState} -> ${now}`, {
      error: st.rec.errorRaw,
      errors: st.rec.errors.map((e) => e.name),
      duration: fmtDur(st.rec.durationSec),
      timeAvailableSec: st.rec.timeAvailableSec,
      disks: st.rec.disks,
    })
  }

  const wasRecording = prevRecState === 'recording'
  if (now === 'recording' && prevRecState !== 'recording') {
    const realStart = prevRecState === 'idle' || prevRecState === 'stopping'
    if (realStart) {
      st.recStartedAt = Date.now()
      st.recStartExact = true
      startSession('recording ' + (st.rec.filename || ''))
      sessionWrite('RECORDING STARTED')
      clearIgnored() // a new recording starts with all warnings visible
      // A finished interview from before is cleared, so the bar starts fresh.
      // A RUNNING interview is kept (e.g. recording restarted after an unexpected stop).
      if (st.interview.state === 'ended') {
        // keep the finished interview as "previous" for an hour, so it can be resumed
        const prev = Date.now() - st.interview.endedAt < 60 * 60 * 1000 ? { ...st.interview } : null
        st.interview = { state: 'none', startedAt: null, endedAt: null, startRec: null, marks: 0, lastMark: null, previous: prev }
        saveInterview()
      } else if (st.interview.state === 'running') {
        sessionWrite(`INTERVIEW STILL RUNNING from previous recording (interview time ${fmtDur((Date.now() - st.interview.startedAt) / 1000)})`)
      }
    } else if (!st.recStartedAt) {
      // app (re)connected while ATEM was already recording: start time unknown
      st.recStartedAt = Date.now()
      st.recStartExact = false
      if (!sessionFile) startSession('app connected while already recording - times are approximate')
      sessionWrite('App connected, ATEM already recording')
    }
    lastDurationValue = null
    lastDurationChangeAt = Date.now()
    lastLoudAudioAt = Date.now()
    // Beep only for a real start; not when we just (re)connected and it was already recording
    if (prevRecState === 'idle' || prevRecState === 'stopping') fireEvent('rec-start')
    st.alarm = null
  } else if (wasRecording && now !== 'recording') {
    handleStop(before)
  }
  prevRecState = now
  updateWarnings()
  publish()
}

function handleStop(before) {
  clearIgnored()
  const recordedFor = st.recStartedAt ? fmtDur((Date.now() - st.recStartedAt) / 1000) : '?'
  const iv = st.interview.state === 'running' ? ` · INTERVIEW WAS RUNNING (${fmtDur((Date.now() - st.interview.startedAt) / 1000)})` : ''
  const reasons = []
  for (const e of st.rec.errors) reasons.push(e.text)
  for (const d of st.rec.disks) if (d.status === 'removed') reasons.push(`Disk "${d.name}" was removed`)
  if (!st.rec.disks.length) reasons.push('No recording disk present')
  if (st.rec.timeAvailableSec != null && st.rec.timeAvailableSec < 60) reasons.push('Disk has no recording time left')

  if (reasons.length) {
    st.alarm = {
      level: 'red',
      kind: 'unexpected',
      title: 'UNEXPECTED RECORDING STOP!',
      detail: reasons.join(' · ') + ` · recorded ${recordedFor}` + iv,
      time: Date.now(),
    }
    log('ALARM', 'Unexpected recording stop', { reasons, recordedFor, before })
    sessionWrite(`RECORDING STOPPED UNEXPECTEDLY: ${reasons.join('; ')} (recorded ${recordedFor})`, true)
    fireEvent('rec-stop-unexpected')
  } else {
    st.alarm = {
      level: 'red',
      kind: 'stopped',
      title: 'RECORDING STOPPED',
      detail: `ATEM reported no error · recorded ${recordedFor}${iv}. If you did not press Stop - check the ATEM!`,
      time: Date.now(),
    }
    log('ALARM', 'Recording stopped (no error reported by ATEM)', { recordedFor, before })
    sessionWrite(`RECORDING STOPPED (no error reported by ATEM, recorded ${recordedFor})`, true)
    fireEvent('rec-stop')
  }
  // Interview time only counts while recording: a running interview ends with the recording.
  // It can be continued in the next recording with "Resume previous".
  if (st.interview.state === 'running') {
    const now = Date.now()
    st.interview.state = 'ended'
    st.interview.endedAt = now
    st.interview.autoEnded = true
    st.interview.endTc = atemTcNow()
    const len = fmtDur((now - st.interview.startedAt) / 1000)
    log('INTERVIEW', 'Interview ended because recording stopped, length ' + len)
    sessionWrite(`INTERVIEW ENDED because recording stopped, length ${len}`, true)
    saveInterview()
  }
  st.recStartedAt = null
}

// ---------- Yellow warnings ----------
function updateWarnings() {
  const w = []
  if (st.connection !== 'connected') {
    w.push({ id: 'conn', text: `Not connected to ATEM at ${settings.ip}` })
  } else {
    const recording = st.rec.state === 'recording'
    const mins = st.rec.timeAvailableSec != null ? st.rec.timeAvailableSec / 60 : null
    if (!st.rec.disks.length) w.push({ id: 'nodisk', text: 'No recording disk connected to ATEM' })
    for (const d of st.rec.disks) {
      if (d.status === 'unformatted') w.push({ id: 'unf' + d.id, text: `Disk "${d.name}" is not formatted` })
      if (d.status === 'removed') w.push({ id: 'rem' + d.id, text: `Disk "${d.name}" removed` })
    }
    if (mins != null && st.rec.disks.length && mins < settings.lowDiskWarnMinutes)
      w.push({
        id: 'lowdisk',
        text: `Low disk space: only ${Math.floor(mins)} min of recording left`,
        level: mins < 5 ? 4 : mins < 10 ? 3 : mins < 15 ? 2 : 1, // worse level = warns again even if ignored
      })
    if (recording) {
      for (const e of st.rec.errors) w.push({ id: 'err' + e.name, text: 'ATEM reports: ' + e.text })
      if (lastDurationChangeAt && Date.now() - lastDurationChangeAt > 10000 && lastDurationValue != null)
        w.push({ id: 'stuck', text: 'Recording timer on ATEM is not advancing!' })
      const silentFor = (Date.now() - lastLoudAudioAt) / 1000
      if (settings.audioMeters && silentFor > settings.silenceWarnSeconds)
        w.push({ id: 'silence', text: `No audio on MASTER for ${Math.floor(silentFor)} s` })
    }
  }
  // apply "ignore": expired, worse or vanished warnings are no longer ignored
  const now = Date.now()
  const activeIds = new Set(w.map((x) => x.id))
  for (const id of Object.keys(ignored))
    if (!activeIds.has(id)) {
      if (st.rec.state === 'recording') sessionWrite(`Ignored warning cleared (problem went away): ${ignored[id].text}`)
      delete ignored[id]
    }
  const shown = [], hidden = []
  for (const x of w) {
    const ig = ignored[x.id]
    if (ig && now < ig.until && (x.level || 0) <= (ig.level || 0)) hidden.push({ id: x.id, text: x.text, until: ig.until })
    else {
      if (ig) {
        delete ignored[x.id]
        const why = now >= ig.until ? 'time is up' : 'it got worse'
        log('WARN', `Ignored warning is back (${why}): ${x.text}`)
        if (st.rec.state === 'recording') sessionWrite(`Ignored warning is back (${why}): ${x.text}`)
      }
      shown.push(x)
    }
  }
  st.ignoredWarnings = hidden
  const oldIds = new Set(st.warnings.map((x) => x.id))
  const newOnes = shown.filter((x) => !oldIds.has(x.id))
  st.warnings = shown
  for (const n of newOnes) log('WARN', n.text)
  // Don't beep for the "not connected" warning at startup; connection loss has its own sound.
  if (newOnes.some((n) => n.id !== 'conn')) fireEvent('warning')
}

// ---------- ATEM connection ----------
function connectAtem() {
  if (atem) {
    try {
      atem.removeAllListeners()
      atem.disconnect().catch(() => {})
      atem.destroy?.().catch?.(() => {})
    } catch {}
  }
  st.connection = 'connecting'
  prevRecState = null
  publish()
  atem = new Atem({ disableMultithreaded: true })
  atem.on('error', (e) => log('ERROR', 'ATEM library error: ' + e))

  atem.on('connected', async () => {
    st.connection = 'connected'
    st.model = atem.state?.info?.productIdentifier || 'ATEM'
    log('CONN', `Connected to ${st.model} at ${settings.ip}`)
    if (st.alarm && st.alarm.kind === 'connlost') {
      // Connection is back - recording state will tell whether it is still recording.
      st.alarm.detail += ' · connection restored ' + localTime()
    }
    readAudioChannels()
    try {
      if (settings.audioMeters) await atem.startFairlightMixerSendLevels()
    } catch (e) {
      log('ERROR', 'Could not start audio levels: ' + e.message)
    }
    const wasConnLostWhileRecording = st.alarm && st.alarm.kind === 'connlost'
    onRecordingChanged('connected')
    if (wasConnLostWhileRecording && st.rec.state === 'recording') {
      // still recording after reconnect: downgrade the alarm
      st.alarm = null
      log('CONN', 'Connection restored - ATEM is still recording')
      sessionWrite('Connection to ATEM restored - still recording')
      fireEvent('conn-restored')
      publish()
    }
  })

  atem.on('disconnected', () => {
    const wasRecording = st.rec.state === 'recording'
    st.connection = 'disconnected'
    log('CONN', `Disconnected from ATEM (was ${st.rec.state})`)
    if (wasRecording) {
      st.alarm = {
        level: 'red',
        kind: 'connlost',
        title: 'LOST CONNECTION TO ATEM',
        detail: 'Was recording when connection dropped - check the ATEM (power? network? crashed?)',
        time: Date.now(),
      }
      sessionWrite('LOST CONNECTION TO ATEM while recording', true)
      log('ALARM', 'Lost connection to ATEM while recording')
      fireEvent('conn-lost')
    }
    st.rec.state = 'unknown'
    prevRecState = 'unknown'
    updateWarnings()
    publish()
  })

  atem.on('stateChanged', (state, paths) => {
    if (paths.some((p) => p.startsWith('recording'))) {
      const errBefore = st.rec.errorRaw
      if (paths.some((p) => p.startsWith('recording.duration'))) {
        const d = tcToSec(state.recording?.duration)
        if (d !== lastDurationValue) {
          lastDurationValue = d
          lastDurationChangeAt = Date.now()
        }
      }
      const newErr = state.recording?.status?.error
      onRecordingChanged(newErr !== errBefore ? 'errors' : 'state')
    }
    if (paths.some((p) => p.startsWith('fairlight.inputs'))) readAudioChannels()
  })

  atem.on('receivedCommands', (cmds) => {
    for (const c of cmds) if (c.constructor.rawName === 'Time') onAtemTime(c.properties)
  })

  atem.on('levelChanged', (l) => {
    const key = l.type === 'master' ? 'master' : `${l.index}:${l.source}`
    const v = l.levels
    const entry = { l: v.leftLevel / 100, r: v.rightLevel / 100, lp: v.leftPeak / 100, rp: v.rightPeak / 100 }
    levelsBuffer[key] = entry
    if (l.type === 'master' && Math.max(entry.l, entry.r) > settings.silenceThresholdDb) lastLoudAudioAt = Date.now()
  })

  log('CONN', `Connecting to ATEM at ${settings.ip} ...`)
  atem.connect(settings.ip).catch((e) => log('ERROR', 'Connect failed: ' + e.message))
}

// Cursor check: during an interview the mouse should rest on this app, not on the cameras / shared screen
function checkCursor() {
  let outside = false
  if (settings.cursorCheck && st.interview.state === 'running' && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
    if (inside) cursorOutsideSince = null
    else if (!cursorOutsideSince) cursorOutsideSince = Date.now()
    outside = !!cursorOutsideSince && Date.now() - cursorOutsideSince > settings.cursorGraceSeconds * 1000
  } else {
    cursorOutsideSince = null
  }
  if (outside !== st.cursorOutside) {
    st.cursorOutside = outside
    log('CURSOR', outside ? 'Mouse cursor left the app window during interview' : 'Cursor warning cleared')
    if (outside) {
      sessionWrite('cursor left the app window (may be visible in recording)')
      if (settings.cursorBeep) fireEvent('cursor')
    }
    publish()
  }
}

function shiftTimestamps(jump) {
  const sh = (o, k) => o && typeof o[k] === 'number' && (o[k] += jump)
  sh(st, 'recStartedAt')
  for (const iv of [st.interview, st.interview.previous]) {
    if (!iv) continue
    ;['startedAt', 'endedAt', 'firstStartedAt', 'resumedAt'].forEach((k) => sh(iv, k))
    sh(iv.lastMark, 'time')
  }
  if (cursorOutsideSince) cursorOutsideSince += jump
  if (lastDurationChangeAt) lastDurationChangeAt += jump
  lastLoudAudioAt += jump
  if (lastTc) lastTc.at += jump
  log('CLOCK', `Computer clock jumped by ${(jump / 1000).toFixed(1)} s - timers corrected`)
  saveInterview()
  publish()
}

// Periodic jobs
function startTimers() {
  setInterval(checkCursor, 1000) // once per second is plenty; reading the cursor position is very cheap
  // audio levels -> UI (latest value per channel)
  setInterval(() => {
    if (Object.keys(levelsBuffer).length) {
      send('levels', levelsBuffer)
      levelsBuffer = {}
    }
  }, 100) // audio levels -> UI 10x per second
  // ask ATEM for duration while recording, re-evaluate warnings, publish clock
  setInterval(() => {
    if (atem && st.connection === 'connected') {
      atem.requestTime().catch(() => {}) // keep the timecode fresh
      if (st.rec.state === 'recording') atem.requestRecordingDuration().catch(() => {})
    }
    const before = JSON.stringify(st.warnings)
    updateWarnings()
    if (JSON.stringify(st.warnings) !== before || st.rec.state === 'recording') publish()
  }, 1000)
  // Clock jumps: if the computer's clock is corrected (time sync, manual change), shift all stored
  // timestamps by the same amount so recording/interview timers don't jump.
  let lastWall = Date.now()
  let lastMono = performance.now()
  setInterval(() => {
    const wall = Date.now(), mono = performance.now()
    const jump = wall - lastWall - (mono - lastMono)
    lastWall = wall
    lastMono = mono
    if (Math.abs(jump) > 1500) shiftTimestamps(jump)
  }, 1000)
  // memory use to the log every 30 min (to spot leaks in long sessions)
  setInterval(() => {
    const total = app.getAppMetrics().reduce((s, m) => s + (m.memory?.workingSetSize || 0), 0)
    log('MEM', `App memory ${Math.round(total / 1024)} MB (main heap ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB)`)
  }, 30 * 60 * 1000)
  // heartbeat to the log while recording (helps reconstructing what happened)
  setInterval(() => {
    if (st.rec.state === 'recording')
      log('BEAT', 'Recording', {
        atemDuration: fmtDur(st.rec.durationSec),
        localDuration: st.recStartedAt ? fmtDur((Date.now() - st.recStartedAt) / 1000) : null,
        timeAvailableSec: st.rec.timeAvailableSec,
        error: st.rec.errorRaw,
        disks: st.rec.disks,
      })
  }, 60000)
}

// ---------- Window position per monitor setup ----------
// The window position is remembered separately for each monitor arrangement (e.g. "1 monitor" and
// "2 monitors"). When a monitor appears or disappears, the window moves to the position saved for the
// new arrangement. A saved position is only used if it is really visible on a connected screen.
const layoutKey = () =>
  screen
    .getAllDisplays()
    .map((d) => `${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}`)
    .sort()
    .join('|')
function isOnScreen(b) {
  return (
    b &&
    screen.getAllDisplays().some((d) => {
      const a = d.workArea
      const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)
      const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y)
      return w >= 120 && h >= 80 // enough of the window visible to grab it
    })
  )
}
// true if the window rectangle is visible on the displays described by a layout key
function fitsLayout(b, key) {
  if (!b || !key) return false
  return key.split('|').some((r) => {
    const m = r.match(/^(-?\d+),(-?\d+),(\d+)x(\d+)$/)
    if (!m) return false
    const [x, y, w, h] = m.slice(1).map(Number)
    const iw = Math.min(b.x + b.width, x + w) - Math.max(b.x, x)
    const ih = Math.min(b.y + b.height, y + h) - Math.max(b.y, y)
    return iw >= 120 && ih >= 80
  })
}
function savedBounds() {
  const b = (settings.boundsByLayout || {})[layoutKey()]
  if (isOnScreen(b)) return b
  if (isOnScreen(settings.bounds)) return settings.bounds
  return null
}
let suppressBoundsSaveUntil = 0
let rememberTimer = null
// Save 1 s after the user stops moving/resizing - and only if the position really belongs to the
// current monitor setup (during monitor changes the OS reports positions from the old setup)
function rememberBounds() {
  clearTimeout(rememberTimer)
  rememberTimer = setTimeout(saveBoundsNow, 1000)
}
function saveBoundsNow() {
  if (!win || win.isDestroyed() || win.isMinimized() || Date.now() < suppressBoundsSaveUntil) return
  const b = win.getBounds()
  if (!fitsLayout(b, layoutKey()) || !isOnScreen(b)) return
  settings.boundsByLayout = settings.boundsByLayout || {}
  delete settings.boundsByLayout[layoutKey()] // re-insert so the most recent layouts are kept
  settings.boundsByLayout[layoutKey()] = b
  const keys = Object.keys(settings.boundsByLayout)
  for (const k of keys.slice(0, Math.max(0, keys.length - 10))) delete settings.boundsByLayout[k]
  settings.bounds = b
  saveSettings()
}
let lastLayout = null
function onDisplaysChanged() {
  if (!win || win.isDestroyed()) return
  const key = layoutKey()
  if (key === lastLayout) return
  lastLayout = key
  // the OS moves the window itself when a monitor disappears - don't save that as "my position"
  suppressBoundsSaveUntil = Date.now() + 5000
  clearTimeout(rememberTimer)
  setTimeout(() => {
    if (!win || win.isDestroyed()) return
    const b = (settings.boundsByLayout || {})[layoutKey()]
    if (isOnScreen(b)) {
      win.setBounds(b)
      log('APP', `Monitor setup changed (${screen.getAllDisplays().length} display(s)) - window moved to saved position`)
    } else if (!isOnScreen(win.getBounds())) {
      const wa = screen.getPrimaryDisplay().workArea
      const cur = win.getBounds()
      win.setBounds({ x: wa.x + 40, y: wa.y + 40, width: Math.min(cur.width, wa.width - 80), height: Math.min(cur.height, wa.height - 80) })
      log('APP', 'Monitor setup changed - window was off-screen, moved to main screen')
    } else {
      log('APP', `Monitor setup changed (${screen.getAllDisplays().length} display(s)) - no saved position for this setup`)
    }
    suppressBoundsSaveUntil = Date.now() + 2000
  }, 1000)
}

// Bring the window to the user's attention on an alarm (without stealing keyboard focus from Zoom)
function demandAttention() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.showInactive()
  win.moveTop()
  win.flashFrame(true) // Windows: flashing taskbar button; macOS: bouncing Dock icon
}

// ---------- Window ----------
let quitConfirmed = false
function createWindow() {
  const devSize = process.env.ATEM_ALERT_SIZE && process.env.ATEM_ALERT_SIZE.split('x').map(Number)
  lastLayout = layoutKey()
  win = new BrowserWindow({
    ...(devSize ? { width: devSize[0], height: devSize[1] } : savedBounds() || { width: 900, height: 900 }),
    icon: path.join(__dirname, 'build', 'icon.png'),
    minWidth: 260,
    minHeight: 200,
    title: 'Recording Monitor for ATEM',
    backgroundColor: '#111111',
    alwaysOnTop: settings.alwaysOnTop,
    acceptFirstMouse: true, // macOS: a click on the inactive window presses the button right away
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep timers/sounds running when window is not focused
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  win.setMenuBarVisibility(false)

  // Security: this window only ever shows our own page - no navigation, no popups, no permissions
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  if (!devSize) {
    win.on('resized', rememberBounds)
    win.on('moved', rememberBounds)
    screen.on('display-added', onDisplaysChanged)
    screen.on('display-removed', onDisplaysChanged)
    screen.on('display-metrics-changed', onDisplaysChanged)
  }
  win.on('focus', () => win.flashFrame(false))

  // Crash recovery: if the display part crashes or hangs, reload it (the ATEM watching keeps running)
  win.webContents.on('render-process-gone', (_e, d) => {
    log('ERROR', 'Display process gone: ' + d.reason)
    if (d.reason !== 'clean-exit') setTimeout(() => win && !win.isDestroyed() && win.reload(), 1000)
  })
  let hangTimer = null
  win.on('unresponsive', () => {
    log('ERROR', 'Display not responding')
    hangTimer = setTimeout(() => {
      log('ERROR', 'Display still not responding - reloading')
      win.webContents.forcefullyCrashRenderer()
      win.reload()
    }, 10000)
  })
  win.on('responsive', () => {
    clearTimeout(hangTimer)
    log('APP', 'Display responding again')
  })

  // Accidental close protection while recording / interview running
  win.on('close', (e) => {
    if (quitConfirmed) return
    const busy = st.rec.state === 'recording' || st.interview.state === 'running'
    if (!busy) return
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep watching', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Recording Monitor for ATEM',
      message: st.rec.state === 'recording' ? 'The ATEM is recording!' : 'An interview is running!',
      detail: 'If you quit now, you will NOT be alerted if the recording stops.',
    })
    if (r === 0) {
      e.preventDefault()
      log('APP', 'Close cancelled ("Keep watching") while ' + (st.rec.state === 'recording' ? 'recording' : 'interview running'))
    }
    else {
      quitConfirmed = true
      log('APP', 'Quit confirmed while ' + (st.rec.state === 'recording' ? 'recording' : 'interview running'))
    }
  })
  win.webContents.on('did-finish-load', () => {
    send('audioChannels', audioChannels)
    publish()
  })
}

// ---------- IPC from UI ----------
ipcMain.on('ack', () => {
  if (st.alarm) log('ACK', 'Alarm acknowledged: ' + st.alarm.title)
  if (win && !win.isDestroyed()) win.flashFrame(false)
  st.alarm = null
  publish()
})
ipcMain.on('setIp', (_e, ip) => {
  ip = String(ip || '').trim()
  if (!/^[0-9a-zA-Z.\-]+$/.test(ip)) return
  settings.ip = ip
  saveSettings()
  connectAtem()
})
ipcMain.on('setAlwaysOnTop', (_e, v) => {
  settings.alwaysOnTop = !!v
  saveSettings()
  if (win) win.setAlwaysOnTop(settings.alwaysOnTop)
  publish()
})
ipcMain.on('setVolume', (_e, v) => {
  settings.volume = Math.max(0, Math.min(1, Number(v) || 0))
  saveSettings()
  publish()
})
ipcMain.on('setCursorOptions', (_e, o) => {
  if (typeof o.check === 'boolean') settings.cursorCheck = o.check
  if (typeof o.beep === 'boolean') settings.cursorBeep = o.beep
  saveSettings()
  checkCursor()
  publish()
})
ipcMain.on('setAudioMeters', async (_e, on) => {
  settings.audioMeters = !!on
  saveSettings()
  lastLoudAudioAt = Date.now()
  if (atem && st.connection === 'connected') {
    try {
      if (on) await atem.startFairlightMixerSendLevels()
      else await atem.stopFairlightMixerSendLevels()
    } catch (e) {
      log('ERROR', 'Audio meters toggle failed: ' + e.message)
    }
  }
  log('APP', 'Audio meters ' + (on ? 'on' : 'off'))
  publish()
})
// About: open the project page in the normal browser (only these fixed addresses)
ipcMain.on('openProjectPage', (_e, which) => {
  shell.openExternal(which === 'releases' ? PROJECT_URL + '/releases' : PROJECT_URL)
})
// Update check: only when the user clicks the button; asks GitHub for the latest release
const versionParts = (v) => String(v).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
function isNewer(a, b) {
  const x = versionParts(a), y = versionParts(b)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}
ipcMain.handle('checkUpdates', async () => {
  const current = app.getVersion()
  try {
    const res = await net.fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'recording-monitor-for-atem' },
    })
    if (res.status === 404) return { status: 'none', current }
    if (!res.ok) return { status: 'error', current, message: 'GitHub answered ' + res.status }
    const rel = await res.json()
    const latest = String(rel.tag_name || '').replace(/^v/i, '')
    log('APP', `Update check: running ${current}, latest release ${latest}`)
    return { status: isNewer(latest, current) ? 'newer' : 'latest', current, latest }
  } catch (e) {
    return { status: 'error', current, message: 'No connection to GitHub' }
  }
})
ipcMain.on('ignoreWarning', (_e, id) => {
  const w = st.warnings.find((x) => x.id === id)
  if (!w || id === 'conn') return // "not connected" can't be ignored
  ignored[id] = { until: Date.now() + settings.warnIgnoreMinutes * 60000, level: w.level || 0, text: w.text.replace(/ for \d+ s$/, '') }
  log('WARN', `Warning ignored for up to ${settings.warnIgnoreMinutes} min: ${w.text}`)
  if (st.rec.state === 'recording') sessionWrite(`Warning ignored (for up to ${settings.warnIgnoreMinutes} min): ${w.text}`)
  updateWarnings()
  publish()
})
ipcMain.on('openLogs', () => {
  fs.mkdirSync(logDir(), { recursive: true })
  shell.openPath(logDir())
})
// Interview timer + markers (buttons in the UI)
function saveInterview() {
  if (process.env.ATEM_ALERT_DEMO) return
  settings.interview = st.interview // survives an app restart/crash
  saveSettings()
}
ipcMain.on('interview', (_e, action) => {
  const iv = st.interview
  const now = Date.now()
  if (action === 'start') {
    // Only while recording - the greyed-out button is also a reminder to start recording
    if (st.rec.state !== 'recording') return
    const rt = recTimeNow()
    const tc = atemTcNow()
    st.interview = { state: 'running', startedAt: now, endedAt: null, startRec: rt ? rt.sec : null, startTc: tc, marks: 0, lastMark: null }
    log('INTERVIEW', 'Interview started', { recordingTime: rt ? fmtDur(rt.sec) : null, timecode: tc })
    sessionWrite('INTERVIEW START')
    fireEvent('iv-start')
  } else if (action === 'end' && iv.state === 'running') {
    iv.state = 'ended'
    iv.endedAt = now
    iv.endTc = atemTcNow()
    const len = fmtDur((now - iv.startedAt) / 1000)
    log('INTERVIEW', 'Interview ended, length ' + len, { timecode: iv.endTc })
    sessionWrite(`INTERVIEW END   length ${len}` + (iv.marks ? `, ${iv.marks} mark(s)` : ''))
    fireEvent('iv-end')
  } else if (action === 'mark') {
    iv.marks += 1
    const rt = recTimeNow()
    iv.lastMark = { n: iv.marks, time: now, rec: rt ? rt.sec : null, tc: atemTcNow() }
    log('INTERVIEW', 'Mark ' + iv.marks, { recordingTime: rt ? fmtDur(rt.sec) : null, timecode: iv.lastMark.tc })
    sessionWrite(`MARK ${iv.marks}` + (iv.state === 'running' ? `   (interview time ${fmtDur((now - iv.startedAt) / 1000)})` : ''))
    fireEvent('iv-mark')
  } else if (action === 'resume' && iv.state === 'ended' && st.rec.state === 'recording') {
    // continue the same interview from the value it had at End - the pause is not counted
    const gap = now - iv.endedAt
    iv.firstStartedAt = iv.firstStartedAt || iv.startedAt
    iv.startedAt += gap // shift the start so the timer continues where it stopped
    iv.pausedMs = (iv.pausedMs || 0) + gap
    iv.resumedAt = now
    iv.state = 'running'
    iv.endedAt = null
    iv.autoEnded = false
    log('INTERVIEW', `Interview resumed, pause of ${fmtDur(gap / 1000)} not counted`)
    sessionWrite(`INTERVIEW RESUMED at interview time ${fmtDur((now - iv.startedAt) / 1000)} (pause of ${fmtDur(gap / 1000)} not counted)`)
    fireEvent('iv-start')
  } else if (action === 'resumePrevious' && iv.state === 'none' && iv.previous && st.rec.state === 'recording') {
    // continue the timer from where the previous interview ended (the gap between recordings is not counted)
    const p = iv.previous
    const gap = now - p.endedAt
    st.interview = {
      ...p, state: 'running', endedAt: null, previous: null, autoEnded: false,
      firstStartedAt: p.firstStartedAt || p.startedAt,
      startedAt: p.startedAt + gap, // shift so the timer continues at the old length
      resumedAt: now, startRec: null, startTc: null,
    }
    log('INTERVIEW', 'Previous interview resumed in new recording', { pausedFor: fmtDur(gap / 1000) })
    sessionWrite(`INTERVIEW RESUMED from previous recording (interview time ${fmtDur((now - st.interview.startedAt) / 1000)})`)
    fireEvent('iv-start')
  } else if (action === 'clear') {
    st.interview = { state: 'none', startedAt: null, endedAt: null, startRec: null, marks: 0, lastMark: null }
  }
  saveInterview()
  publish()
})
ipcMain.on('openSessions', () => {
  const dir = path.join(logDir(), 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  shell.openPath(dir)
})

// Test mode: simulate events so alerts can be checked without breaking a real recording
ipcMain.on('simulate', (_e, what) => {
  log('TEST', 'Simulating: ' + what)
  if (what === 'start') {
    st.alarm = null
    fireEvent('rec-start')
  } else if (what === 'stop') {
    st.alarm = { level: 'red', kind: 'stopped', title: 'RECORDING STOPPED', detail: '(TEST) ATEM reported no error', time: Date.now() }
    fireEvent('rec-stop')
  } else if (what === 'unexpected') {
    st.alarm = { level: 'red', kind: 'unexpected', title: 'UNEXPECTED RECORDING STOP!', detail: '(TEST) Disk error (disk disconnected or failed?)', time: Date.now() }
    fireEvent('rec-stop-unexpected')
  } else if (what === 'warning') {
    fireEvent('warning')
  }
  publish()
})

// ---------- Demo mode (for README screenshots) ----------
// ATEM_ALERT_DEMO=recording|alarm|warning shows example data and does NOT connect to the ATEM
function setupDemo(demo) {
  const now = Date.now()
  st.connection = 'connected'
  st.model = 'ATEM Mini Pro ISO'
  const left = demo === 'warning' ? 24 * 60 : 4 * 3600 + 41 * 60
  st.rec = {
    state: demo === 'alarm' ? 'idle' : 'recording', errorRaw: REC_ERROR_NONE, errors: [], durationSec: 0,
    timeAvailableSec: left, filename: 'Interview 2026-11-26',
    disks: [{ id: 0, name: 'SSD', timeAvailableSec: left, status: demo === 'alarm' ? 'active' : 'recording' }],
  }
  st.recStartedAt = demo === 'alarm' ? null : now - 754000
  st.interview = { state: 'running', startedAt: now - 591000, endedAt: null, startRec: 163, startTc: '14:02:43:12', marks: 2, lastMark: null }
  if (demo === 'alarm')
    st.alarm = { level: 'red', kind: 'unexpected', title: 'UNEXPECTED RECORDING STOP!', detail: 'Disk error (disk disconnected or failed?) · recorded 00:12:34 · INTERVIEW WAS RUNNING (00:09:51)', time: now }
  audioChannels = [
    { key: '2:-65280', name: 'HDMI 2', enabled: true },
    { key: '3:-65280', name: 'HDMI 3', enabled: true },
    { key: '1302:-65280', name: 'Mic 2', enabled: true },
    { key: 'master', name: 'MASTER', enabled: true, master: true },
  ]
  const lv = (l, r) => ({ l, r, lp: Math.max(l, r) + 4, rp: Math.max(l, r) + 3 })
  const levels = { '2:-65280': lv(-24, -26), '3:-65280': lv(-36, -38), '1302:-65280': lv(-12, -13), master: lv(-14, -15) }
  // ATEM_ALERT_DEMO_SILENT=1: no audio (to test the "no audio" warning)
  if (process.env.ATEM_ALERT_DEMO_SILENT) for (const k of Object.keys(levels)) levels[k] = { l: -100, r: -100, lp: -100, rp: -100 }
  setInterval(() => {
    if (!process.env.ATEM_ALERT_DEMO_SILENT) lastLoudAudioAt = Date.now()
    send('levels', levels)
  }, 100)
  send('audioChannels', audioChannels)
  updateWarnings()
  publish()
  // ATEM_ALERT_DEMO_DISK=<ms>:<minutes> lowers the free disk time later (to test warnings)
  const [after, minutes] = (process.env.ATEM_ALERT_DEMO_DISK || '').split(':').map(Number)
  if (after) setTimeout(() => {
    st.rec.timeAvailableSec = minutes * 60
    updateWarnings()
    publish()
  }, after)
}

// ---------- Startup ----------
// Dev helper: ATEM_ALERT_USERDATA=<folder> keeps test settings/logs away from the real ones
if (process.env.ATEM_ALERT_USERDATA) app.setPath('userData', process.env.ATEM_ALERT_USERDATA)

// The app was called "ATEM Recording Alert" before v0.2.0: move its settings and logs to the new folder once
function migrateOldDataFolder() {
  if (process.env.ATEM_ALERT_USERDATA) return
  const oldDir = path.join(app.getPath('appData'), 'ATEM Recording Alert')
  const newDir = app.getPath('userData')
  if (!fs.existsSync(oldDir) || oldDir === newDir) return
  const moved = []
  try {
    fs.mkdirSync(newDir, { recursive: true })
    for (const item of ['settings.json', 'logs']) {
      const from = path.join(oldDir, item), to = path.join(newDir, item)
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.cpSync(from, to, { recursive: true })
        fs.rmSync(from, { recursive: true, force: true })
        moved.push(item)
      }
    }
    // leave a note in the old folder (it only holds browser cache files now)
    fs.writeFileSync(path.join(oldDir, 'MOVED.txt'), `Settings and logs moved to:\n${newDir}\nThis folder can be deleted.\n`)
  } catch (e) {
    console.error('Migration failed', e)
  }
  if (moved.length) app.whenReady().then(() => log('APP', `Moved ${moved.join(' and ')} from the old "ATEM Recording Alert" folder`))
}
migrateOldDataFolder()

// Unexpected errors are logged instead of silently killing the app
process.on('uncaughtException', (e) => log('ERROR', 'Unexpected error: ' + (e && e.stack ? e.stack : e)))
process.on('unhandledRejection', (e) => log('ERROR', 'Unhandled promise rejection: ' + (e && e.stack ? e.stack : e)))
app.on('child-process-gone', (_e, d) => log('ERROR', `Helper process gone: ${d.type} (${d.reason})`))

// Only one copy: starting the app again just brings the existing window to the front
const isFirstInstance = app.requestSingleInstanceLock()
if (!isFirstInstance) app.quit()
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

if (isFirstInstance) app.whenReady().then(() => {
  loadSettings()
  if (settings.interview && settings.interview.state) st.interview = settings.interview
  // drop saved window positions that don't fit their own monitor setup
  for (const [k, b] of Object.entries(settings.boundsByLayout || {})) if (!fitsLayout(b, k)) delete settings.boundsByLayout[k]
  // stop the OS from suspending us (timers, network) during long sessions
  powerSaveBlocker.start('prevent-app-suspension')
  // macOS takes the Dock icon from the app bundle; when run with "npm start" that is Electron's own icon
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png'))
  createWindow()
  if (process.env.ATEM_ALERT_DEMO) setupDemo(process.env.ATEM_ALERT_DEMO)
  else connectAtem()
  startTimers()
  log('APP', `Recording Monitor for ATEM ${app.getVersion()} started. Logs: ${logDir()}`)
  cleanupOldFiles()
  setInterval(cleanupOldFiles, 24 * 3600 * 1000)
})
app.on('window-all-closed', () => {
  log('APP', 'Closed')
  app.quit()
})

// Dev helper: ATEM_ALERT_SNAPSHOT=/path/file.png saves a screenshot of the window after a few seconds
if (process.env.ATEM_ALERT_SNAPSHOT && isFirstInstance) {
  app.whenReady().then(() =>
    setTimeout(async () => {
      if (process.env.ATEM_ALERT_SIM) ipcMain.emit('simulate', {}, process.env.ATEM_ALERT_SIM)
      for (const a of (process.env.ATEM_ALERT_IV || '').split(',').filter(Boolean)) {
        ipcMain.emit('interview', {}, a)
        await new Promise((r) => setTimeout(r, 1100))
      }
      await new Promise((r) => setTimeout(r, 600))
      const img = await win.webContents.capturePage()
      fs.writeFileSync(process.env.ATEM_ALERT_SNAPSHOT, img.toPNG())
      if (process.env.ATEM_ALERT_SNAPSHOT_QUIT) {
        quitConfirmed = true
        app.quit()
      }
    }, Number(process.env.ATEM_ALERT_SNAPSHOT_DELAY || 5000))
  )
}
