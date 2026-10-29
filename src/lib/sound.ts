// All sounds are synthesised with WebAudio: no audio files to download.

class Sound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  muted = false

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        this.ctx = new AC()
        this.master = this.ctx.createGain()
        this.master.gain.value = this.muted ? 0 : 1
        this.master.connect(this.ctx.destination)
        this.noise = this.makeNoise(2)
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume()
    } catch {
      this.ctx = null
    }
  }

  setMuted(m: boolean): void {
    this.muted = m
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.05)
  }

  /** Pink-ish noise (Paul Kellet filter), used for the kick and the music's hi-hat. */
  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate)
    const d = buf.getChannelData(0)
    let b0 = 0, b1 = 0, b2 = 0
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1
      b0 = 0.99765 * b0 + w * 0.099046
      b1 = 0.963 * b1 + w * 0.2965164
      b2 = 0.57 * b2 + w * 1.0526913
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2
    }
    return buf
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
  }

  /** Referee whistle: a trilled ~2.9 kHz tone. `blasts` short blasts in a row. */
  whistle(blasts = 1, length = 0.32): void {
    const { ctx, master } = this
    if (!ctx || !master) return
    for (let b = 0; b < blasts; b++) {
      const t = ctx.currentTime + b * (length + 0.12)
      const osc = ctx.createOscillator()
      const trill = ctx.createOscillator()
      const trillGain = ctx.createGain()
      const g = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 2900
      trill.frequency.value = 28
      trillGain.gain.value = 140
      trill.connect(trillGain).connect(osc.frequency)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.02)
      g.gain.setValueAtTime(0.09, t + length - 0.05)
      g.gain.exponentialRampToValueAtTime(0.0001, t + length)
      osc.connect(g).connect(master)
      osc.start(t)
      trill.start(t)
      osc.stop(t + length + 0.02)
      trill.stop(t + length + 0.02)
    }
  }

  /** Ball strike: low thump + short filtered noise click. */
  kick(strength = 1): void {
    const { ctx, master, noise } = this
    if (!ctx || !master || !noise) return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.frequency.setValueAtTime(150, t)
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.12)
    this.env(g, t, 0.35 * strength, 0.004, 0.14)
    osc.connect(g).connect(master)
    osc.start(t)
    osc.stop(t + 0.2)
    const src = ctx.createBufferSource()
    const f = ctx.createBiquadFilter()
    const ng = ctx.createGain()
    src.buffer = noise
    f.type = 'lowpass'
    f.frequency.value = 1800
    this.env(ng, t, 0.25 * strength, 0.002, 0.05)
    src.connect(f).connect(ng).connect(master)
    src.start(t, Math.random())
    src.stop(t + 0.08)
  }

  /** Short UI tick for scans. */
  tick(): void {
    const { ctx, master } = this
    if (!ctx || !master) return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = 1400
    this.env(g, t, 0.05, 0.003, 0.06)
    osc.connect(g).connect(master)
    osc.start(t)
    osc.stop(t + 0.08)
  }

  /** Audio is unlocked (a user gesture happened): music can start without waiting for one. */
  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running'
  }

  /**
   * Home-screen music: a calm synthesised loop (no files) - 96 bpm, Am / F / C / G, soft pads, a plucked
   * arpeggio, bass, and a light kick and hi-hat. Fades in; musicOff() fades it out. Notes are scheduled a
   * little ahead on the audio clock (a timer tops the queue up), so the timing doesn't drift.
   */
  musicOn(): void {
    const { ctx, master } = this
    if (!ctx || !master || this.music) return
    const gain = ctx.createGain()
    gain.gain.value = 0.0001
    gain.connect(master)
    gain.gain.setTargetAtTime(MUSIC.volume, ctx.currentTime, 0.8)
    const m = { gain, next: ctx.currentTime + 0.1, step: 0, timer: 0 }
    m.timer = window.setInterval(() => this.scheduleMusic(m), 25)
    this.scheduleMusic(m)
    this.music = m
  }

  musicOff(): void {
    const m = this.music
    if (!m || !this.ctx) return
    this.music = null
    window.clearInterval(m.timer)
    const t = this.ctx.currentTime
    m.gain.gain.cancelScheduledValues(t)
    m.gain.gain.setValueAtTime(m.gain.gain.value, t)
    m.gain.gain.setTargetAtTime(0.0001, t, 0.25)
    window.setTimeout(() => m.gain.disconnect(), 2000)
  }

  private music: { gain: GainNode; next: number; step: number; timer: number } | null = null

  private scheduleMusic(m: { gain: GainNode; next: number; step: number }): void {
    const ctx = this.ctx!
    const stepS = 60 / MUSIC.bpm / 4 // 16th notes
    while (m.next < ctx.currentTime + 0.12) {
      const bar = Math.floor(m.step / 16) % MUSIC.chords.length
      const s = m.step % 16
      const chord = MUSIC.chords[bar]
      const t = m.next
      if (s === 0) for (const n of chord.pad) this.voice(m.gain, n, t, 16 * stepS, 'triangle', 0.035, 0.35, 900)
      if (s % 2 === 0) {
        const n = chord.pad[[0, 1, 2, 3, 2, 1, 2, 3][s / 2]] + 12
        this.voice(m.gain, n, t, 0.3, 'sine', 0.045, 0.005, 3000)
      }
      if (s === 0 || s === 6 || s === 8) this.voice(m.gain, chord.bass, t, s === 6 ? 0.25 : 0.45, 'sine', 0.13, 0.01, 600)
      if (s === 0 || s === 8) this.drum(m.gain, t, 'kick')
      if (s === 4 || s === 12 || (s % 2 === 1 && s > 8)) this.drum(m.gain, t, 'hat')
      m.next += stepS
      m.step++
    }
  }

  /** One note: MIDI number n, held `dur` s, with an attack and a gentle release, through a lowpass. */
  private voice(out: GainNode, n: number, t: number, dur: number, type: OscillatorType, peak: number, attack: number, cutoff: number): void {
    const ctx = this.ctx!
    const osc = ctx.createOscillator()
    const f = ctx.createBiquadFilter()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.value = 440 * Math.pow(2, (n - 69) / 12)
    f.type = 'lowpass'
    f.frequency.value = cutoff
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(f).connect(g).connect(out)
    osc.start(t)
    osc.stop(t + dur + 0.05)
  }

  private drum(out: GainNode, t: number, kind: 'kick' | 'hat'): void {
    const { ctx, noise } = this
    if (!ctx || !noise) return
    const g = ctx.createGain()
    if (kind === 'kick') {
      const osc = ctx.createOscillator()
      osc.frequency.setValueAtTime(110, t)
      osc.frequency.exponentialRampToValueAtTime(45, t + 0.12)
      this.env(g, t, 0.16, 0.004, 0.18)
      osc.connect(g).connect(out)
      osc.start(t)
      osc.stop(t + 0.25)
    } else {
      const src = ctx.createBufferSource()
      const f = ctx.createBiquadFilter()
      src.buffer = noise
      f.type = 'highpass'
      f.frequency.value = 7000
      this.env(g, t, 0.05, 0.002, 0.04)
      src.connect(f).connect(g).connect(out)
      src.start(t, Math.random())
      src.stop(t + 0.06)
    }
  }
}

/** The home-screen loop: chords (pad voicing and bass root, MIDI numbers), tempo and level. */
const MUSIC = {
  bpm: 96,
  volume: 0.55,
  chords: [
    { pad: [57, 60, 64, 67], bass: 45 }, // Am7
    { pad: [53, 57, 60, 64], bass: 41 }, // Fmaj7
    { pad: [55, 60, 64, 67], bass: 48 }, // C
    { pad: [55, 59, 62, 69], bass: 43 }, // G(add9)
  ],
}

export const sound = new Sound()
