#!/usr/bin/env node
/*
 * Recording Monitor for ATEM - automated smoke test against a REAL ATEM.
 * Run before every release:   npm run smoke-test            (or: npm run smoke-test -- 192.168.0.40)
 *
 * What it does
 *  - starts the app (with its own temporary settings/log folder, sounds muted, test hooks enabled)
 *  - makes 2 short test recordings on the ATEM (about 1 minute in total) and drives the app through
 *    every main feature, checking the screen, the sounds that WOULD play, the log and the session files
 *  - prints a PASS / FAIL / WARN list; exit code 1 if anything failed
 *
 * Safety
 *  - refuses to run if the ATEM is recording, has no disk or less than 10 min of disk time
 *  - never touches your real settings, logs or session files
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Atem } = require('atem-connection')

const ROOT = path.join(__dirname, '..')
const ELECTRON = require('electron') // path to the Electron binary
const PKG = require(path.join(ROOT, 'package.json'))
const IP = process.argv[2] || '192.168.0.40'
const PAGE_PORT = 9451
const MAIN_PORT = 9452
const TMP = path.join(os.tmpdir(), `rm-atem-smoke-${Date.now()}`)

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
function warn(name, detail) {
  results.push({ name, status: 'WARN', detail })
  console.log(`  ⚠️  WARN  ${name}  — ${detail}`)
}
function section(title) {
  console.log(`\n▶ ${title}`)
}
const hms = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, Math.floor(s % 60)].map((x) => String(x).padStart(2, '0')).join(':')
const toSec = (t) => (t && /^\d\d:\d\d:\d\d$/.test(t) ? t.split(':').reduce((a, x) => a * 60 + Number(x), 0) : NaN)
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    await sleep(stepMs)
  }
  return null
}

// Chrome DevTools Protocol client (works for the page and for the main process inspector)
class Cdp {
  static async open(port, type) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    const target = list.find((t) => t.type === type) || list[0]
    const c = new Cdp()
    c.ws = new WebSocket(target.webSocketDebuggerUrl)
    c.id = 0
    c.pending = {}
    c.ws.onmessage = (m) => {
      const d = JSON.parse(m.data)
      if (d.id && c.pending[d.id]) c.pending[d.id](d)
    }
    await new Promise((r, j) => ((c.ws.onopen = r), (c.ws.onerror = j)))
    return c
  }
  call(method, params = {}) {
    return new Promise((r) => {
      const i = ++this.id
      this.pending[i] = r
      this.ws.send(JSON.stringify({ id: i, method, params }))
    })
  }
  async ev(expression) {
    const d = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description || 'eval error')
    return d.result?.result?.value
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

// ---------- the app under test ----------
class App {
  async start() {
    this.out = ''
    this.proc = spawn(ELECTRON, [`--remote-debugging-port=${PAGE_PORT}`, `--inspect=${MAIN_PORT}`, ROOT], {
      env: { ...process.env, ATEM_ALERT_USERDATA: TMP, ATEM_ALERT_TEST_HOOKS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc.stdout.on('data', (d) => (this.out += d))
    this.proc.stderr.on('data', (d) => (this.out += d))
    this.exited = false
    this.proc.on('exit', () => (this.exited = true))
    const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${PAGE_PORT}/json`)).ok, 20000, 300)
    if (!up) throw new Error('App did not start:\n' + this.out.slice(0, 2000))
    await sleep(800)
    this.page = await Cdp.open(PAGE_PORT, 'page')
    this.main = await Cdp.open(MAIN_PORT, 'node')
    await this.patchSounds()
  }
  // record which sounds the app plays (instead of playing them)
  async patchSounds() {
    await waitFor(() => this.page.ev("typeof Sounds !== 'undefined' && !!document.getElementById('status')"), 10000)
    await this.page.ev(`window.__sounds = window.__sounds || [];
      for (const k of Object.keys(Sounds)) if (k !== 'setVolume' && !Sounds[k].__patched) { const n = k; Sounds[k] = () => window.__sounds.push(n); Sounds[k].__patched = true }`)
  }
  hook(expr) {
    return this.main.ev(`global.__testHooks.${expr}`)
  }
  ev(expr) {
    return this.page.ev(expr)
  }
  text(id) {
    return this.ev(`(document.getElementById('${id}')||{}).textContent`)
  }
  statusClass() {
    return this.ev("document.getElementById('status').className")
  }
  visible(id) {
    return this.ev(`(() => { const e = document.getElementById('${id}'); return !!e && !e.closest('[hidden]') })()`)
  }
  click(sel) {
    return this.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('not found: ${sel}'); e.click(); return true })()`)
  }
  sounds() {
    return this.ev('window.__sounds.slice()')
  }
  async clearSounds() {
    await this.ev('window.__sounds.length = 0')
  }
  async quit() {
    try {
      await this.hook('quit()')
    } catch {}
    await waitFor(() => this.exited, 10000)
    if (!this.exited) this.proc.kill()
    this.page?.close()
    this.main?.close()
    await sleep(1000)
  }
}

// ---------- ATEM test client (starts / stops the test recordings) ----------
async function connectAtem() {
  const a = new Atem({ disableMultithreaded: true })
  a.on('error', () => {})
  const ok = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 8000)
    a.once('connected', () => (clearTimeout(t), resolve(true)))
    a.connect(IP)
  })
  return ok ? a : null
}

// ======================================================================
async function main() {
  console.log(`Recording Monitor for ATEM ${PKG.version} – smoke test against ATEM at ${IP}`)

  // ---------- preflight ----------
  section('Preflight (safety checks)')
  const atem = await connectAtem()
  if (!atem) {
    console.log(`  ❌ Cannot reach the ATEM at ${IP}. Is it on and connected?`)
    process.exit(2)
  }
  // Watch the ATEM for 3 s: a recording that was started just now takes ~2 s until the ATEM reports it
  let busy = false
  for (let i = 0; i < 30; i++) {
    const st = atem.state.recording?.status?.state
    const diskState = Object.values(atem.state.recording?.disks || {}).find(Boolean)?.status
    if (st !== 0 || diskState === 8 /* disk is recording */) busy = true
    await sleep(100)
  }
  const rec = atem.state.recording
  const disk = Object.values(rec?.disks || {}).find(Boolean)
  console.log(`  ATEM: ${atem.state.info.productIdentifier}, disk: ${disk ? disk.volumeName : 'none'}, ` +
    `${Math.floor((rec?.status?.recordingTimeAvailable || 0) / 60)} min free, recording: ${busy ? 'YES' : 'no'}`)
  if (busy) {
    console.log('  ❌ The ATEM is RECORDING (or busy). The smoke test will not run, to protect your recording.')
    process.exit(2)
  }
  if (!disk || (rec.status.recordingTimeAvailable || 0) < 600) {
    console.log('  ❌ No recording disk or less than 10 min of disk time. Not running.')
    process.exit(2)
  }
  console.log('  OK – the test will make 2 short test recordings (~1 minute) on this disk.')

  // ---------- test settings + fake old files for the cleanup test ----------
  fs.mkdirSync(path.join(TMP, 'logs', 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify({
    ip: IP, volume: 0, cursorCheck: true, cursorGraceSeconds: 1, silenceWarnSeconds: 2,
    silenceThresholdDb: 200, // = "everything is silence", so the no-audio warning always appears
    warnIgnoreMinutes: 0.05, // ignored warnings come back after 3 s
  }))
  const d = new Date(Date.now() - 130 * 86400000)
  const oldLog = path.join(TMP, 'logs', `atem-alert-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`)
  const oldSession = path.join(TMP, 'logs', 'sessions', 'very old session.txt')
  fs.writeFileSync(oldLog, 'old\n')
  fs.writeFileSync(oldSession, 'old\n')
  const old = new Date(Date.now() - 400 * 86400000)
  fs.utimesSync(oldSession, old, old)

  const app = new App()
  try {
    // ================= Phase 1: start =================
    section('Start-up')
    await app.start()
    const connected = await waitFor(async () => (await app.text('connInfo'))?.includes('@'), 10000)
    check('App starts and connects to the ATEM', !!connected && (await app.text('connInfo')).startsWith('●'), await app.text('connInfo'))
    check('Status shows NOT RECORDING', (await app.text('statusText')) === 'NOT RECORDING', await app.text('statusText'))
    check('Version shown in ⚙', (await app.text('version')) === 'v' + PKG.version, await app.text('version'))
    check('Old log (130 days) deleted by cleanup', !fs.existsSync(oldLog))
    check('Old session file (400 days) deleted by cleanup', !fs.existsSync(oldSession))
    check('START INTERVIEW disabled while not recording', await app.ev("document.getElementById('ivStart').disabled"))

    section('Security')
    check('Page has no access to Node.js', (await app.ev('typeof require')) === 'undefined')
    await app.ev("location.href = 'https://example.com'").catch(() => {})
    await sleep(1200)
    check('Navigation to web pages is blocked', (await app.ev('location.href')).endsWith('renderer/index.html'), await app.ev('location.href'))

    section('Single instance')
    const second = spawn(ELECTRON, [ROOT], { env: { ...process.env, ATEM_ALERT_USERDATA: TMP }, stdio: 'ignore' })
    const secondExited = await new Promise((r) => {
      const t = setTimeout(() => r(false), 10000)
      second.on('exit', () => (clearTimeout(t), r(true)))
    })
    if (!secondExited) second.kill()
    check('Second start exits and leaves the first copy running', secondExited && !app.exited)

    section('Audio meters')
    const meters = await app.ev("document.querySelectorAll('#meters .meter').length")
    const drawn = await waitFor(() => app.ev("[...document.querySelectorAll('#meters .fill')].some(f => f.style.transform)"), 4000)
    check('Audio meters are shown and receive levels from the ATEM', meters > 0 && !!drawn, `${meters} meters`)

    section('Update check (needs internet)')
    await app.click('#settingsBtn')
    await app.click('#updateBtn')
    const upd = await waitFor(async () => {
      const t = await app.text('updateResult')
      return t && t !== 'Checking…' ? t : null
    }, 15000)
    if (upd && /latest version|is available|No releases/.test(upd)) check('Check for updates answers', true, upd)
    else warn('Check for updates', upd || 'no answer (offline?)')
    await app.click('#settingsBtn')

    // ================= Recording 1 =================
    section('Recording 1: start')
    await app.clearSounds()
    await atem.startRecording()
    const recOn = await waitFor(async () => /st-rec/.test(await app.statusClass()), 8000)
    check('Recording start detected (green RECORDING)', !!recOn, await app.text('statusText'))
    check('Recording start sound', (await app.sounds()).includes('start'))
    const t1 = toSec(await app.text('timer'))
    await sleep(3200)
    const t2 = toSec(await app.text('timer'))
    check('Recording timer runs', t2 - t1 >= 2, `${hms(t1)} → ${hms(t2)}`)

    section('Short connection reset (the ATEM does this sometimes)')
    await app.ev(`window.__classes = new Set(); window.__watch = setInterval(() => window.__classes.add(document.getElementById('status').className), 20)`)
    await app.hook('dropConnection(150)')
    await sleep(3500)
    const seen = await app.ev('[...window.__classes]')
    await app.ev('clearInterval(window.__watch)')
    check('0.15 s reset is ignored (no yellow flash, no alarm)', !seen.some((c) => /offline|alarm/.test(c)), seen.join(', '))
    check('Short reset is logged', app.out.includes('Brief connection reset'))

    section('Interview timer')
    await app.clearSounds()
    await app.click('#ivStart')
    const ivOn = await waitFor(() => app.visible('ivRunning'), 3000)
    const iv1 = toSec(await app.text('ivTime'))
    await sleep(3200) // the screen refreshes every 0.5 s, so allow for that
    const iv2 = toSec(await app.text('ivTime'))
    check('Interview timer starts and runs', !!ivOn && iv2 - iv1 >= 2, `${hms(iv1)} → ${hms(iv2)}`)
    check('Interview start sound', (await app.sounds()).includes('ivStart'))
    await app.click('#ivMark')
    await sleep(400)
    const markInfo = await app.text('ivInfo')
    check('Mark saved with recording position and ATEM timecode', /Mark 1 saved at \d\d:\d\d:\d\d in recording · TC \d\d:\d\d:\d\d:\d\d/.test(markInfo), markInfo)
    check('Mark is silent by default', !(await app.sounds()).includes('mark'))

    section('Warnings and Ignore')
    const warnShown = await waitFor(() => app.ev("[...document.querySelectorAll('.warning span')].some(s => s.textContent.includes('No audio'))"), 6000)
    check('"No audio" warning appears (yellow)', !!warnShown && (await app.statusClass()) === 'st-rec-warn')
    check('Warnings are silent by default', !(await app.sounds()).includes('warning'))
    await app.ev("[...document.querySelectorAll('.warning')].find(w => w.textContent.includes('No audio')).querySelector('.ignoreBtn').click()")
    await sleep(500)
    const ignoredNote = await app.ev("[...document.querySelectorAll('.ignoredNote')].map(e => e.textContent).join(' | ')")
    check('✕ Ignore turns the status green and shows a grey note', (await app.statusClass()) === 'st-rec' && /ignored: No audio/.test(ignoredNote), ignoredNote)
    const back = await waitFor(() => app.ev("[...document.querySelectorAll('.warning span')].some(s => s.textContent.includes('No audio'))"), 7000)
    check('Ignored warning comes back when its time is up', !!back)

    section('Cursor check')
    const cur = await app.hook('cursorPoint()')
    const area = (await app.hook('displays()')).find((a) => cur.x >= a.x && cur.x < a.x + a.width && cur.y >= a.y && cur.y < a.y + a.height) || (await app.hook('displays()'))[0]
    // put the window on the half of the screen where the cursor is NOT
    const leftHalf = cur.x < area.x + area.width / 2
    await app.hook(`setWinBounds(${JSON.stringify({ x: leftHalf ? area.x + area.width - 620 : area.x + 20, y: area.y + 40, width: 600, height: 560 })})`)
    const cursorWarn = await waitFor(() => app.visible('cursorWarn'), 5000)
    if (cursorWarn) check('Cursor warning appears when the mouse is outside the window', true)
    else warn('Cursor check', 'warning did not appear – was the mouse moved over the test window?')

    section('End / Resume (pause not counted)')
    await app.clearSounds()
    await app.click('#ivEnd')
    await sleep(300)
    const lenAtEnd = toSec(await app.text('ivLen'))
    check('End freezes the interview length', (await app.visible('ivEnded')) && lenAtEnd > 0, hms(lenAtEnd))
    check('Interview end sound', (await app.sounds()).includes('ivEnd'))
    await sleep(3000)
    await app.click('#ivResume')
    await sleep(300)
    const afterResume = toSec(await app.text('ivTime'))
    check('Resume continues without counting the 3 s pause', afterResume - lenAtEnd <= 1, `${hms(lenAtEnd)} → ${hms(afterResume)}`)

    section('Lost connection during recording (4 s outage)')
    await app.clearSounds()
    await app.hook('dropConnection(4000)')
    const lost = await waitFor(async () => (await app.statusClass()) === 'st-alarm' && (await app.text('statusText')).includes('LOST CONNECTION'), 6000)
    check('LOST CONNECTION alarm after the 2 s grace time', !!lost)
    check('Connection alarm is silent by default', !(await app.sounds()).includes('alarm'))
    const restored = await waitFor(async () => /st-rec/.test(await app.statusClass()), 10000)
    check('Connection restored → alarm cleared, still recording', !!restored)
    check('Interview still running after the outage', await app.visible('ivRunning'))

    section('Recording 1: stop')
    await app.clearSounds()
    await atem.stopRecording()
    const stopped = await waitFor(async () => (await app.statusClass()) === 'st-alarm' && (await app.text('statusText')) === 'RECORDING STOPPED', 8000)
    check('Recording stop → red RECORDING STOPPED', !!stopped)
    check('Recording stop sound', (await app.sounds()).includes('stop'))
    const ivInfo = await app.text('ivInfo')
    check('Running interview ended with the recording', (await app.visible('ivEnded')) && ivInfo.includes('because recording stopped'), ivInfo)
    const lenRec1 = toSec(await app.text('ivLen'))
    await app.click('#ackBtn')
    await sleep(400)
    check('OK clears the alarm', (await app.statusClass()) === 'st-idle')
    check('Resume / New disabled while not recording', await app.ev("document.getElementById('ivResume').disabled && document.getElementById('ivNew').disabled"))
    await sleep(2000)

    // ================= Recording 2 =================
    section('Recording 2: Resume previous')
    await atem.startRecording()
    await waitFor(async () => /st-rec/.test(await app.statusClass()), 8000)
    const prevBtn = await app.text('ivResumePrev')
    check('New recording: fresh START INTERVIEW + "Resume previous"', (await app.visible('ivNone')) && (await app.visible('ivResumePrev')) && prevBtn.includes(hms(lenRec1)), prevBtn)
    await app.click('#ivResumePrev')
    await sleep(400)
    const resumedAt = toSec(await app.text('ivTime'))
    check('Resume previous continues from the old length', Math.abs(resumedAt - lenRec1) <= 1, `${hms(lenRec1)} → ${hms(resumedAt)}`)
    await sleep(2000)
    await atem.stopRecording()
    await waitFor(async () => (await app.statusClass()) === 'st-alarm', 8000)
    await app.click('#ackBtn')
    await sleep(800)

    section('Session files and log')
    const sessDir = path.join(TMP, 'logs', 'sessions')
    const files = fs.readdirSync(sessDir).filter((f) => f.endsWith('.txt')).sort()
    check('One session file per recording', files.length >= 2, files.join(', '))
    const s1 = files[0] ? fs.readFileSync(path.join(sessDir, files[0]), 'utf8') : ''
    const s2 = files[1] ? fs.readFileSync(path.join(sessDir, files[1]), 'utf8') : ''
    const need1 = ['RECORDING STARTED', 'INTERVIEW START', 'MARK 1', 'Warning ignored', 'INTERVIEW END', 'INTERVIEW RESUMED at',
      'LOST CONNECTION TO ATEM', 'Connection to ATEM restored', 'INTERVIEW ENDED because recording stopped', 'RECORDING STOPPED']
    const missing1 = need1.filter((x) => !s1.includes(x))
    check('Session file 1 has all events', missing1.length === 0, missing1.length ? 'missing: ' + missing1.join(', ') : `${need1.length} events`)
    const tcLines = s1.split('\n').filter((l) => /\s\d\d:\d\d:\d\d:\d\d\s/.test(l)).length
    check('Session file lines carry the ATEM timecode', tcLines >= 8, `${tcLines} lines with timecode`)
    check('Session file 2 has "RESUMED from previous recording"', s2.includes('INTERVIEW RESUMED from previous recording'))
    const errors = app.out.split('\n').filter((l) => l.includes('[ERROR]'))
    check('No errors in the log', errors.length === 0, errors.slice(0, 2).join(' | '))

    section('Changing the IP address')
    await app.ev(`(() => { const i = document.getElementById('ipInput'); i.value = '192.0.2.1'; i.dispatchEvent(new Event('change')) })()`)
    const offline = await waitFor(async () => (await app.statusClass()) === 'st-offline', 12000)
    check('Wrong IP → NO CONNECTION', !!offline, await app.text('statusText'))
    await app.ev(`(() => { const i = document.getElementById('ipInput'); i.value = ${JSON.stringify(IP)}; i.dispatchEvent(new Event('change')) })()`)
    const back2 = await waitFor(async () => (await app.statusClass()) === 'st-idle', 12000)
    check('Correct IP → connected again', !!back2)

    section('Crash recovery')
    app.page.call('Page.crash').catch(() => {})
    await sleep(3500)
    app.page.close()
    app.page = await Cdp.open(PAGE_PORT, 'page')
    const recovered = await waitFor(async () => (await app.text('statusText')) === 'NOT RECORDING', 8000)
    check('Display reloads itself after a crash', !!recovered)
    await app.patchSounds()

    section('CPU and memory')
    await app.hook('cpuPercent()')
    await sleep(5000)
    const cpu = await app.hook('cpuPercent()')
    const mem = await app.hook('memoryMB()')
    check('CPU use is reasonable (< 40 % of one core, meters on)', cpu < 40, `${cpu.toFixed(1)} % of one core, ${mem} MB memory`)

    section('Settings are remembered')
    await app.click('#settingsBtn')
    await app.ev(`(() => { const c = (id, v) => { const e = document.getElementById(id); e.checked = v; e.dispatchEvent(new Event('change')) };
      c('onTop', true); c('meterToggle', false); c('cursorCheck', false);
      const m = document.querySelector('[data-sound=markBeep]'); m.checked = true; m.dispatchEvent(new Event('change')) })()`)
    await sleep(600)
    await app.quit()
    // put the saved window position off-screen: the app must not use it
    const sf = path.join(TMP, 'settings.json')
    const saved = JSON.parse(fs.readFileSync(sf, 'utf8'))
    saved.bounds = { x: 30000, y: 30000, width: 600, height: 500 }
    saved.boundsByLayout = {}
    fs.writeFileSync(sf, JSON.stringify(saved))
    await app.start()
    const kept = await app.ev(`JSON.stringify([onTop.checked, meterToggle.checked, cursorCheck.checked, document.querySelector('[data-sound=markBeep]').checked])`)
    check('Settings remembered after restart', kept === '[true,false,false,true]', kept)
    const wb = await app.hook('winBounds()')
    const onScreen = (await app.hook('displays()')).some((a) => wb.x < a.x + a.width && wb.x + wb.width > a.x && wb.y < a.y + a.height && wb.y + wb.height > a.y)
    check('Off-screen saved position is not used', onScreen, JSON.stringify(wb))
    await app.quit()
  } catch (e) {
    check('Test run finished without crashing', false, e.message)
    try {
      await atem.stopRecording()
    } catch {}
    await app.quit().catch(() => {})
  }

  // make sure the ATEM is not left recording
  await sleep(500)
  if (atem.state.recording?.status?.state === 1) {
    await atem.stopRecording().catch(() => {})
    console.log('  (stopped a test recording that was still running)')
  }
  await atem.disconnect().catch(() => {})
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {}

  // ---------- summary ----------
  const fail = results.filter((r) => r.status === 'FAIL').length
  const warns = results.filter((r) => r.status === 'WARN').length
  console.log(`\n${'='.repeat(60)}\n${fail ? '❌' : '✅'}  ${results.length - fail - warns} passed, ${fail} failed, ${warns} warnings`)
  console.log(`\nNot covered automatically – check by hand on the Windows PC:
  - the built .exe starts, SmartScreen / firewall prompts
  - sounds are audible at the right volume
  - window returns to the right monitor when the ATEM monitor is switched off/on
  - "Keep watching / Quit anyway" when closing the window during a recording`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('Smoke test crashed:', e)
  process.exit(1)
})
