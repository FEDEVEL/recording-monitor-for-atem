// Quick diagnostic: connect to the ATEM, print recording state and a few audio level samples.
const { Atem } = require('atem-connection')
const ip = process.argv[2] || '192.168.0.40'
const atem = new Atem({ disableMultithreaded: true })
let samples = 0
atem.on('error', (e) => console.error('ERR', e))
atem.on('connected', async () => {
  const s = atem.state
  console.log('Connected. Model:', s.info.productIdentifier, 'API', s.info.apiVersion)
  console.log('Recording:', JSON.stringify(s.recording, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  console.log('Fairlight inputs:', Object.keys(s.fairlight?.inputs || {}))
  for (const [id, inp] of Object.entries(s.fairlight?.inputs || {})) {
    console.log('  input', id, 'sources', Object.keys(inp.sources || {}), 'type', inp.properties?.externalPortType)
  }
  await atem.startFairlightMixerSendLevels()
  setTimeout(() => process.exit(0), 3000)
})
atem.on('levelChanged', (l) => {
  if (samples++ < 12) console.log('LEVEL', JSON.stringify(l, (k, v) => (typeof v === 'bigint' ? v.toString() : v)))
})
atem.connect(ip)
setTimeout(() => { console.log('Timeout - no connection'); process.exit(1) }, 8000)
