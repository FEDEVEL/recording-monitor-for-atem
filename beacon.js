// Beacon dot: a tiny separate always-on-top window the user places next to the guest's video.
// Calm when everything is fine (steady dot), flashing when the app needs attention.
// The size never changes by itself (only with the slider in settings): a growing dot could cover parts of the
// screen that are being recorded.
// Drag = move, click = bring the main window to the front. Size: slider in ⚙ settings only.
const { BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')

const MIN_SIZE = 14
const MAX_SIZE = 96

function createBeacon({ getSettings, saveSettings, layoutKey, log, onClick, onSizeChanged }) {
  let bw = null
  let level = null
  let drag = null // { startCursor, startPos, moved, timer }

  const size = () => Math.max(MIN_SIZE, Math.min(MAX_SIZE, Number(getSettings().beaconSize) || 28))

  // saved centre point for the current monitor setup, if it is on a connected screen
  function savedCenter() {
    const c = (getSettings().beaconByLayout || {})[layoutKey()]
    if (!c) return null
    const ok = screen.getAllDisplays().some((d) => {
      const a = d.bounds
      return c.x >= a.x && c.x < a.x + a.width && c.y >= a.y && c.y < a.y + a.height
    })
    return ok ? c : null
  }
  function defaultCenter() {
    const a = screen.getPrimaryDisplay().workArea
    return { x: a.x + Math.round(a.width / 2), y: a.y + 60 }
  }
  function center() {
    const b = bw.getBounds()
    return { x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) }
  }
  // The dot is only ever moved by the user: dragging, changing its size, or a monitor being plugged
  // in / out. Nothing else touches its position (an automatic "size correction" used to shift it a few
  // pixels on monitors with different scaling). Any move we didn't make is written to the log.
  let selfMove = false
  function setBoundsSelf(b) {
    selfMove = true
    bw.setBounds(b)
    setTimeout(() => (selfMove = false), 300)
  }
  function place(c) {
    const s = size()
    setBoundsSelf({ x: Math.round(c.x - s / 2), y: Math.round(c.y - s / 2), width: s, height: s })
  }
  function saveCenter() {
    getSettings().beaconByLayout = getSettings().beaconByLayout || {}
    delete getSettings().beaconByLayout[layoutKey()]
    getSettings().beaconByLayout[layoutKey()] = center()
    const keys = Object.keys(getSettings().beaconByLayout)
    for (const k of keys.slice(0, Math.max(0, keys.length - 10))) delete getSettings().beaconByLayout[k]
    saveSettings()
  }

  function open() {
    if (bw && !bw.isDestroyed()) return
    const s = size()
    const c = savedCenter() || defaultCenter()
    bw = new BrowserWindow({
      x: Math.round(c.x - s / 2),
      y: Math.round(c.y - s / 2),
      width: s,
      height: s,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false, // we move it ourselves (so a click still works)
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false, // never takes keyboard focus away from Zoom
      alwaysOnTop: true,
      show: false,
      title: 'Recording Monitor beacon',
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, 'beacon-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    bw.setAlwaysOnTop(true, 'screen-saver') // above Zoom, also above its full-screen window
    if (process.platform === 'darwin') bw.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    bw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    bw.webContents.on('will-navigate', (e) => e.preventDefault())
    bw.loadFile(path.join(__dirname, 'renderer', 'beacon.html'))
    bw.once('ready-to-show', () => bw.showInactive())
    bw.webContents.on('did-finish-load', () => level && bw.webContents.send('beacon', { level }))
    // some systems drop "always on top" after other windows go full screen - re-assert it now and then
    const keepOnTop = setInterval(() => {
      if (!bw || bw.isDestroyed()) return clearInterval(keepOnTop)
      if (!bw.isAlwaysOnTop()) bw.setAlwaysOnTop(true, 'screen-saver')
      bw.moveTop() // only the stacking order, never the position
    }, 5000)
    bw.on('move', () => {
      if (!drag && !selfMove) log('APP', 'Beacon dot was moved by the system to ' + JSON.stringify(bw.getBounds()))
    })
    bw.on('closed', () => {
      clearInterval(keepOnTop)
      bw = null
    })
    log('APP', 'Beacon dot shown')
  }

  function close() {
    if (bw && !bw.isDestroyed()) bw.destroy()
    bw = null
  }

  function update(newLevel) {
    if (newLevel === level) return
    level = newLevel
    if (!bw || bw.isDestroyed()) return
    bw.webContents.send('beacon', { level })
  }

  // --- mouse: drag to move, click to show the app ---
  const fromBeacon = (e) => bw && !bw.isDestroyed() && e.sender === bw.webContents
  // offX/offY: where inside the dot the mouse was pressed. While dragging, the dot is placed at
  // "mouse position minus that offset" - no reading back of the window position, so no drift or jumps.
  ipcMain.on('beacon:down', (e, offX, offY) => {
    if (!fromBeacon(e)) return
    const ox = Math.round(Number(offX) || 0), oy = Math.round(Number(offY) || 0)
    drag = { startCursor: screen.getCursorScreenPoint(), off: { x: ox, y: oy }, moved: false }
    // follow the mouse while the button is held (polling works even when the mouse is outside the dot)
    drag.timer = setInterval(() => {
      if (!drag || !bw || bw.isDestroyed()) return
      const p = screen.getCursorScreenPoint()
      const dx = p.x - drag.startCursor.x, dy = p.y - drag.startCursor.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
      drag.moved = true
      // always give the size too: Windows rescales a window that crosses to a monitor with a
      // different scaling (125 %, 150 % ...), which made the dot grow on every crossing
      bw.setBounds({ x: p.x - drag.off.x, y: p.y - drag.off.y, width: size(), height: size() })
    }, 16)
  })
  ipcMain.on('beacon:up', (e) => {
    if (!fromBeacon(e) || !drag) return
    clearInterval(drag.timer)
    const moved = drag.moved
    drag = null
    if (moved) saveCenter()
    else onClick()
  })
  // new size - only from the slider in settings (no mouse wheel: it could change by accident);
  // the dot keeps its centre
  function setSize(n) {
    n = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(Number(n) || 28)))
    if (n === size()) return
    getSettings().beaconSize = n
    if (bw && !bw.isDestroyed()) place(center())
    saveSettings()
    if (onSizeChanged) onSizeChanged()
  }

  // monitor setup changed: move to the position saved for the new setup
  function onDisplaysChanged() {
    if (!bw || bw.isDestroyed()) return
    setTimeout(() => {
      if (!bw || bw.isDestroyed()) return
      const c = savedCenter()
      if (c) place(c)
      else {
        const cur = center()
        const visible = screen.getAllDisplays().some((d) => {
          const a = d.bounds
          return cur.x >= a.x && cur.x < a.x + a.width && cur.y >= a.y && cur.y < a.y + a.height
        })
        if (!visible) place(defaultCenter())
      }
    }, 1200)
  }

  return { open, close, update, setSize, onDisplaysChanged, isOpen: () => !!(bw && !bw.isDestroyed()) }
}

module.exports = { createBeacon }
