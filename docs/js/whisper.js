// このPCのAI（Whisper）で、流れてくる音声を少し遅れて文字にする
// ・選んだ音声の入力（画面共有の音声・マイク・ほかの機器）をそのまま聞く
// ・話の切れ目（静かになったところ）で区切って、AIに渡す。1つの区切りは 6〜25秒
// ・AIは別の働き手（whisper-worker.js）で動くので、画面は固まらない
// ・音声は外に送らない

export const MODELS = [
  { id: 'Xenova/whisper-tiny', label: 'とても小さい（tiny）', size: '約40MB', note: 'いちばん速い。日本語の精度は低め' },
  { id: 'Xenova/whisper-base', label: '小さい（base）', size: '約80MB', note: '速い。精度はそこそこ' },
  { id: 'Xenova/whisper-small', label: '中くらい（small）', size: '約250MB', note: '速さと精度のつりあいがよい（WebGPU が使えるPC向け）' },
  { id: 'onnx-community/whisper-large-v3-turbo', label: '大きい（large-v3-turbo）', size: '約600MB〜', note: 'いちばん高精度。速いPC向け' },
];
export const defaultModel = () => (navigator.gpu ? 'Xenova/whisper-small' : 'Xenova/whisper-base');

const RATE = 16000;
const MIN_SEG = 6, MAX_SEG = 25, FRAME = RATE / 10;   // 区切りの長さ（秒）と、音の大きさを測る単位（0.1秒）
// 無音のときに Whisper が書きがちな決まり文句。これだけの行は捨てる
const NOISE = /^[\s、。.!！?？…「」]*(ご視聴ありがとうございました|ご清聴ありがとうございました|ありがとうございました|チャンネル登録.*|字幕.*|おやすみなさい|はい|うん)[\s、。.!！?？…」]*$/;

const WORKLET = `class Grab extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0]; if (!ch || !ch.length) return true;
    const len = ch[0].length;
    for (let i = 0; i < len; i++) { let v = 0; for (let c = 0; c < ch.length; c++) v += ch[c][i]; this.buf[this.n++] = v / ch.length;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }
    return true;
  }
}
registerProcessor('kougi-grab', Grab);`;

export class WhisperLive {
  // onText(text, at)：文字ができたとき。onState({ phase, text })：準備や遅れの様子
  constructor({ onText, onState }) {
    this.onText = onText; this.onState = onState;
    this.worker = null; this.model = ''; this.ready = null; this.device = '';
    this.queue = []; this.busy = false; this.seq = 0; this.lastText = '';
    this.ctx = null; this.listening = false;
  }

  // AIを準備する（初回はダウンロード）。同じAIなら2回目からはすぐ終わる
  prepare(model) {
    if (this.ready && this.model === model) return this.ready;
    if (this.worker) this.worker.terminate();
    this.model = model;
    this.worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data: m }) => {
        if (m.type === 'progress') this.onState({ phase: 'loading', text: `AIのデータを準備しています… ${(m.loaded / 1048576).toFixed(0)} / ${(m.total / 1048576).toFixed(0)}MB` });
        else if (m.type === 'ready') { this.device = m.device; this.worker.onmessage = (e) => this.onWorker(e.data); resolve(m.device); this.pump(); this.report(); }
        else if (m.type === 'error') { this.ready = null; reject(new Error(m.message)); }
      };
      this.worker.onerror = (e) => { this.ready = null; reject(new Error(e.message || 'AIを準備できませんでした')); };
    });
    this.onState({ phase: 'loading', text: 'AIを準備しています…' });
    this.worker.postMessage({ type: 'load', model });
    return this.ready;
  }

  async start(stream, model) {
    this.stopListening();
    const track = stream && stream.getAudioTracks()[0];
    if (!track) throw new Error('音声の入力がありません');
    this.prepare(model).catch((e) => this.onState({ phase: 'error', text: 'AIを準備できませんでした：' + e.message }));
    const ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(ctx, 'kougi-grab');
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);   // 音は出さずに、処理だけ回す
    node.port.onmessage = (e) => this.feed(e.data);
    Object.assign(this, { ctx, src, node, ratio: ctx.sampleRate / RATE, pos: 0, parts: [], n: 0, segAt: 0, frames: [], acc: 0, accN: 0, listening: true });
  }

  // 入ってきた音声を 16kHz にして、ためる
  feed(f32) {
    if (!this.listening) return;
    const out = new Float32Array(Math.floor((f32.length - this.pos) / this.ratio) + 1);
    let k = 0;
    for (; this.pos < f32.length; this.pos += this.ratio) {
      const a = Math.floor(this.pos), b = Math.min(f32.length, Math.floor(this.pos + this.ratio));
      let v = 0; for (let i = a; i < Math.max(b, a + 1); i++) v += f32[i]; v /= Math.max(1, b - a);
      out[k++] = v;
      this.acc += v * v; if (++this.accN === FRAME) { this.frames.push(Math.sqrt(this.acc / FRAME)); this.acc = 0; this.accN = 0; }
    }
    this.pos -= f32.length;
    if (!this.n) this.segAt = Date.now() - (k / RATE) * 1000;
    this.parts.push(out.subarray(0, k)); this.n += k;
    const sec = this.n / RATE;
    if (sec >= MAX_SEG || (sec >= MIN_SEG && this.quietNow())) this.cut();
  }

  // 直前 0.5秒が、この区切りの平均よりずっと静かなら、話の切れ目とみなす
  quietNow() {
    const f = this.frames; if (f.length < 10) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    const tail = f.slice(-5); return Math.max(...tail) < Math.max(0.004, avg * 0.3);
  }

  cut() {
    if (!this.n) return;
    const audio = new Float32Array(this.n); let o = 0;
    for (const p of this.parts) { audio.set(p, o); o += p.length; }
    const loud = this.frames.length ? Math.max(...this.frames) : 0;
    const seg = { id: ++this.seq, at: this.segAt, sec: this.n / RATE, audio };
    this.parts = []; this.n = 0; this.frames = [];
    if (loud < 0.006) return;   // ほとんど無音：AIに渡さない（決まり文句を書いてしまうため）
    this.queue.push(seg); this.pump();
  }

  pump() {
    if (this.busy || !this.queue.length || !this.worker || !this.device) return;
    const seg = this.queue.shift(); this.busy = seg;
    this.worker.postMessage({ type: 'run', id: seg.id, audio: seg.audio }, [seg.audio.buffer]);
    this.report();
  }

  onWorker(m) {
    const seg = this.busy; this.busy = false;
    if (m.type === 'text' && seg) {
      for (const c of m.chunks) {
        const t = c.text.trim();
        if (!t || NOISE.test(t) || t === this.lastText) continue;
        this.lastText = t;
        this.onText(t, Math.round(seg.at + c.t * 1000));
      }
    } else if (m.type === 'error') this.onState({ phase: 'error', text: '文字にできない部分がありました：' + m.message });
    this.pump(); this.report();
  }

  // どのくらい遅れているか（まだ文字になっていない音声の秒数）
  lag() { return this.queue.reduce((a, s) => a + s.sec, 0) + (this.busy ? this.busy.sec : 0) + this.n / RATE; }
  pending() { return this.queue.length + (this.busy ? 1 : 0); }
  report() {
    if (!this.device) return;
    const p = this.pending();
    this.onState({ phase: this.listening ? 'on' : p ? 'finishing' : 'idle', lag: Math.round(this.lag()), pending: p, device: this.device });
  }

  stopListening() {
    if (!this.listening) return;
    this.listening = false;
    try { this.src.disconnect(); this.node.disconnect(); this.ctx.close(); } catch { /* 閉じている */ }
    this.ctx = null;
  }
  // 聞くのをやめる。ためた分と、待っている分は最後まで文字にする
  stop() { if (this.listening && this.n / RATE >= 1) this.cut(); this.parts = []; this.n = 0; this.frames = []; this.stopListening(); this.report(); }
}
