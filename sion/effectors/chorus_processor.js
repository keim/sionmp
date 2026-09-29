// code written by Claude
class ChorusProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.bufferL = new Float32Array(48000); // 1秒分のバッファ（左チャンネル）
      this.bufferR = new Float32Array(48000); // 1秒分のバッファ（右チャンネル）
      this.writeIndex = 0;
      this.phase = 0;
    }
  
    static get parameterDescriptors() {
      return [
        {name: 'freq', defaultValue: 0.5, minValue: 0.1, maxValue: 10},
        {name: 'depth', defaultValue: 0.3, minValue: 0, maxValue: 1},
        {name: 'delay', defaultValue: 30, minValue: 10, maxValue: 100},
        {name: 'feedback', defaultValue: 0.2, minValue: 0, maxValue: 0.9}
      ];
    }
  
    process(inputs, outputs, parameters) {
      const input = inputs[0];
      const output = outputs[0];
      const bufferLength = input[0].length;
  
      const freq = parameters.freq[0];
      const depth = parameters.depth[0];
      const delay = parameters.delay[0] * sampleRate / 1000;
      const feedback = parameters.feedback[0];
  
      for (let i = 0; i < bufferLength; i++) {
        // 入力信号をバッファに書き込む
        this.bufferL[this.writeIndex] = input[0][i];
        this.bufferR[this.writeIndex] = input[1][i];
  
        // LFOの計算（三角波）
        this.phase += freq / sampleRate;
        if (this.phase > 1) this.phase -= 1;
        const lfo = 1 - Math.abs(this.phase * 2 - 1);
  
        // ディレイ時間の計算
        const delayTime = delay + depth * lfo * delay;
  
        // 読み取りインデックスの計算
        let readIndex = this.writeIndex - delayTime;
        if (readIndex < 0) readIndex += this.bufferL.length;
  
        // 補間
        const fraction = readIndex - Math.floor(readIndex);
        const readIndexA = Math.floor(readIndex);
        const readIndexB = (readIndexA + 1) % this.bufferL.length;
  
        const sampleL = this.bufferL[readIndexA] * (1 - fraction) + this.bufferL[readIndexB] * fraction;
        const sampleR = this.bufferR[readIndexA] * (1 - fraction) + this.bufferR[readIndexB] * fraction;
  
        // 出力の計算
        output[0][i] = input[0][i] + sampleL;
        output[1][i] = input[1][i] + sampleR;
  
        // フィードバック
        this.bufferL[this.writeIndex] += sampleL * feedback;
        this.bufferR[this.writeIndex] += sampleR * feedback;
  
        // 書き込みインデックスの更新
        this.writeIndex = (this.writeIndex + 1) % this.bufferL.length;
      }
  
      return true;
    }
  }
  
  registerProcessor('chorus-processor', ChorusProcessor);