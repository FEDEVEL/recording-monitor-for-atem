// Screen frame: when the recording has STOPPED, a flashing red border lights up around every monitor,
// so it is noticed wherever the user is looking. Only for a stop - at that moment nothing is being
// recorded, so it can't spoil the video. Mouse clicks go straight through it; it never takes focus.
// It disappears when the alarm is acknowledged (OK button) or a new recording starts.
const { BrowserWindow, screen } = require('electron')
const path = require('path')

function createFrame({ log }) {
  let wins = []

  function show() {
    if (wins.length) return
    for (const d of screen.getAllDisplays()) {
      const w = new BrowserWindow({
        ...d.bounds,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        alwaysOnTop: true,
        show: false,
        title: 'Recording Monitor frame',
        enableLargerThanScreen: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
      })
      w.setIgnoreMouseEvents(true) // clicks pass through to Zoom etc.
      w.setAlwaysOnTop(true, 'screen-saver')
      if (process.platform === 'darwin') w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      w.webContents.on('will-navigate', (e) => e.preventDefault())
      // developer tests: keep it invisible so the developer's screen doesn't flash
      if (process.env.ATEM_ALERT_BACKGROUND) w.setOpacity(0)
      w.loadFile(path.join(__dirname, 'renderer', 'frame.html'))
      w.once('ready-to-show', () => !w.isDestroyed() && w.showInactive())
      w.on('closed', () => (wins = wins.filter((x) => x !== w)))
      wins.push(w)
    }
    log('APP', `Screen frame shown on ${wins.length} monitor(s)`)
  }

  function hide() {
    if (!wins.length) return
    for (const w of wins) if (!w.isDestroyed()) w.destroy()
    wins = []
    log('APP', 'Screen frame hidden')
  }

  return { update: (on) => (on ? show() : hide()), hide, count: () => wins.length }
}

module.exports = { createFrame }
