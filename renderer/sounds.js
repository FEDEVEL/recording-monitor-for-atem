// Alert sounds generated with Web Audio (no sound files needed)
const Sounds = (() => {
  let ctx = null
  let volume = 0.6
  function ac() {
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') ctx.resume()
    return ctx
  }
  // pattern: array of [frequencyHz, durationMs, pauseAfterMs]
  function play(pattern) {
    const c = ac()
    let t = c.currentTime + 0.05
    for (const [freq, dur, gap] of pattern) {
      const osc = c.createOscillator()
      const g = c.createGain()
      osc.type = 'square'
      osc.frequency.value = freq
      const v = volume * 0.25 // square waves are loud
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(v, t + 0.005)
      g.gain.setValueAtTime(v, t + dur / 1000 - 0.01)
      g.gain.linearRampToValueAtTime(0, t + dur / 1000)
      osc.connect(g).connect(c.destination)
      osc.start(t)
      osc.stop(t + dur / 1000 + 0.02)
      t += (dur + gap) / 1000
    }
  }
  return {
    setVolume: (v) => (volume = v),
    // 3 short high beeps: recording started
    start: () => play([[1200, 120, 100], [1200, 120, 100], [1200, 120, 0]]),
    // 3 long low beeps: recording stopped
    stop: () => play([[440, 600, 250], [440, 600, 250], [440, 600, 0]]),
    // siren-like: unexpected stop / lost connection (repeated by app.js until acknowledged)
    alarm: () => play([[1000, 250, 50], [600, 250, 50], [1000, 250, 50], [600, 250, 50], [1000, 250, 50], [600, 400, 0]]),
    // two soft-ish mid beeps: yellow warning
    warning: () => play([[750, 150, 120], [750, 150, 0]]),
    // interview started: two rising tones / ended: two falling / mark: one short blip
    ivStart: () => play([[660, 160, 60], [990, 260, 0]]),
    ivEnd: () => play([[990, 160, 60], [660, 260, 0]]),
    mark: () => play([[1600, 70, 0]]),
    // cursor left the window: one soft low tone
    cursor: () => play([[520, 180, 0]]),
    // rising: connection restored
    restored: () => play([[600, 120, 60], [900, 120, 60], [1200, 160, 0]]),
  }
})()
