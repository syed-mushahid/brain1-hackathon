// All sounds are synthesised with WebAudio: no audio files to download.

class Sound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private crowdGain: GainNode | null = null
  private noise: AudioBuffer | null = null
  private crowdLevel = -1
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

  /** Pink-ish noise (Paul Kellet filter), used for the crowd and the kick. */
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

  /** Crowd bed: looping band-passed noise; level 0..1.3 (louder as the decision nears). */
  crowd(level: number): void {
    const { ctx, master, noise } = this
    if (!ctx || !master || !noise) return
    if (!this.crowdGain) {
      const src = ctx.createBufferSource()
      src.buffer = noise
      src.loop = true
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 850
      bp.Q.value = 0.5
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 2600
      this.crowdGain = ctx.createGain()
      this.crowdGain.gain.value = 0
      src.connect(bp).connect(lp).connect(this.crowdGain).connect(master)
      src.start()
    }
    if (Math.abs(level - this.crowdLevel) < 0.02) return
    this.crowdLevel = level
    this.crowdGain.gain.setTargetAtTime(0.22 * level, ctx.currentTime, 0.25)
  }

  /** Crowd reaction at the reveal: a swell for good passes, an "ooh" dip for bad ones. */
  react(good: boolean): void {
    const { ctx } = this
    if (!ctx || !this.crowdGain) return
    const g = this.crowdGain.gain
    const t = ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    if (good) {
      g.linearRampToValueAtTime(0.36, t + 0.25)
      g.setTargetAtTime(0.05, t + 0.9, 0.6)
    } else {
      g.linearRampToValueAtTime(0.12, t + 0.15)
      g.setTargetAtTime(0.04, t + 0.4, 0.5)
    }
    this.crowdLevel = -1
  }

  crowdOff(): void {
    if (this.ctx && this.crowdGain) this.crowdGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3)
    this.crowdLevel = 0
  }
}

export const sound = new Sound()
