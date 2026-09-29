import { Voice } from "./voice.js"

const clamp = (v, min, max) => (v < min ? min : v > max ? max : v)


class ROM {
  static singleton(sampleRate) {
    return ROM._instance || (ROM._instance = new ROM(sampleRate))
  }

  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.samplesPerFrame = 128
    this.zero = new Float32Array(1025).fill(0)

    this.phaseDelta = {
      "default": new Float32Array(8192).map((_, i) => 440 * Math.pow(2, (i/64 - 69) / 12) / sampleRate),
      "sample440": new Float32Array(8192).map((_, i) => Math.pow(2, (i/64 - 69) / 12)),
    }
    this.panVolume = new Float32Array(256).map((_, i) => Math.cos(i/512*Math.PI))

    // Singleton
    ROM._instance = this
    console.log("SiON::SoundModule ROM Table has been initialized.")
  }

  get frameRate() {
    return this.sampleRate / this.samplesPerFrame
  }
}
ROM._instance = null



class StateVariableFilter {
  constructor(rom) {
    this.rom = rom
    this.v = [0, 0, 0]
    this.type = StateVariableFilter.Type.HIGH
    this.cutoff = 0
    this.feedback = 0
  }

  get cutoff() { return this._cutoff }
  set cutoff(v) {
    this._cutoff = v
    this._co = v * v
  }

  get feedback() { return this._feedback }
  set feedback(v) {
    this._feedback = v
    this._fb = 1 / ((v < 1/512) ? 1 : v * 512)  // 0~1 => 1~1/512
  }

  apply(source) {
    const fb = this._fb
    const co = this._co
    for (let i = 0; i < source.length; i++) {
      this.v[2] = source[i] - this.v[0] - this.v[1] * fb
      this.v[1] += this.v[2] * co
      this.v[0] += this.v[1] * co
      source[i] = this.v[this.type]
    }
    return source
  }
}
StateVariableFilter.Type = {
  LOW: 0,
  BAND: 1,
  HIGH: 2
}


class LowFreqOscillator {
  constructor(rom, voice) {
    this.rom = rom
    this.voice = voice
  }

  reset() {
    this._wavelet = Voice.Waveform._getBasicWavelet(16)
    this._frameCounter = 0
    this._envLevel = 0
    this._addition = 0
    this._phase = 0
    this._state = EnvelopeGenerator.State.OFF
  }

  keyon() {
    this.changeState(EnvelopeGenerator.State.ATTACK)
    const tableIndex = Voice.Waveform._calcTableIndex(this.voice._waveShapeType.value, 4, 0)
    this._wavelet = Voice.Waveform._getBasicWavelet(tableIndex)
  }
  
  keyoff() {
  }
  
  changeState(state) {
    const frameRate = this.rom.sampleRate / this.rom.samplesPerFrame
    switch(state) {
    case EnvelopeGenerator.State.ATTACK:
      if (this.voice._delay.uint7 == 0) {
        this.changeState(EnvelopeGenerator.State.DECAY)
        return 
      } else {
        this._frameCounter = this.voice._delay.value * frameRate
        this._envLevel = 0
        this._addition = 0
      }
      break
    case EnvelopeGenerator.State.DECAY:
      if (this.voice._time.uint7 == 0) {
        this.changeState(EnvelopeGenerator.State.SUSTAIN)
        return 
      } else {
        this._frameCounter = this.voice._time.value * frameRate
        this._envLevel = 0
        this._addition = 1 / this._frameCounter
        this._phase = 0
      }
      break
    case EnvelopeGenerator.State.SUSTAIN:
      this._frameCounter = 0
      this._envLevel = 1
      break
    }
    this._state = state
  }

  stepByFrame(controlLevel, controlSpeed) {
    const frameRate = this.rom.sampleRate / this.rom.samplesPerFrame
    this._envLevel = clamp(this._envLevel + this._addition, 0, 1)
    this._phase += this.voice._frequency.value / frameRate * controlSpeed
    if (1 <= this._phase) this._phase -= 1

    if (--this._frameCounter == 0) this.changeState(this._state + 1)
    const wave = this._wavelet
    const index = (wave.length * this._phase) & (wave.length - 1)
    return wave[index] * (this._envLevel + controlLevel)
  }
}


class EnvelopeGenerator {
  constructor(rom, voice) {
    this.rom = rom
    this.voice = voice
    this.reset()
  }

  get state() {
    return this._state
  }

  reset() {
    this.changeState(EnvelopeGenerator.State.OFF)
  }

  keyon() {
    this.changeState(EnvelopeGenerator.State.ATTACK)
  }

  keyoff() {
    this.changeState(EnvelopeGenerator.State.RELEASE)
  }

  changeState(state) {
    this._state = this.voice.setState(state, this.rom.sampleRate, this.rom.samplesPerFrame)

    if (this._state !== EnvelopeGenerator.State.RELEASE) {
      this._envLevel = this.voice.level
    }
    this._sampleCounter = this.voice.sampleCount >> 0
  }

  apply(source, mixin, lfoOutput) {
    const level = this.voice.totalLevel + lfoOutput
    for (let i=0; i<source.length; i++) {
      this._envLevel = this._envLevel * this.voice.attenuation + this.voice.addition
      const waveout = clamp(source[i] * this._envLevel, -1, 1)
      source[i] = waveout * level + mixin[i]
      if (--this._sampleCounter == 0) {
        this.changeState(this._state + 1)
      }
    }

    if (this._state === EnvelopeGenerator.State.RELEASE && this._envLevel < 0.0001) {
      this.changeState(EnvelopeGenerator.State.OFF)
    }
  }

  stepByFrame() {
    if (this._state == EnvelopeGenerator.State.OFF) return 0
    this._envLevel = this._envLevel * this.voice.attenuation + this.voice.addition
    if (--this._sampleCounter == 0) {
      this.changeState(this._state + 1)
    }
    return this._envLevel
  }
}
EnvelopeGenerator.State = {
  ATTACK: 0,
  DECAY: 1,
  SUSTAIN: 2,
  RELEASE: 3,
  OFF: 4,
}

class Oscillator {
	constructor(id, rom, voice) {
    this.id = id
    this.rom = rom
    this.voice = voice
    this.eg = new EnvelopeGenerator(rom, voice.envelope)

    this._outbuffer = new ArrayBuffer(Float32Array.BYTES_PER_ELEMENT * (rom.samplesPerFrame + 1))
    this.fb = new Float32Array(this._outbuffer)
    this.out = new Float32Array(this._outbuffer, Float32Array.BYTES_PER_ELEMENT, this.rom.samplesPerFrame)

    this.reset()
  }

  get pitch() { return this._pitch }

  reset() {
    this.eg.reset()
    this._pitch = 0
    this._phase = 0
    this._phaseDelta = this.rom.phaseDelta["default"]
    this.resetConnection()
  }

  keyon() {
    this.eg.keyon()
  }

  keyoff() {
    this.eg.keyoff()
  }

  resetConnection() {
    this.in = this.rom.zero
    this.mod = this.fb
    this.isActive = false
    this.isCarrier = false
    this.isConnectToOut = false
  }

  isEnvelopeOff() {
    return this.eg.state === EnvelopeGenerator.State.OFF
  }

  generate(pitch, amod, pmod) {
    const imax = this.rom.samplesPerFrame

    if (!this.isActive) return
    
    if (this.isEnvelopeOff()) {
      this.out.fill(0)
    } else {
      const wave = this.voice.waveform.wavelet
      const phaseIndexFilter = wave.length - 1
      const multiple = this.voice._multiple.value + 1
      const fmgain = this.isCarrier ? 1 : this.voice._feedback.value

      this._pitch = pitch + this.voice._coarse.value + this.voice._fine.value + pmod
      const pitchIndex = clamp(this._pitch * 64, 0, 8191) >> 0
      const phaseDelta = this._phaseDelta[pitchIndex] * multiple

      for (let i = 0; i < imax; i++) {
        const phaseFM = this._phase + this.mod[i] * fmgain
        const phaseIndex = (phaseFM * wave.length) & phaseIndexFilter
        this.out[i] = wave[phaseIndex]
        this._phase += phaseDelta
        if (this._phase > 1) this._phase -= 1
      }
    }

    this.fb[0] = this.out[imax-1]
    this.eg.apply(this.out, this.in, amod)
  }
}


class WaveGenerator {
  constructor(rom, generatorID) {
    this.rom = rom
    this._generatorID = generatorID
    this.voice = new Voice("generator#" + generatorID, false)

    this.osc = [
      new Oscillator(0, rom, this.voice.oscillators[0]), 
      new Oscillator(1, rom, this.voice.oscillators[1]), 
      new Oscillator(2, rom, this.voice.oscillators[2]), 
      new Oscillator(3, rom, this.voice.oscillators[3])
    ]
    this.pitch_eg = new EnvelopeGenerator(rom, this.voice.pitchEnvelope)
    this.filter_eg = new EnvelopeGenerator(rom, this.voice.filterEnvelope)
    this.lfo = [
      new LowFreqOscillator(rom, this.voice.lfo[0]),
      new LowFreqOscillator(rom, this.voice.lfo[1])
    ]
    this.filter = new StateVariableFilter(rom)

    this.reset()
  }

  //---- events
  reset() {
    for (let i=0; i<this.osc.length; i++) {
      this.osc[i].reset()
    }
    this.pitch_eg.reset()
    this.filter_eg.reset()
    this.lfo[0].reset()
    this.lfo[1].reset()
    this.notenumber = 60
    this.velocity = 0
    this._oscConnectionFlags = -1
    this._filterOutOsc = -1
    this._directOutOsc = -1
    this._noteonID = 0
    this._sustain = false
    this._sustainNoteOff = false
  }

  noteon(noteonID, data, voiceBuffer) {
    this._noteonID = noteonID
    this.notenumber = data.notenumber
    this.velocity = data.velocity

    this.voice.buffer = voiceBuffer
    this._updateOscConnections()

    this.pitch_eg.keyon()
    this.filter_eg.keyon()
    this.lfo[0].keyon()
    this.lfo[1].keyon()
    this.osc[0].keyon()
    this.osc[1].keyon()
    this.osc[2].keyon()
    this.osc[3].keyon()
  }

  noteoff() {
    if (this._sustain) {
      this._sustainNoteOff = true
    } else {
      this.pitch_eg.keyoff()
      this.filter_eg.keyoff()
      this.lfo[0].keyoff()
      this.lfo[1].keyoff()
      this.osc[0].keyoff()
      this.osc[1].keyoff()
      this.osc[2].keyoff()
      this.osc[3].keyoff()
    }
  }

  sustain(flag) {
    this._sustain = flag
    if (!this._sustain) {
      if (this._sustainNoteOff) {
        this.noteoff()
      }
      this._sustainNoteOff = false
    }
  }

  isSilent() {
    return (this.osc[0].isEnvelopeOff() || !this.osc[0].isConnectToOut) &&
           (this.osc[1].isEnvelopeOff() || !this.osc[1].isConnectToOut) &&
           (this.osc[2].isEnvelopeOff() || !this.osc[2].isConnectToOut) &&
           (this.osc[3].isEnvelopeOff() || !this.osc[3].isConnectToOut)
  }


  generate(stereo_out, parameters) {
    if (this.isSilent()) return

    const dst_imax = stereo_out[0].length
    const imax = this.rom.samplesPerFrame

    // calc lfo output
    const lfoOutputs = [
      this.lfo[0].stepByFrame(parameters.lfo[0], parameters.lfospeed[0]),
      this.lfo[1].stepByFrame(parameters.lfo[0], parameters.lfospeed[0]), 0, 0
    ]
    // calc modulation
    const pmod = lfoOutputs[this.voice.pitchEnvelope._lfoIndex.value] * this.voice.pitchEnvelope.lfoDepth()
    const fmod = lfoOutputs[this.voice.filterEnvelope._lfoIndex.value] * this.voice.filterEnvelope.lfoDepth()
    const pitchShift = this.pitch_eg.stepByFrame() + parameters.pitch[0]

    this.filter.type = this.voice.filterEnvelope._filterType.value
    this.filter.cutoff = clamp(this.filter_eg.stepByFrame() + parameters.cutoff[0] + fmod, 0, 1)
    this.filter.feedback = clamp(this.voice.filterEnvelope._resonance.value + parameters.resonance[0], 0, 1)

    const outputLevel = parameters.volume[0] * parameters.expression[0] * this.velocity
    const panIndex = clamp((parameters.pan[0] + 1) * 128, 0, 255) >> 0
    const volumeL = this.rom.panVolume[panIndex] * outputLevel
    const volumeR = this.rom.panVolume[255-panIndex] * outputLevel
    
    for (let dst_i = 0; dst_i < dst_imax; ) {
      for (let osc_i = this.osc.length - 1; osc_i >= 0 ; --osc_i) {
        const oscVoice = this.voice.osc[osc_i]
        const amod = lfoOutputs[oscVoice._lfoIndex.value] * oscVoice.lfoDepth()
        this.osc[osc_i].generate(this.notenumber + pitchShift, amod, pmod)
      }
      const filterOut = (this._filterOutOsc == -1) ? 
        ROM._instance.zero : this.filter.apply(this.osc[this._filterOutOsc].out)
      const directOut = (this._directOutOsc == -1) ? 
        ROM._instance.zero : this.osc[this._directOutOsc].out

      for (let i = 0; i < imax && dst_i < dst_imax; i++, dst_i++) {
        stereo_out[0][dst_i] += (filterOut[i] + directOut[i]) * volumeL
        stereo_out[1][dst_i] += (filterOut[i] + directOut[i]) * volumeR
      }
    }
  }

  //---- private
  _priority() {
    if (this.isSilent()) return 0
    return this._noteonID + (this.pitch_eg.state !== EnvelopeGenerator.State.RELEASE ? 100 : 0)
  }

  _updateOscConnections() {
    // check flags first of all
    if (this._oscConnectionFlags === this.voice.connect.flags) return

    // reset all
    this.osc[0].resetConnection()
    this.osc[1].resetConnection()
    this.osc[2].resetConnection()
    this.osc[3].resetConnection()

    // voice not alived
    if (!this.voice.isAlive) {
      this._oscConnectionFlags = -1
      return
    }

    // connect
    const con = this.voice.connect
    this._oscConnectionFlags = con.flags

    let lastFilterOut, lastDirectOut, lastCarrier, flags

    flags = con.oscout
    for (let i=0, lastFilterOut=-1, lastDirectOut=-1; i<this.osc.length; i++) {
      if (flags[i]) {
        if (this.voice.oscillators[i]._applyFilter.value) {
          if (lastFilterOut == -1) lastFilterOut = 0
          this.osc[lastFilterOut].in = this.osc[i].out
          this.osc[i].isConnectToOut = true
          this.osc[i].isActive = true
          lastFilterOut = i
        } else {
          if (lastDirectOut == -1) lastDirectOut = 0
          this.osc[lastDirectOut].in = this.osc[i].out
          this.osc[i].isConnectToOut = true
          this.osc[i].isActive = true
          lastDirectOut = i
        }
      }
    }
    this._filterOutOsc = lastFilterOut
    this._directOutOsc = lastDirectOut

    flags = con.oscmod1
    for (i=1, lastCarrier=0; i<this.osc.length; i++) {
      if (flags[i]) {
        this.osc[lastCarrier].mod = this.osc[i].out
        this.osc[lastCarrier].isCarrier = true
        this.osc[i].isActive = true
        lastCarrier = i
      }
    }

    flags = con.oscmod2
    for (i=2, lastCarrier=1; i<this.osc.length; i++) {
      if (flags[i]) {
        this.osc[lastCarrier].mod = this.osc[i].out
        this.osc[lastCarrier].isCarrier = true
        this.osc[i].isActive = true
        lastCarrier = i
      }
    }

    if (con._osc4mod3.value) {
      this.osc[2].mod = this.osc[3].out
      this.osc[2].isCarrier = true
      this.osc[3].isActive = true
    }
  }
}


class Channel extends AudioWorkletProcessor {
  constructor(option) {
    super(option)
    this.rom = ROM.singleton(option.processorOptions.sampleRate)
    this._generators = []
    this._generatorCount = 0
    this._voice = new Voice("default", true)
    this._noteVoiceBuffers = []
    this.port.onmessage = e => this.onMessage(e)

    this._noteonIDCounter = 0
    this.generatorCount = option.generatorCount || 3

    this.events = Channel.getEventHandlers(this)
  }


  static get parameterDescriptors() {
    return [
      {name: 'volume', defaultValue: 0.75, minValue: 0, maxValue: 1},
      {name: 'expression', defaultValue: 1, minValue: 0, maxValue: 1},
      {name: 'pan', defaultValue: 0, minValue: -1, maxValue: 1},

      {name: 'pitch', defaultValue: 0, minValue: -128, maxValue: 128},
      {name: 'lfo', defaultValue: 0, minValue: 0, maxValue: 1},
      {name: 'lfospeed', defaultValue: 1, minValue: 0.01, maxValue: 100},
      {name: 'cutoff', defaultValue: 0, minValue: -1, maxValue: 1},
      {name: 'resonance', defaultValue: 0, minValue: -1, maxValue: 1},

      {name: 'dry', defaultValue: 1.0, minValue: 0, maxValue: 1},
      {name: 'effect1', defaultValue: 0.25, minValue: 0, maxValue: 1},
      {name: 'effect2', defaultValue: 0.0, minValue: 0, maxValue: 1},
      {name: 'effect3', defaultValue: 0.0, minValue: 0, maxValue: 1},
    ]
  }

  static getEventHandlers(_this) {
    return {
      noteon: data => {
        const wg = _this._getWaveGenerator(data.notenumber)
        if (wg) {
          const buffer = _this._noteVoiceBuffers[data.notenumber>>0] || _this._voice.buffer
          wg.noteon(_this._noteonIDCounter++, data, buffer)
        }
      },
  
      noteoff: data => {
        const wg = _this._findWaveGenerator(data.notenumber)
        if (wg) {
          wg.noteoff()
        }
      },
    
      reserve: data => {
        _this.generatorCount = data.count || 3
      },
    
      sustain: data => {
        for (let wg of _this._generators) {
          wg.sustain(data.flag)
        }
      },
    
      _updateVoiceParam: data => {
        _this._voice._updateParam(data.index, data.value)
      }
    }
  }


  get generatorCount() { return this._generatorCount }
  set generatorCount(count) {
    this._generatorCount = count
    if (this._generators.length < count) {
      for (let i=this._generators.length; i<count; i++) {
        this._generators.push(new WaveGenerator(this.rom, i))
      }
    }
  }
  
  _getWaveGenerator(notenumber) {
    const samenote = this._findWaveGenerator(notenumber)
    if (samenote) return samenote
    return this._generators.reduce((wg, min) => (wg._priority() < min._priority()) ? wg : min)
  }

  _findWaveGenerator(notenumber) {
    return this._generators.find(wg => wg.notenumber === notenumber)
  }

  
  onMessage(event) {
    const name = event.data.name
    if (name in this.events) {
      this.events[name](event.data.data)
    }
  }


  process(inputs, outputs, parameters) {
    const sendlevels = [parameters.dry[0], parameters.effect1[0], parameters.effect2[0], parameters.effect3[0]]
    const src = outputs[0]
    const sampleCount = src[0].length

    // generate sound
    for (let i=0; i<this._generatorCount; i++) {
      this._generators[i].generate(src, parameters)
    }

    // stereo mixout
    for (let track=3; track>=0; track--) {
      const dst = outputs[track]
      const level = sendlevels[track]
      for (let i=0; i<sampleCount; i++) {
        dst[0][i] = src[0][i] * level
        dst[1][i] = src[1][i] * level
      }
    }

    return true
  }
}

registerProcessor('channel', Channel)