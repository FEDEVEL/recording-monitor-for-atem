// Renders build/icon.svg to build/icon.png (512x512) using Electron. Run: npx electron tools/make-icon.js
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8')
  const w = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  await w.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`))
  await new Promise((r) => setTimeout(r, 300))
  const img = (await w.webContents.capturePage()).resize({ width: 512, height: 512 })
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.toPNG())
  console.log('build/icon.png written', img.getSize())
  app.quit()
})
