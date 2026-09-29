class Ticker extends AudioWorkletProcessor {
  constructor(option) {
    super(option)
    this.enableEventCallback = false
    this.currentDeltaTime = 0
    this.nextEventDeltaTime = 0
    this.updateBeatsPerMinute(120)
    this.port.onmessage = e => this.onMessage(e)
  }

  updateBeatsPerMinute(bpm) {
    this.tickPerSample = 480 / ((60 / Number(bpm)) * sampleRate)
  }

  onMessage(event) {
    const name = event.data.name
    const data = event.data.data
    switch(name) {
      case "start":
        this.enableEventCallback = true
        this.currentDeltaTime = 0
        this.nextEventDeltaTime = 0
        this.updateBeatsPerMinute(data.bpm)
        break
      case "stop":
        this.enableEventCallback = false
        break;
      case "beatsPerMinute":
        this.updateBeatsPerMinute(data.bpm)
        break
      case "nextEventCallback":
        this.enableEventCallback = true
        this.nextEventDeltaTime = data.deltaTime
        break
      default:
        break
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0]
    const sampleCount = output[0].length
    const dTick = sampleCount * this.tickPerSample

    // event callback
    if (this.enableEventCallback) {
      this.enableEventCallback = false
      if (this.nextEventDeltaTime <= this.currentDeltaTime + dTick) {
        const data = {
          deltaTime: this.nextEventDeltaTime, 
          realDeltaTime: this.currentDeltaTime,
          deltaTimePerFrame: dTick
        }
        this.port.postMessage({ name: "eventCallback", data })
      }
      this.currentDeltaTime += dTick
    }

    return true;
  }
}


registerProcessor('ticker', Ticker);