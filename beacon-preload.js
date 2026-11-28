// Bridge for the beacon dot window (only the few calls it needs)
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('beacon', {
  onStatus: (fn) => ipcRenderer.on('beacon', (_e, s) => fn(s)),
  down: (x, y) => ipcRenderer.send('beacon:down', x, y),
  up: () => ipcRenderer.send('beacon:up'),
})
