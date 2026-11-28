// UI logic: shows status, warnings, audio meters; plays alert sounds
const $ = (id) => document.getElementById(id)
const api = window.atemAlert

let state = null
let alarmRepeatTimer = null
let currentAlarmTime = null

function fmt(sec) {
  if (sec == null || isNaN(sec)) return '--:--:--'
  sec = Math.max(0, Math.floor(sec))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':')
}
// 24-hour wall clock, e.g. 14:05:09
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false })
function fmtHM(sec) {
  if (sec == null) return '?'
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
  return h ? `${h} h ${m} min` : `${m} min`
}

// ---------- Status ----------
// DOM helpers that skip the write when nothing changed (saves CPU/GPU)
const _cache = new Map()
function setProp(id, prop, val) {
  const k = id + '.' + prop
  if (_cache.get(k) === val) return
  _cache.set(k, val)
  $(id)[prop] = val
}
const setText = (id, t) => setProp(id, 'textContent', t)
const setHidden = (id, h) => setProp(id, 'hidden', !!h)
const setClass = (id, c) => setProp(id, 'className', c)

function render() {
  if (!state) return
  const s = state
  const box = $('status')
  let cls, text, sub = '', timer = ''
  const recording = s.rec.state === 'recording'
  const atemSec = s.rec.durationSec
  const localSec = s.recStartedAt ? (Date.now() - s.recStartedAt) / 1000 : null
  // Prefer the ATEM's own duration; fall back to our stopwatch if ATEM hasn't sent it
  const dur = recording ? (atemSec && atemSec > 0 ? atemSec : localSec) : null

  if (s.alarm) {
    cls = 'st-alarm'
    text = s.alarm.title
    sub = s.alarm.detail + ' · ' + clock(s.alarm.time)
    timer = recording ? fmt(dur) : ''
  } else if (s.cursorOutside) {
    // the whole status area flashes blue: hard to miss even from the corner of the eye
    cls = 'st-cursor'
    text = '🖱 MOVE CURSOR HERE'
    sub = 'The mouse cursor is outside this window – it may be visible in the recording'
    timer = recording ? fmt(dur) : ''
  } else if (s.connection !== 'connected') {
    cls = 'st-offline'
    text = s.connection === 'connecting' ? 'CONNECTING…' : 'NO CONNECTION'
    sub = `ATEM ${s.ip} – retrying automatically`
  } else if (recording) {
    cls = s.warnings.length ? 'st-rec-warn' : 'st-rec'
    text = 'RECORDING'
    timer = fmt(dur)
    sub = s.rec.filename ? `File: ${s.rec.filename}` : ''
  } else if (s.rec.state === 'stopping') {
    cls = 'st-idle'
    text = 'STOPPING…'
  } else {
    cls = 'st-idle'
    text = 'NOT RECORDING'
    sub = s.rec.filename ? `Ready · next file: ${s.rec.filename}` : 'Ready'
  }
  setClass('status', cls)
  setText('statusText', text)
  setText('timer', timer)
  setHidden('timer', !timer)
  setText('statusSub', sub)
  setHidden('ackBtn', !s.alarm)

  renderInterview(s)
  const bodyCls = cls === 'st-rec' ? 'calm' : ''
  if (document.body.className !== bodyCls) document.body.className = bodyCls

  // warnings (rebuilt only when the list changes)
  const ign = s.ignoredWarnings || []
  const wKey = s.warnings.map((w) => w.id + w.text).join('\n') + '|' + ign.map((w) => w.id + w.until).join(',')
  if (_cache.get('warnings') !== wKey) {
    _cache.set('warnings', wKey)
    const wEl = $('warnings')
    wEl.innerHTML = ''
    for (const w of s.warnings) {
      const d = document.createElement('div')
      d.className = 'warning'
      const t = document.createElement('span')
      t.textContent = '⚠ ' + w.text
      d.appendChild(t)
      if (w.id !== 'conn') {
        const b = document.createElement('button')
        b.className = 'ignoreBtn'
        b.textContent = '✕ Ignore'
        b.title = 'Hide for now. It comes back if it gets worse, after a while, or with the next recording.'
        b.onclick = () => api.ignoreWarning(w.id)
        d.appendChild(b)
      }
      wEl.appendChild(d)
    }
    // one small grey line per ignored warning, each with its own return time
    for (const w of ign) {
      const d = document.createElement('div')
      d.className = 'ignoredNote'
      d.textContent = `ignored: ${w.text.replace(/ for \d+ s$/, '')} · back by ${clock(w.until).slice(0, 5)} or if it gets worse`
      wEl.appendChild(d)
    }
  }

  // footer info
  setText('connInfo', s.connection === 'connected' ? `● ${s.model} @ ${s.ip}` : `○ ${s.connection} @ ${s.ip}`)
  setClass('connInfo', s.connection === 'connected' ? 'ok' : 'bad')
  const disk = s.rec.disks[0]
  setText('diskInfo', disk
    ? `Disk: ${disk.name} (${disk.status}) · ${fmtHM(s.rec.timeAvailableSec ?? disk.timeAvailableSec)} left`
    : s.connection === 'connected' ? 'No disk' : '')

  if (document.activeElement !== $('ipInput')) setProp('ipInput', 'value', s.ip)
  setText('version', 'v' + s.version)
  setProp('onTop', 'checked', !!s.settings.alwaysOnTop)
  setProp('beaconOn', 'checked', !!s.settings.beacon)
  if (document.activeElement !== $('beaconSize')) setProp('beaconSize', 'value', String(s.settings.beaconSize))
  setProp('beaconSize', 'disabled', !s.settings.beacon)
  setProp('stopFrame', 'checked', !!s.settings.stopFrame)
  setProp('cursorCheck', 'checked', !!s.settings.cursorCheck)
  for (const el of document.querySelectorAll('[data-sound]')) el.checked = !!s.settings[el.dataset.sound]
  setProp('meterToggle', 'checked', s.settings.audioMeters !== false)
  setHidden('meters', s.settings.audioMeters === false)
  if (document.activeElement !== $('volume')) setProp('volume', 'value', String(s.settings.volume))
  Sounds.setVolume(s.settings.volume)

  // repeat the alarm sound until acknowledged (only for unexpected stop / lost connection)
  // repeat the siren: unexpected stop always (recording already stopped); lost connection only if enabled
  const repeating = s.alarm && (s.alarm.kind === 'unexpected' || (s.alarm.kind === 'connlost' && s.settings.connectionSounds))
  if (repeating && currentAlarmTime !== s.alarm.time) {
    currentAlarmTime = s.alarm.time
    clearInterval(alarmRepeatTimer)
    alarmRepeatTimer = setInterval(() => Sounds.alarm(), 6000)
  } else if (!repeating) {
    clearInterval(alarmRepeatTimer)
    alarmRepeatTimer = null
    currentAlarmTime = null
  }
}

// ---------- Interview timer ----------
function renderInterview(s) {
  const iv = s.interview || { state: 'none' }
  setHidden('ivNone', iv.state !== 'none')
  setHidden('ivRunning', iv.state !== 'running')
  setHidden('ivEnded', iv.state !== 'ended')
  setClass('interview', 'iv-' + iv.state)
  // Start / New only while the ATEM is recording
  const canStart = s.connection === 'connected' && s.rec.state === 'recording'
  for (const id of ['ivStart', 'ivNew', 'ivResume', 'ivResumePrev']) setProp(id, 'disabled', !canStart)
  setProp('ivResume', 'title', canStart ? 'Continue the same interview timer (the time since End is not counted)' : 'Start recording first')
  setText('ivStart', canStart ? '▶ START INTERVIEW' : '▶ START INTERVIEW (start recording first)')
  setProp('ivNew', 'title', canStart ? 'Start timing a new interview' : 'Start recording first')
  const prev = iv.state === 'none' && iv.previous
  setHidden('ivResumePrev', !prev)
  if (prev) setText('ivResumePrev', `↺ Resume previous (${fmt((prev.endedAt - prev.startedAt) / 1000)})`)
  if (iv.state === 'running') setText('ivTime', fmt((Date.now() - iv.startedAt) / 1000))
  if (iv.state === 'ended') setText('ivLen', fmt((iv.endedAt - iv.startedAt) / 1000))
  let info = ''
  if (iv.state !== 'none') {
    info = iv.resumedAt
      ? `Resumed ${clock(iv.resumedAt)} (first started ${clock(iv.firstStartedAt)}, pause not counted)`
      : 'Started ' + clock(iv.startedAt)
    if (iv.startRec != null) info += ` (at ${fmt(iv.startRec)} in recording${iv.startTc ? ', TC ' + iv.startTc : ''})`
    if (iv.state === 'ended') info += ' · ended ' + clock(iv.endedAt) + (iv.autoEnded ? ' because recording stopped' : '')
    if (iv.marks) info += ` · ${iv.marks} mark${iv.marks > 1 ? 's' : ''}`
  }
  // show the last mark for a few seconds as confirmation
  if (iv.lastMark && Date.now() - iv.lastMark.time < 4000)
    info = `⚑ Mark ${iv.lastMark.n} saved` + (iv.lastMark.rec != null ? ` at ${fmt(iv.lastMark.rec)} in recording` : '') + (iv.lastMark.tc ? ` · TC ${iv.lastMark.tc}` : '')
  setText('ivInfo', info)
  setHidden('ivInfo', !info)
}

api.on('state', (s) => {
  state = s
  render()
})

api.on('event', (e) => {
  switch (e.type) {
    case 'rec-start': Sounds.start(); break
    case 'rec-stop': Sounds.stop(); break
    case 'rec-stop-unexpected': Sounds.stop(); setTimeout(Sounds.alarm, 2700); break
    case 'conn-lost': if (state?.settings.connectionSounds) Sounds.alarm(); break
    case 'conn-restored': if (state?.settings.connectionSounds) Sounds.restored(); break
    case 'warning': Sounds.warning(); break
    case 'iv-start': Sounds.ivStart(); break
    case 'iv-end': Sounds.ivEnd(); break
    case 'iv-mark': if (state?.settings.markBeep) Sounds.mark(); break
    case 'cursor': Sounds.cursor(); break
  }
})

api.on('log', (l) => {
  $('lastLog').textContent = clock(l.time) + '  ' + l.level + '  ' + l.msg
})

// local ticking of the timer between ATEM updates
setInterval(render, 500)

// ---------- Audio meters ----------
const MIN_DB = -60
const meters = {} // key -> { fillL, fillR, peakL, peakR, holdL, holdR }
function dbToPct(db) {
  if (db == null || db <= MIN_DB) return 0
  return Math.min(100, ((db - MIN_DB) / -MIN_DB) * 100)
}
function buildMeters(channels) {
  const el = $('meters')
  el.innerHTML = ''
  for (const k of Object.keys(meters)) delete meters[k]
  const scale = document.createElement('div')
  scale.className = 'scale'
  for (const db of [0, -12, -24, -36, -48, -60]) {
    const t = document.createElement('span')
    if (db === -12 || db === -36 || db === -60) t.className = 'minor'
    t.style.bottom = dbToPct(db) + '%'
    t.textContent = db
    scale.appendChild(t)
  }
  el.appendChild(scale)
  for (const ch of channels.filter((c) => c.enabled)) {
    const m = document.createElement('div')
    m.className = 'meter' + (ch.master ? ' master' : '')
    m.innerHTML = `<div class="bars"><div class="bar"><div class="fill"></div><div class="peak"></div></div><div class="bar"><div class="fill"></div><div class="peak"></div></div></div><div class="label">${ch.name}</div>`
    el.appendChild(m)
    const [bl, br] = m.querySelectorAll('.bar')
    meters[ch.key] = {
      fillL: bl.querySelector('.fill'), peakL: bl.querySelector('.peak'),
      fillR: br.querySelector('.fill'), peakR: br.querySelector('.peak'),
      last: {}, // last drawn values, to skip unchanged updates
    }
  }
}
function band(db) {
  if (db > -6) return 'fill red'
  if (db > -18) return 'fill yellow'
  return 'fill'
}
// update one element only if its (rounded) value changed
function upd(m, key, el, val, apply) {
  if (m.last[key] === val) return
  m.last[key] = val
  apply(el, val)
}
const setFill = (el, pct) => (el.style.transform = `scaleY(${pct / 100})`)
const setPeak = (el, pct) => (el.style.bottom = pct + '%')
const setBand = (el, cls) => (el.className = cls)
api.on('audioChannels', buildMeters)
api.on('levels', (levels) => {
  for (const [key, v] of Object.entries(levels)) {
    const m = meters[key]
    if (!m) continue
    upd(m, 'fl', m.fillL, Math.round(dbToPct(v.l)), setFill)
    upd(m, 'fr', m.fillR, Math.round(dbToPct(v.r)), setFill)
    upd(m, 'cl', m.fillL, band(v.l), setBand)
    upd(m, 'cr', m.fillR, band(v.r), setBand)
    upd(m, 'pl', m.peakL, Math.round(dbToPct(v.lp)), setPeak)
    upd(m, 'pr', m.peakR, Math.round(dbToPct(v.rp)), setPeak)
  }
})

// ---------- Controls ----------
$('ackBtn').onclick = () => {
  clearInterval(alarmRepeatTimer)
  api.ack()
}
$('ipInput').onchange = (e) => api.setIp(e.target.value)
$('onTop').onchange = (e) => api.setAlwaysOnTop(e.target.checked)
$('beaconOn').onchange = (e) => api.setBeacon(e.target.checked)
$('stopFrame').onchange = (e) => api.setStopFrame(e.target.checked)
$('beaconSize').oninput = (e) => api.setBeaconSize(Number(e.target.value))
$('cursorCheck').onchange = (e) => api.setCursorOptions({ check: e.target.checked })
$('meterToggle').onchange = (e) => api.setAudioMeters(e.target.checked)
for (const el of document.querySelectorAll('[data-sound]')) el.onchange = () => api.setSoundOption(el.dataset.sound, el.checked)
$('volume').oninput = (e) => {
  Sounds.setVolume(Number(e.target.value))
  api.setVolume(e.target.value)
}
$('logsBtn').onclick = () => api.openLogs()
$('sessionsBtn').onclick = () => api.openSessions()
$('githubLink').onclick = (e) => {
  e.preventDefault()
  api.openProjectPage('home')
}
$('updateBtn').onclick = async () => {
  const r = $('updateResult')
  r.className = ''
  r.textContent = 'Checking…'
  const res = await api.checkUpdates()
  if (res.status === 'newer') {
    r.className = 'newer'
    r.innerHTML = ''
    const a = document.createElement('a')
    a.href = '#'
    a.textContent = `Version ${res.latest} is available – download ↗`
    a.onclick = (e) => {
      e.preventDefault()
      api.openProjectPage('releases')
    }
    r.appendChild(a)
  } else if (res.status === 'latest') r.textContent = `✓ You have the latest version (${res.current})`
  else if (res.status === 'none') r.textContent = 'No releases published yet'
  else r.textContent = 'Could not check: ' + res.message
}
$('ivStart').onclick = () => api.interview('start')
$('ivNew').onclick = () => api.interview('start')
$('ivEnd').onclick = () => api.interview('end')
$('ivResume').onclick = () => api.interview('resume')
$('ivMark').onclick = () => api.interview('mark')
$('ivResumePrev').onclick = () => api.interview('resumePrevious')
$('settingsBtn').onclick = () => ($('settingsPanel').hidden = !$('settingsPanel').hidden)
$('testBtn').onclick = () => ($('testMenu').hidden = !$('testMenu').hidden)
for (const b of document.querySelectorAll('[data-sim]')) b.onclick = () => api.simulate(b.dataset.sim)
