/**
 * 録音中のマイク入力をリアルタイム表示（Canvas）
 */

export class LiveMicWaveform {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {MediaStream} stream
   */
  constructor(canvas, stream) {
    this.canvas = canvas;
    this.stream = stream;
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.rafId = 0;
    this.data = new Uint8Array(2048);
    this._resize();
    window.addEventListener("resize", this._onResize);
    this._start();
  }

  _onResize = () => this._resize();

  _resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(200, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(48, Math.floor(rect.height * dpr));
  }

  _start() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error("Web Audio API に対応していません。");
    this.ctx = new AC();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.35;
    this.data = new Uint8Array(this.analyser.fftSize);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);
    void this.ctx.resume();
    this._draw();
  }

  _draw = () => {
    if (!this.analyser || !this.canvas) return;
    this.analyser.getByteTimeDomainData(this.data);
    const g = this.canvas.getContext("2d");
    if (!g) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    g.fillStyle = "rgba(8, 12, 10, 0.95)";
    g.fillRect(0, 0, w, h);
    g.lineWidth = Math.max(1, Math.floor(w / 512));
    g.strokeStyle = "rgba(120, 255, 200, 0.92)";
    g.beginPath();
    const slice = w / this.data.length;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      const y = (0.5 - v * 0.42) * h;
      const x = i * slice;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = "rgba(255, 255, 255, 0.35)";
    g.fillRect(0, h / 2 - 1, w, 2);
    this.rafId = requestAnimationFrame(this._draw);
  };

  getAnalyser() {
    return this.analyser;
  }

  destroy() {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this._onResize);
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.analyser?.disconnect();
    } catch {
      /* ignore */
    }
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    if (this.canvas) {
      const g = this.canvas.getContext("2d");
      g?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
