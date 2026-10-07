export class Voice {
  constructor(name, onUpdate = null) {
    this.id = Voice._incremental_id++
    this.name = name

    Voice.Parameter._incremental_index = 0
    this._formatType = new Voice.Parameter(this, 0, 127, 0)
    this._flags = new Voice.Parameter(this, 0, 127, 0)
    this._polyphonyType = new Voice.Pack(this._flags, 0, 0x03)
    this._unisonType = new Voice.Pack(this._flags, 2, 0x07)
    this._detune = new Voice.Parameter(this, -1, 0.984375, 1)
    this._lfoFreqMod = new Voice.Parameter(this, 0, 1, 1)

    this.connect = new Voice.FMConnect(this)
    this.oscillators = [
      new Voice.Oscillator(this),
      new Voice.Oscillator(this),
      new Voice.Oscillator(this),
      new Voice.Oscillator(this),
    ]
    this.lfo = [new Voice.LowFreqOscillator(this), new Voice.LowFreqOscillator(this)]
    this.pitchEnvelope = new Voice.PitchEnvelope(this)
    this.filterEnvelope = new Voice.FilterEnvelope(this)

    this._bufferSize = Voice.Parameter._incremental_index
    this._buffer = new Uint8Array(this._bufferSize)
    this.initialize()

    this._onUpdate = onUpdate
  }

  // Worklet-only (WaveGenerator): a Voice that borrows a buffer per note via attach(). Not declared in voice.d.ts.
  static detached(name) {
    const voice = new Voice(name)
    voice._buffer = null
    return voice
  }

  get buffer() {
    if (!this._buffer) throw new Error(`Voice "${this.name}" is detached; call attach() first`)
    return this._buffer
  }

  attach(buffer) {
    if (buffer.length !== this._bufferSize) throw new Error(`Voice buffer size mismatch: ${buffer.length} != ${this._bufferSize}`)
    this._buffer = buffer
  }

  get formatType() {
    return this._formatType.uint7
  }

  initialize() {
    this._detune.value = 0
    this._lfoFreqMod.value = 0
    this._polyphonyType.value = Voice.POLYPHONY_TYPE.POLY
    this._unisonType.value = Voice.UNISON_TYPE.SINGLE
    this.connect.initialize()
    this.oscillators[0].initialize()
    this.oscillators[1].initialize()
    this.oscillators[2].initialize()
    this.oscillators[3].initialize()
    this.lfo[0].initialize()
    this.lfo[1].initialize()
    this.pitchEnvelope.initialize()
    this.filterEnvelope.initialize()
    return this
  }

  _updateParam(bufferIndex, data) {
    this.buffer[bufferIndex] = data & 127
  }
}
Voice._incremental_id = 0
Voice.POLYPHONY_TYPE = {
  POLY: 0,
  MONO: 1,
  PORTAMENT: 2
}
Voice.UNISON_TYPE = {
  SINGLE: 0,
  DUAL: 1,
  DUAL_5TH: 2,
  DUAL_OCTAVE: 3,
}
Voice.AmpLFOTable =
  [0, 0.0625, 0.125, 0.1875, 0.25, 0.3125, 0.375, 0.4375, 0.5, 0.5625, 0.625, 0.6875, 0.75, 0.8125, 0.875, 1]
Voice.PitchLFOTable =
  [0, 0.0625, 0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7, 9, 12]
Voice.FilterLFOTable =
  [0, 0.0625, 0.125, 0.1875, 0.25, 0.3125, 0.375, 0.4375, 0.5, 0.5625, 0.625, 0.6875, 0.75, 0.8125, 0.875, 1]


//---- base classes of all parameters
Voice.Parameter = class {
  constructor(voice, min, max, logBase, allowZero = false) {
    this._voice = voice
    this._index = Voice.Parameter._incremental_index++
    const key = `${min}:${max}:${logBase}:${allowZero}`
    if (!(key in Voice.Parameter._hash)) {
      if (logBase == 0) {
        Voice.Parameter._hash[key] = new Int16Array(128).map((_, i) =>
          i < max - min ? i + min : max
        )
      } else if (logBase == 1) {
        Voice.Parameter._hash[key] = new Float32Array(128).map(
          (_, i) => ((max - min) * i) / 127 + min
        )
      } else if (logBase == 2) {
        const t = new Float32Array(128).map((_, i) =>
          Math.pow(2, ((max - min) * i) / 128 + min)
        )
        t[127] = Math.pow(2, max)
        if (allowZero) t[0] = 0
        Voice.Parameter._hash[key] = t
      } else if (logBase == 3) {
        const t = new Float32Array(128).map((_, i) =>
          i == 64 ? 0 : i < 64 ? - Math.pow(2, max * (64 - i) / 64) : Math.pow(2, max * (i - 64) / 64)
        )
        t[127] = Math.pow(2, max)
        Voice.Parameter._hash[key] = t
      }
    }
    this._table = Voice.Parameter._hash[key]
  }

  get value() {
    return this._table[this.uint7]
  }

  set value(v) {
    const i = this._table.findIndex((ref) => v <= ref)
    if (i == -1) {
      this.uint7 = 127
    } else if (i == 0) {
      this.uint7 = 0
    } else {
      const min = this._table[i - 1]
      const max = this._table[i]
      this.uint7 = (v - min) / (max - min) < 0.5 ? i - 1 : i
    }
  }

  get uint7() {
    return this._voice.buffer[this._index] & 0x7f
  }

  set uint7(v) {
    const value = v & 0x7f
    this._voice.buffer[this._index] = value
    if (this._voice._onUpdate) {
      this._voice._onUpdate(this._index, value)
    }
  }

  get index() {
    return this.uint7
  }
  set index(i) {
    this.uint7 = i
  }
  get indexMax() {
    return 127
  }
}
Voice.Parameter._incremental_index = 0
Voice.Parameter._hash = {}

Voice.Flags = class {
  constructor(parameter, flag) {
    this._parameter = parameter
    this._flag = flag
  }

  get value() { 
    return !!(this._parameter.uint7 & this._flag)
  }

  set value(v) {
    this._parameter.uint7 =
      (this._parameter.uint7 & ~this._flag) | (v ? this._flag : 0)
  }

  get index() {
    return this.value ? 1 : 0
  }
  set index(i) {
    this.value = !!i
  }
  get indexMax() {
    return 1
  }
}

Voice.Pack = class {
  constructor(parameter, shift, filter) {
    this._parameter = parameter
    this._shift = shift
    this._filter = filter
  }

  get value() {
    return (this._parameter.uint7 >> this._shift) & this._filter
  }

  set value(v) {
    const _f = this._filter,
      _s = this._shift
    this._parameter.uint7 =
      (this._parameter.uint7 & ~(_f << _s)) | ((v & _f) << _s)
  }

  get index() {
    return this.value
  }
  set index(i) {
    this.value = i
  }
  get indexMax() {
    return this._filter
  }
}


//---- paamteres
Voice.FMConnect = class {
  constructor(voice) {
    this._flag_l = new Voice.Parameter(voice, 0, 127, 0)
    this._flag_h = new Voice.Parameter(voice, 0, 127, 0)
    this._osc1out = new Voice.Flags(this._flag_l, Voice.FMConnect.flags.WG1OUT)
    this._osc2out = new Voice.Flags(this._flag_l, Voice.FMConnect.flags.WG2OUT)
    this._osc3out = new Voice.Flags(this._flag_l, Voice.FMConnect.flags.WG3OUT)
    this._osc4out = new Voice.Flags(this._flag_l, Voice.FMConnect.flags.WG4OUT)
    this._osc2mod1 = new Voice.Flags(this._flag_l, Voice.FMConnect.flags.WG2MOD1)
    this._osc3mod1 = new Voice.Flags(this._flag_l, Voice.FMConnect.flags.WG3MOD1)
    this._osc3mod2 = new Voice.Flags(this._flag_l, Voice.FMConnect.flags.WG3MOD2)
    this._osc4mod1 = new Voice.Flags(this._flag_h, Voice.FMConnect.flags.WG4MOD1 >> 8)
    this._osc4mod2 = new Voice.Flags(this._flag_h, Voice.FMConnect.flags.WG4MOD2 >> 8)
    this._osc4mod3 = new Voice.Flags(this._flag_h, Voice.FMConnect.flags.WG4MOD3 >> 8)
  }

  initialize() {
    this.setALG(1, 0)
  }

  setALG(oscCount, alg) {
    const connections = Voice.FMConnect.algSet[oscCount - 1]
    if (alg < 0 || connections.length <= alg) {
      throw new Error("Voice.FMConnect alg#" + alg + " is not supported")
    }
    const flag = connections[alg] | Voice.FMConnect.flags.WG1OUT
    this._flag_l.uint7 = flag & 0x7f
    this._flag_h.uint7 = flag >> 8
  }

  isOscActive(oscIndex) {
    const flags = [0x0001, 0x0012, 0x0064, 0x0708]
    return !!(this.flags & flags[oscIndex])
  }

  get flags() {
    return this._flag_l.uint7 | (this._flag_h.uint7 << 8)
  }

  get oscout() {
    return [
      this._osc1out.value,
      this._osc2out.value,
      this._osc3out.value,
      this._osc4out.value,
    ]
  }

  get oscmod1() {
    return [
      null,
      this._osc2mod1.value,
      this._osc3mod1.value,
      this._osc4mod1.value,
    ]
  }

  get oscmod2() {
    return [null, null, this._osc3mod2.value, this._osc4mod2.value]
  }
}
Voice.FMConnect.flags = {
  WG1OUT: 0x0001,
  WG2OUT: 0x0002,
  WG3OUT: 0x0004,
  WG4OUT: 0x0008,
  WG2MOD1: 0x0010,
  WG3MOD1: 0x0020,
  WG3MOD2: 0x0040,
  WG4MOD1: 0x0100,
  WG4MOD2: 0x0200,
  WG4MOD3: 0x0400
}
const __ = Voice.FMConnect.flags
Voice.FMConnect.algSet = [
  [0],
  [
    __.WG2MOD1,
    __.WG2OUT,
    __.WG2MOD1 | __.WG2OUT,
  ],
  [
    __.WG2MOD1 | __.WG3MOD2,
    __.WG2MOD1 | __.WG3MOD1,
    __.WG2OUT | __.WG3MOD2,
    __.WG2MOD1 | __.WG3OUT,
    __.WG2OUT | __.WG3MOD1 | __.WG3MOD2,
    __.WG2OUT | __.WG3OUT,
    __.WG2OUT | __.WG3OUT | __.WG3MOD2,
  ],
  [
    __.WG2MOD1 | __.WG3MOD2,
    __.WG2MOD1 | __.WG3MOD1,
    __.WG2OUT | __.WG3MOD2,
    __.WG2OUT | __.WG3MOD1 | __.WG3MOD2,
    __.WG2OUT | __.WG3OUT,
    __.WG2OUT | __.WG3OUT | __.WG3MOD2,
  ],
  [
    __.WG2MOD1 | __.WG3MOD2 | __.WG4MOD3,
    __.WG2MOD1 | __.WG3MOD2 | __.WG4MOD2,
    __.WG2MOD1 | __.WG3MOD2 | __.WG4MOD1,
    __.WG2MOD1 | __.WG3OUT | __.WG4MOD3,
    __.WG2OUT | __.WG3OUT | __.WG4MOD3 | __.WG4MOD2 | __.WG4MOD1,
    __.WG2OUT | __.WG3OUT | __.WG4MOD3,
    __.WG2OUT | __.WG3OUT | __.WG4OUT,
    __.WG2OUT | __.WG3MOD2 | __.WG4MOD3,
    __.WG2MOD1 | __.WG3MOD2 | __.WG4OUT,
    __.WG2OUT | __.WG3MOD2 | __.WG4OUT,
    __.WG2MOD1 | __.WG3MOD1 | __.WG4MOD1,
    __.WG2MOD1 | __.WG3MOD1 | __.WG4OUT,
    __.WG2OUT | __.WG3MOD1 | __.WG4MOD3 | __.WG4OUT,
  ],
]


Voice.Waveform = class {
  constructor(voice) {
    this._wavelet = new Float32Array(Voice.Waveform.SAMPLE_COUNT)
    this._wavelet.fill(0)
    this._tableIndex = new Voice.Parameter(voice, 0, 127, 0)
    this._flag = new Voice.Parameter(voice, 0, 127, 0)
    this._windowMultiple = new Voice.Pack(this._flag, 0, 0x7)
    this._windowModulation = new Voice.Pack(this._flag, 3, 0x3)
    this._cacheKey = -1
  }

  initialize() {
    this._tableIndex.uint7 = Voice.Waveform._calcTableIndex(0, 4, 0)
    this._windowMultiple.value = 0
    this._windowModulation.value = 0
  }

  // type/pwm/deflate live in the buffer (tableIndex) so that both threads see the same shape.
  get type() { const i = this._tableIndex.uint7; return i >= Voice.Waveform.TABLE_INDEX_MAX ? 4 : i & 3 }
  set type(t) {
    this._tableIndex.uint7 = Voice.Waveform._calcTableIndex((t < 0) ? 0 : (t > 4) ? 4 : t, this.pwm, this.deflate)
  }

  get pwm() { const i = this._tableIndex.uint7; return i >= Voice.Waveform.TABLE_INDEX_MAX ? 4 : (i >> 2) % 9 }
  set pwm(p) {
    this._tableIndex.uint7 = Voice.Waveform._calcTableIndex(this.type, (p < 0) ? 0 : (p > 8) ? 8 : p, this.deflate)
  }

  get deflate() { const i = this._tableIndex.uint7; return i >= Voice.Waveform.TABLE_INDEX_MAX ? 0 : ((i >> 2) / 9) | 0 }
  set deflate(d) {
    this._tableIndex.uint7 = Voice.Waveform._calcTableIndex(this.type, this.pwm, (d < 0) ? 0 : (d > 2) ? 2 : d)
  }

  get windowMultiple() { return this._windowMultiple.value }
  set windowMultiple(v) { this._windowMultiple.value = v }

  get windowModulation() { return this._windowModulation.value }
  set windowModulation(v) { this._windowModulation.value = v }

  get wavelet() {
    const tableIndex = Math.min(this._tableIndex.uint7, Voice.Waveform.TABLE_INDEX_MAX)
    // The noise table is returned as-is (no window modulation, not copied to _wavelet).
    if (tableIndex > 107) return Voice.Waveform._getBasicWavelet(tableIndex)
    const key = tableIndex | (this._flag.uint7 << 8)
    if (key !== this._cacheKey) {
      const basewave = Voice.Waveform._getBasicWavelet(tableIndex)
      const sampleCount = Voice.Waveform.SAMPLE_COUNT
      const dp = 2 / sampleCount * (this._windowMultiple.value + 1)
      const k = [0, 0.5, 1, 2][this._windowModulation.value]
      for (let i=0, p=0; i < sampleCount; i++, p+=dp) {
        this._wavelet[i] = basewave[i] * (1 - (p & 1) * k)
      }
      this._cacheKey = key
    }
    return this._wavelet
  }

  static _calcTableIndex(type, pwm, deflate) {
    return (type > 3) ? (type + 104) : (type + (pwm + deflate * 9) * 4)
  }

  // type 0~4, pwm=0~8, deflate=0~2
  static _getBasicWavelet(tableIndex) {
    if (!Voice.Waveform._wavetables) {
      const genPWMFn = m => { // m=0~8
        const v = [0.0625, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 0.9375][m]
        const im = -0.69315 / Math.log(v) // loge(0.5)=-0.69315 (0< p < 1)
        return p => Math.pow(p, im)
      }
      const genDeflateFn = k => { // k=0~2
        if (k == 0) return o => o
        const v = [0, 1, 2][k]
        const comp = [1, 0.85, 0.7][k]
        const m = Math.exp(v)
        const exmm = Math.exp(-m)
        return o => {
          const exmo = Math.exp(m * o)
          return (o<0 ? (exmo - exmm) / (1 - exmm) - 1: 1 - (1/exmo - exmm) / (1 - exmm)) * comp
        }
      }
      const wt = (sampleCount, m, k, func) => {
        const pwm = genPWMFn(m)
        const deflate = genDeflateFn(k)
        const a = new Float32Array(sampleCount), dp = 1/sampleCount
        for (let i=0, p=dp/2; i<sampleCount; i++, p+=dp) a[i] = deflate(func(pwm(p), i))
        return a
      }
      const wtsqr = (sampleCount, m, k) => {
        const r = [0, 0.5, 1.2][k]
        const a = new Float32Array(sampleCount), dp = 1/sampleCount
        if (m < 5) {
          const pwm = genPWMFn(m)
          for (let i=0, p=dp/2; i<sampleCount; i++, p+=dp) {
            const pp = pwm(p)
            a[i] = (((pp < 0.5) ? 1 : -1) - Math.sin(2 * Math.PI * pp) * r) * 0.7
          }
        } else {
          const v = [0.0625, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 0.9375][m]
          const o = v * 2 - 1
          for (let i=0, p=dp/2; i<sampleCount; i++, p+=dp) {
            if (p < o) a[i] = 0
            else {
              const pp = (p - o) / (1 - o)
              a[i] = (((pp < 0.5) ? 1 : -1) - Math.sin(2 * Math.PI * pp) * r) * 0.7
            }
          }
        }
        return a
      }

      Voice.Waveform._wavetables = []
      // 0~107
      const sampleCount = Voice.Waveform.SAMPLE_COUNT
      for (let k=0; k<3; k++)
        for (let m=0; m<9; m++) {
          Voice.Waveform._wavetables.push(wt(sampleCount, m, k, p => Math.sin(2 * Math.PI * p) * 0.85))
          Voice.Waveform._wavetables.push(wt(sampleCount, m, k, p => ((p + 0.5) % 1) * 2 - 1))
          Voice.Waveform._wavetables.push(wt(sampleCount, m, k, p => 1 - 4 * Math.abs((p + 0.25) % 1 - 0.5)))
          Voice.Waveform._wavetables.push(wtsqr(sampleCount, m, k))
        }
      // 108(type=4): 16bit LFSR
      const a = new Float32Array(65536)
      for (let i=0, s=12345; i<65536; i++) a[i] = (s = (s>>1) | (((s<<10)^(s<<12)^(s<<13)^(s<<15)) & 0x8000)) / 32768 - 1
      Voice.Waveform._wavetables.push(a)
    }
    return Voice.Waveform._wavetables[tableIndex]
  }
}
Voice.Waveform.SAMPLE_COUNT = 1024
Voice.Waveform.TABLE_INDEX_MAX = 108 // noise; larger indices are reserved and clamped to this
Voice.Waveform.WAVE_TYPE = {
  SINE: 0,
  SAW: 1,
  TRIANGLE: 2,
  SQUARE: 3,
  NOISE: 4
}

Voice.LowFreqOscillator = class {
  constructor(voice) {
    this._waveShapeType = new Voice.Parameter(voice, 0, 4, 0)
    this._frequency = new Voice.Parameter(voice, -2, 6, 2)
    this._delay = new Voice.Parameter(voice, -11, 5, 2, true)
    this._time = new Voice.Parameter(voice, -11, 5, 2, true)
  }

  initialize() {
    this._waveShapeType.uint7 = 0
    this._frequency.value = 4
    this._delay.value = 0
    this._time.value = 0
  }
}

Voice.PitchEnvelope = class {
  constructor(voice) {
    this._attackTime = new Voice.Parameter(voice, -11, 5, 2, true)
    this._decayTime = new Voice.Parameter(voice, -11, 5, 2, true)
    this._sustainSlope = new Voice.Parameter(voice, 0, 8, 3)
    this._releaseSlope = new Voice.Parameter(voice, 0, 8, 3)
    this._startPitch = new Voice.Parameter(voice, -32, 31.5, 1)
    this._overShoot = new Voice.Parameter(voice, 0, 1, 1)
    this._lfoFlgs = new Voice.Parameter(voice, 0, 127, 0)
    this._lfoIndex = new Voice.Pack(this._lfoFlgs, 0, 0x03)
    this._lfoDepth = new Voice.Pack(this._lfoFlgs, 2, 0x0f)
    this._lfoSign = new Voice.Pack(this._lfoFlgs, 6, 0x01)
    this.totalLevel = 1
    this.attenuation = 1
  }

  initialize() {
    this._attackTime.value = 0
    this._decayTime.value = 0
    this._sustainSlope.value = 0
    this._releaseSlope.value = 0
    this._startPitch.value = 0
    this._overShoot.value = 0
    this._lfoIndex.value = 0
    this._lfoDepth.value = 0
    this._lfoSign.value = 0
    this.setState(Voice.EnvelopeState.OFF, 48000, 128)
  }

  setState(state, sampleRate, samplePerFrame) {
    const frameRate = sampleRate / samplePerFrame
    switch (state) {
      case Voice.EnvelopeState.ATTACK:
        if (this._attackTime.uint7 == 0) {
          return this.setState(
            Voice.EnvelopeState.DECAY,
            sampleRate,
            samplePerFrame
          )
        } else {
          this.sampleCount =
            Math.ceil(this._attackTime.value * frameRate)
          this.level = this._startPitch.value
          this.addition =
            (this._overShoot.value - this._startPitch.value) / this.sampleCount
        }
        break
      case Voice.EnvelopeState.DECAY:
        if (this._decayTime.uint7 == 0) {
          return this.setState(
            Voice.EnvelopeState.SUSTAIN,
            sampleRate,
            samplePerFrame
          )
        } else {
          this.sampleCount =
            Math.ceil(this._decayTime.value * frameRate)
          this.level = this._overShoot.value
          this.addition = -this._overShoot.value / this.sampleCount
        }
        break
      case Voice.EnvelopeState.SUSTAIN:
        this.sampleCount = 0
        this.level = 0
        this.addition = this._sustainSlope.value / frameRate
        break
      case Voice.EnvelopeState.RELEASE:
        this.sampleCount = 0
        this.addition = this._releaseSlope.value / frameRate
        break
      default:
        this.sampleCount = 0
        this.level = 0
        this.addition = 0
    }
    return state
  }
}


Voice.FilterEnvelope = class {
  constructor(voice) {
    this._flags = new Voice.Parameter(voice, 0, 127, 0)
    this._filterType = new Voice.Pack(this._flags, 0, 0x03)
    this._attackTime = new Voice.Parameter(voice, -11, 5, 2, true)
    this._decayTime = new Voice.Parameter(voice, -11, 5, 2, true)
    this._sustainSlope = new Voice.Parameter(voice, -6.4, 6.3, 1)
    this._releaseSlope = new Voice.Parameter(voice, -6.4, 6.3, 1)
    this._peakLevel = new Voice.Parameter(voice, 0, 1, 1)
    this._sustainLevel = new Voice.Parameter(voice, 0, 1, 1)
    this._resonance = new Voice.Parameter(voice, 0, 1, 1)
    this._lfoFlgs = new Voice.Parameter(voice, 0, 127, 0)
    this._lfoIndex = new Voice.Pack(this._lfoFlgs, 0, 0x03)
    this._lfoDepth = new Voice.Pack(this._lfoFlgs, 2, 0x0f)
    this._lfoSign = new Voice.Pack(this._lfoFlgs, 6, 0x01)
    this.totalLevel = 1
    this.attenuation = 1
  }

  initialize() {
    this._filterType.value = 0
    this._attackTime.value = 0
    this._decayTime.value = 0
    this._sustainSlope.value = 0
    this._releaseSlope.value = 0
    this._peakLevel.value = 1
    this._sustainLevel.value = 1
    this._resonance.value = 0
    this._lfoIndex.value = 0
    this._lfoDepth.value = 0
    this._lfoSign.value = 0
    this.setState(Voice.EnvelopeState.OFF, 48000, 128)
  }

  setState(state, sampleRate, samplePerFrame) {
    const frameRate = sampleRate / samplePerFrame
    switch (state) {
      case Voice.EnvelopeState.ATTACK:
        if (this._attackTime.uint7 == 0) {
          return this.setState(
            Voice.EnvelopeState.DECAY,
            sampleRate,
            samplePerFrame
          )
        } else {
          this.sampleCount = this._attackTime.value * frameRate
          this.level = 0
          this.addition = 1 / this.sampleCount
        }
        break
      case Voice.EnvelopeState.DECAY:
        if (this._decayTime.uint7 == 0) {
          return this.setState(
            Voice.EnvelopeState.SUSTAIN,
            sampleRate,
            samplePerFrame
          )
        } else {
          this.sampleCount =
            this._decayTime.uint7 == 0 ? 1 : this._decayTime.value * frameRate
          this.level = 1
          this.addition = (this._sustainLevel.value - 1) / this.sampleCount
        }
        break
      case Voice.EnvelopeState.SUSTAIN:
        this.sampleCount = 0
        this.level = this._sustainLevel.value
        this.addition = this._sustainSlope.value / frameRate
        break
      case Voice.EnvelopeState.RELEASE:
        this.sampleCount = 0
        this.addition = this._releaseSlope.value / frameRate
        break
      default:
        this.sampleCount = 0
        this.level = 0
        this.addition = 0
    }
    return state
  }
}


Voice.OscillatorEnvelope = class {
  constructor(voice) {
    this._attackTime = new Voice.Parameter(voice, -11, 5, 2, true)
    this._decayTime = new Voice.Parameter(voice, -11, 5, 2, true)
    this._sustainRate = new Voice.Parameter(voice, 0, 254, 1)
    this._releaseRate = new Voice.Parameter(voice, 0, 254, 1)
    this._peakLevel = new Voice.Parameter(voice, 0, 8, 2)
    this._sustainLevel = new Voice.Parameter(voice, -8, 0, 2)
    this._totalLevel = new Voice.Parameter(voice, -8, 0, 2)
  }

  initialize() {
    this._attackTime.value = 0
    this._decayTime.value = 0.5
    this._sustainRate.value = 0
    this._releaseRate.value = 254
    this._peakLevel.value = 1
    this._sustainLevel.value = 0.25
    this._totalLevel.value = 1
    this.setState(Voice.EnvelopeState.OFF, 48000, 128)
  }

  setState(state, sampleRate) {
    switch (state) {
      case Voice.EnvelopeState.ATTACK:
        this.totalLevel = this._totalLevel.value
        this.sampleCount =
          this._attackTime.uint7 == 0 ? 1 : this._attackTime.value * sampleRate
        this.level = 0
        this.attenuation = 1
        this.addition = this._peakLevel.value / this.sampleCount
        break
      case Voice.EnvelopeState.DECAY:
        this.sampleCount =
          this._decayTime.uint7 == 0 ? 1 : this._decayTime.value * sampleRate
        this.level = this._peakLevel.value
        this.attenuation = Math.pow(
          this._sustainLevel.value / this._peakLevel.value,
          1 / this.sampleCount
        )
        this.addition = 0
        break
      case Voice.EnvelopeState.SUSTAIN:
        this.sampleCount = 0
        this.level = this._sustainLevel.value
        this.attenuation = Math.pow(10, -this._sustainRate.value / (20 * sampleRate))
        this.addition = 0
        break
      case Voice.EnvelopeState.RELEASE:
        this.sampleCount = 0
        this.attenuation = Math.pow(10, -this._releaseRate.value / (20 * sampleRate))
        this.addition = 0
        break
      default:
        this.totalLevel = 0
        this.sampleCount = 0
        this.level = 0
        this.attenuation = 0
        this.addition = 0
    }
    return state
  }
}

Voice.EnvelopeState = {
  ATTACK: 0,
  DECAY: 1,
  SUSTAIN: 2,
  RELEASE: 3,
  OFF: 4,
}

Voice.Oscillator = class {
  constructor(voice) {
    this.envelope = new Voice.OscillatorEnvelope(voice)
    this.waveform = new Voice.Waveform(voice)
    this._flags = new Voice.Parameter(voice, 0, 127, 0)
    this._multiple = new Voice.Pack(this._flags, 0, 0x0f)
    this._pitchFixed = new Voice.Flags(this._flags, 0x10)
    this._applyFilter = new Voice.Flags(this._flags, 0x20)
    this._coarse = new Voice.Parameter(voice, -64, 63, 1)
    this._fine = new Voice.Parameter(voice, -1, 0.984375, 1)
    this._feedback = new Voice.Parameter(voice, 0, 1, 1)
    this._lfoFlgs = new Voice.Parameter(voice, 0, 127, 0)
    this._lfoIndex = new Voice.Pack(this._lfoFlgs, 0, 0x03)
    this._lfoDepth = new Voice.Pack(this._lfoFlgs, 2, 0x0f)
    this._lfoSign = new Voice.Pack(this._lfoFlgs, 6, 0x01)
  }

  initialize() {
    this.envelope.initialize()
    this.waveform.initialize()
    this._multiple.value = 0
    this._pitchFixed.value = false
    this._applyFilter.value = true
    this._coarse.value = 0
    this._fine.value = 0
    this._feedback.value = 0
    this._lfoIndex.value = 0
    this._lfoDepth.value = 0
    this._lfoSign.value = 0
  }
}
