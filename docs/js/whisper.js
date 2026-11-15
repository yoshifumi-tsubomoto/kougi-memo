// このPCのAI（Whisper）で、流れてくる音声を少し遅れて文字にする
// ・選んだ音声の入力（画面共有の音声・マイク・ほかの機器）をそのまま聞く
// ・話の切れ目（静かになったところ）で区切って、AIに渡す。1つの区切りは 10〜28秒（長いほど前後のつながりで正確になる）
// ・AIは別の働き手（whisper-worker.js）で動くので、画面は固まらない
// ・音声は外に送らない

export const MODELS = [
  { id: 'Xenova/whisper-tiny', label: 'とても小さい（tiny）', size: '約40MB', note: 'いちばん速い。日本語の精度は低め' },
  { id: 'Xenova/whisper-base', label: '小さい（base）', size: '約80MB', note: '速い。精度はそこそこ' },
  { id: 'Xenova/whisper-small', label: '中くらい（small）', size: '約250MB', note: '速さと精度のつりあいがよい（WebGPU が使えるPC向け）' },
  { id: 'onnx-community/whisper-large-v3-turbo', label: '大きい（large-v3-turbo）', size: '約0.6〜1.4GB', note: 'いちばん高精度。WebGPU が使える速いPC向け。初回のダウンロードに時間がかかります' },
];
export const defaultModel = () => (navigator.gpu ? 'Xenova/whisper-small' : 'Xenova/whisper-base');

const RATE = 16000;
const MIN_SEG = 10, MAX_SEG = 28, FRAME = RATE / 10;   // 区切りの長さ（秒）と、音の大きさを測る単位（0.1秒）
// 無音のときに Whisper が書きがちな決まり文句。これだけの行は捨てる
const NOISE = /^[\s、。.!！?？…「」]*(ご(視聴|清聴)ありがとうございま(した|す)|ありがとうございま(した|す)|最後までご(覧|視聴)いただきありがとうございま(した|す)|チャンネル登録.*|字幕.*|おやすみなさい|はい|うん)[\s、。.!！?？…」]*$/;

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

// 同じ言葉が何回も続いたら、2回までに縮める（「なんか、なんか、なんか、…」）。ほとんどがくり返しなら、その行は捨てる
export function squash(t) {
  const out = t.replace(/(.{1,15}?)\1{2,}/gu, '$1$1');
  return out.length < t.length * 0.4 && t.length > 40 ? '' : out;
}

export class WhisperLive {
  // onText(text, at)：文字ができたとき。onState({ phase, text, lag, pending, device, problem })：準備や遅れの様子
  constructor({ onText, onState }) {
    this.onText = onText; this.onState = onState;
    this.worker = null; this.model = ''; this.ready = null; this.device = ''; this.forceWasm = false;
    this.queue = []; this.busy = null; this.seq = 0; this.lastText = '';
    this.ctx = null; this.listening = false; this.fails = 0; this.problem = ''; this.lastFeed = 0; this.watch = 0;
  }

  // AIを準備する（初回はダウンロード）。同じAIなら2回目からはすぐ終わる
  prepare(model) {
    if (this.ready && this.model === model) return this.ready;
    this.kill();
    this.model = model;
    const w = this.worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      w.onmessage = ({ data: m }) => {
        if (m.type === 'progress') this.onState({ phase: 'loading', text: `AIのデータを準備しています… ${(m.loaded / 1048576).toFixed(0)} / ${(m.total / 1048576).toFixed(0)}MB` });
        else if (m.type === 'ready') { this.device = m.device; w.onmessage = (e) => this.onWorker(e.data); resolve(m.device); this.pump(); this.report(); }
        else if (m.type === 'error') { this.ready = null; reject(new Error(m.message)); }
      };
      w.onerror = (e) => { if (!this.device) { this.ready = null; reject(new Error(e.message || 'AIを準備できませんでした')); } else this.restart('AIが止まりました：' + (e.message || '')); };
    });
    this.onState({ phase: 'loading', text: 'AIを準備しています…' });
    w.postMessage({ type: 'load', model, device: this.forceWasm ? 'wasm' : '' });
    return this.ready;
  }
  kill() { if (this.worker) this.worker.terminate(); this.worker = null; this.ready = null; this.device = ''; clearTimeout(this.watch); }

  // AIが動かなくなったら、立ち上げ直す。WebGPU で何度も失敗するときは、ふつうの計算に切り替える
  restart(why) {
    this.fails++;
    this.problem = why;
    if (this.busy) { this.queue.unshift(this.busy); this.busy = null; }
    if (this.device === 'webgpu' && this.fails >= 2) this.forceWasm = true;
    const model = this.model; this.kill();
    this.prepare(model).catch((e) => { this.problem = 'AIを立ち上げ直せませんでした：' + e.message; this.report(); });
    this.report();
  }

  // alive：入力が切れていないかを見る元の音（大きさを変えた音は、元が切れても切れたことにならないため）
  async start(stream, model, alive) {
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
    Object.assign(this, { ctx, src, node, track: alive || track, ratio: ctx.sampleRate / RATE, pos: 0, parts: [], n: 0, segAt: 0, frames: [], acc: 0, accN: 0, listening: true, lastFeed: Date.now() });
    // 音の処理が止められていないかを見張る（ブラウザが止めることがある）
    clearInterval(this.guard);
    this.guard = setInterval(() => {
      if (!this.listening) return;
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      const quiet = Date.now() - this.lastFeed > 10000;
      const p = track.readyState !== 'live' ? '音声の入力が切れました。画面の共有をやめていないか確かめてください' : quiet ? '音声が届いていません' : '';
      if (p) { if (this.problem !== p) { this.problem = p; this.report(); } }
      else if (this.problem.startsWith('音声')) { this.problem = ''; this.report(); }
    }, 3000);
    this.report();
  }

  // 入ってきた音声を 16kHz にして、ためる
  feed(f32) {
    if (!this.listening) return;
    this.lastFeed = Date.now();
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
    const seg = { id: ++this.seq, at: this.segAt, sec: this.n / RATE, audio, tries: 0 };
    this.parts = []; this.n = 0; this.frames = [];
    if (loud < 0.004) { this.skipped = (this.skipped || 0) + 1; return; }   // ほとんど無音：AIに渡さない（決まり文句を書いてしまうため）
    this.queue.push(seg); this.pump(); this.report();
  }

  pump() {
    if (this.busy || !this.queue.length || !this.worker || !this.device) return;
    const seg = this.queue.shift(); this.busy = seg; seg.tries++; this.busyAt = Date.now();
    const copy = seg.audio.slice();   // 失敗したときにやり直せるよう、元は手元に残す
    this.worker.postMessage({ type: 'run', id: seg.id, tries: seg.tries, audio: copy }, [copy.buffer]);
    // 長くかかりすぎたら、AIが止まったとみなして立ち上げ直す
    clearTimeout(this.watch);
    this.watch = setTimeout(() => { if (this.busy === seg) this.restart('AIの返事がないので、立ち上げ直しました'); }, Math.max(90000, seg.sec * 10000));
    this.report();
  }

  onWorker(m) {
    const seg = this.busy;
    if (!seg || m.id !== seg.id) return;
    clearTimeout(this.watch); this.busy = null;
    if (m.type === 'text') {
      this.fails = 0; this.done = (this.done || 0) + 1; if (!this.problem.startsWith('音声')) this.problem = '';
      for (const c of m.chunks) {
        const t = squash(c.text.trim());
        if (!t || NOISE.test(t) || t === this.lastText) continue;
        this.lastText = t;
        this.onText(t, Math.round(seg.at + c.t * 1000)); this.lastTextAt = Date.now();
      }
      this.pump(); this.report();
    } else if (m.type === 'error') {
      if (seg.tries < 2) this.queue.unshift(seg);   // 1回だけやり直す
      this.lastError = m.message;
      this.restart('文字にできませんでした：' + m.message);
    }
  }

  // 調べるための、いまの様子（音声や文字の中身は含めない）
  status() {
    const now = Date.now(), sec = (t) => (t ? Math.round((now - t) / 1000) + '秒前' : 'なし');
    return {
      AI: this.model, 計算: this.device || '準備中か失敗', ふつうの計算に切替: this.forceWasm,
      聞いている: this.listening, 音の処理: this.ctx ? this.ctx.state : 'なし',
      入力: this.track ? `${this.track.label || '(名前なし)'}・${this.track.readyState}` : 'なし',
      最後に音が届いた: sec(this.lastFeed), ためている秒数: Math.round(this.n / RATE),
      待っている区切り: this.queue.length, AIが処理中: this.busy ? `${Math.round(this.busy.sec)}秒の区切り（${sec(this.busyAt)}に渡した）` : 'なし',
      文字にできた区切り: this.done || 0, 捨てた無音の区切り: this.skipped || 0, 続けて失敗: this.fails, 最後の問題: this.problem || this.lastError || 'なし',
      最後に文字ができた: sec(this.lastTextAt),
    };
  }

  // どのくらい遅れているか（まだ文字になっていない音声の秒数）
  lag() { return this.queue.reduce((a, s) => a + s.sec, 0) + (this.busy ? this.busy.sec : 0) + this.n / RATE; }
  pending() { return this.queue.length + (this.busy ? 1 : 0); }
  report() {
    if (!this.device && !this.problem) return;
    const p = this.pending();
    this.onState({ phase: this.listening ? 'on' : p ? 'finishing' : 'idle', lag: Math.round(this.lag()), pending: p, device: this.device, problem: this.problem });
  }

  stopListening() {
    clearInterval(this.guard);
    if (!this.listening) return;
    this.listening = false;
    try { this.src.disconnect(); this.node.disconnect(); this.ctx.close(); } catch { /* 閉じている */ }
    this.ctx = null;
  }
  // 聞くのをやめる。ためた分と、待っている分は最後まで文字にする
  stop() { if (this.listening && this.n / RATE >= 1) this.cut(); this.parts = []; this.n = 0; this.frames = []; this.stopListening(); if (this.problem.startsWith('音声')) this.problem = ''; this.report(); }
}
