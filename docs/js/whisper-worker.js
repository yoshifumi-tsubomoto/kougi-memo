// 文字起こしAI（Whisper）を、画面とは別の働き手（Web Worker）で動かす
// 画面が固まらないように、重い計算はここで行う。音声は外に送らない。
// 初回だけ、AIのデータを Hugging Face からダウンロードし、ブラウザにしまう。
const TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
let asr = null;

async function load(model) {
  if (model === 'fake') {   // 自動テスト用：AIを使わず、音声の長さを返す
    asr = async (audio) => { const s = Math.round(audio.length / 16000); return { chunks: [{ timestamp: [0, s], text: `（試験）${s}秒の音声` }] }; };
    return { device: 'fake' };
  }
  const T = await import(TF_URL);
  let gpu = false;
  try { gpu = !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter()); } catch { /* 使えない */ }
  const device = gpu ? 'webgpu' : 'wasm';
  const dtype = gpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';
  const files = {};
  asr = await T.pipeline('automatic-speech-recognition', model, {
    device, dtype,
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files[p.file] = [p.loaded, p.total];
      const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      self.postMessage({ type: 'progress', loaded: l, total: t });
    },
  });
  return { device };
}

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'load') {
      const r = await load(m.model);
      self.postMessage({ type: 'ready', ...r });
    } else if (m.type === 'run') {
      const t0 = performance.now();
      const r = await asr(m.audio, { language: 'japanese', task: 'transcribe', return_timestamps: true, chunk_length_s: 30 });
      const chunks = (r.chunks || [{ timestamp: [0], text: r.text }]).map((c) => ({ t: (c.timestamp && c.timestamp[0]) || 0, text: String(c.text || '').trim() }));
      self.postMessage({ type: 'text', id: m.id, chunks, ms: performance.now() - t0 });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: String((e && e.message) || e) });
  }
};
