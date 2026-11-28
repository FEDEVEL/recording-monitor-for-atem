// Beacon dot page: show the status colour, pass mouse actions to the main process
window.beacon.onStatus((s) => {
  document.body.className = s.level
})
document.addEventListener('mousedown', (e) => {
  if (e.button === 0) window.beacon.down(e.clientX, e.clientY)
})
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) window.beacon.up()
})
