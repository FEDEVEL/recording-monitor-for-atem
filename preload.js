// Safe bridge between the UI (renderer) and the main process
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('atemAlert', {
  on: (channel, fn) => {
    if (!['state', 'event', 'levels', 'audioChannels', 'log'].includes(channel)) return
    ipcRenderer.on(channel, (_e, payload) => fn(payload))
  },
  ack: () => ipcRenderer.send('ack'),
  setIp: (ip) => ipcRenderer.send('setIp', ip),
  setAlwaysOnTop: (v) => ipcRenderer.send('setAlwaysOnTop', v),
  setBeacon: (v) => ipcRenderer.send('setBeacon', v),
  setBeaconSize: (v) => ipcRenderer.send('setBeaconSize', v),
  setStopFrame: (v) => ipcRenderer.send('setStopFrame', v),
  setVolume: (v) => ipcRenderer.send('setVolume', v),
  openLogs: () => ipcRenderer.send('openLogs'),
  simulate: (what) => ipcRenderer.send('simulate', what),
  interview: (action) => ipcRenderer.send('interview', action),
  openSessions: () => ipcRenderer.send('openSessions'),
  setCursorOptions: (o) => ipcRenderer.send('setCursorOptions', o),
  setSoundOption: (key, on) => ipcRenderer.send('setSoundOption', key, on),
  setAudioMeters: (on) => ipcRenderer.send('setAudioMeters', on),
  openProjectPage: (which) => ipcRenderer.send('openProjectPage', which),
  checkUpdates: () => ipcRenderer.invoke('checkUpdates'),
  ignoreWarning: (id) => ipcRenderer.send('ignoreWarning', id),
})
