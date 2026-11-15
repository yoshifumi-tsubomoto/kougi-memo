// 清書：セッションのあとで、録音をもう一度、ていねいに文字にする
//   browser … このPCのAI（Whisper）。音声は外に送らない
//   openai  … OpenAI の文字起こし（自分のAPIキー）。音声を OpenAI に送る
//   gemini  … Google の Gemini（自分のAPIキー）。音声を Google に送る
// できた行は { at, text, audioId } の形で返す。at は講義の時刻（ミリ秒）
import { parseTranscript } from './transcript.js';
import { squash } from './whisper.js';

const RATE = 16000;
const PIECE = 120;   // このPCのAIに一度に渡す長さ（秒）。この前後の静かなところで区切る

export const OPENAI_MODELS = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'];
export const GEMINI_DEFAULT = 'gemini-2.5-flash';

/* ---------- 音声を 16kHz・1チャンネルにする ---------- */
async function decode(blob) {
  const ctx = new AudioContext({ sampleRate: RATE });
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels; }
    return out;
  } finally { ctx.close(); }
}

// 長い音声を、PIECE 秒前後の、いちばん静かなところで区切る
function split(audio) {
  const out = []; let start = 0;
  while (start < audio.length) {
    let end = Math.min(audio.length, start + PIECE * RATE);
    if (end < audio.length) {
      const from = end - 4 * RATE, step = RATE / 10; let best = end, low = Infinity;
      for (let p = from; p + step < end + 4 * RATE && p + step < audio.length; p += step) {
        let e = 0; for (let i = p; i < p + step; i++) e += audio[i] * audio[i];
        if (e < low) { low = e; best = p + step / 2; }
      }
      end = Math.round(best);
    }
    out.push({ off: start / RATE, audio: audio.subarray(start, end) });
    start = end;
  }
  return out;
}

/* ---------- このPCのAI ---------- */
function browserEngine(model, onState) {
  let worker = null, ready = null, seq = 0;
  const waiting = new Map();
  const start = () => {
    worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    ready = new Promise((resolve, reject) => {
      worker.onmessage = ({ data: m }) => {
        if (m.type === 'progress') onState(`AIのデータを準備しています… ${(m.loaded / 1048576).toFixed(0)} / ${(m.total / 1048576).toFixed(0)}MB`);
        else if (m.type === 'ready') resolve(m.device);
        else if (m.type === 'error' && !m.id) reject(new Error(m.message));
        else if (waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.type === 'text' ? w.resolve(m.chunks) : w.reject(new Error(m.message)); }
      };
      worker.onerror = (e) => reject(new Error(e.message || 'AIを準備できませんでした'));
    });
    worker.postMessage({ type: 'load', model });
    return ready;
  };
  return {
    async ready() { return ready || start(); },
    async run(audio) {
      await this.ready();
      const id = ++seq; const copy = audio.slice();
      return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ type: 'run', id, tries: 1, audio: copy }, [copy.buffer]); });
    },
    close() { if (worker) worker.terminate(); worker = null; },
  };
}

/* ---------- OpenAI ---------- */
async function openaiChunk(blob, { key, model }) {
  const fd = new FormData();
  const ext = /ogg/.test(blob.type) ? 'ogg' : /mp4/.test(blob.type) ? 'm4a' : 'webm';
  fd.append('file', new File([blob], `audio.${ext}`, { type: blob.type || 'audio/webm' }));
  fd.append('model', model);
  fd.append('language', 'ja');
  fd.append('response_format', model === 'whisper-1' ? 'verbose_json' : 'json');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
  if (!res.ok) throw new Error(`OpenAI：${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (Array.isArray(j.segments) && j.segments.length) return j.segments.map((s) => ({ t: s.start || 0, text: String(s.text || '').trim() }));
  return { text: j.text || '' };
}

/* ---------- Gemini ---------- */
const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
async function geminiChunk(blob, { key, model }) {
  const prompt = 'この日本語の音声を、聞こえたとおりに文字起こししてください。要約や言い換えはしないでください。'
    + '話の区切りごとに改行し、各行の先頭に、音声の始まりからの時刻を [mm:ss] の形で付けてください。文字起こし以外は何も書かないでください。';
  const body = { contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: (blob.type || 'audio/webm').split(';')[0], data: b64(await blob.arrayBuffer()) } }] }] };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini：${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = ((j.candidates || [])[0]?.content?.parts || []).map((p) => p.text || '').join('\n');
  const { items, timed } = parseTranscript(text);
  return timed ? items.map((it) => ({ t: it.sec, text: it.text })) : { text };
}

// 時刻のない文章は、文の切れ目で分けて、区切りの長さに等しく並べる
function spread(text, sec) {
  const parts = String(text).split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length, 0) || 1; let pos = 0;
  return parts.map((p) => { const t = (pos / total) * sec; pos += p.length; return { t, text: p }; });
}

/**
 * chunks：[{ id, startAt, endAt, blob() }] 録音の区切り（古い順）
 * opts：{ engine, model, key, onState(text), signal }
 */
export async function seisho(chunks, opts) {
  const { engine, onState, signal } = opts;
  const rows = [];
  const add = (a, list) => { for (const c of list) { const t = squash(String(c.text || '').trim()); if (t) rows.push({ at: Math.round(a.startAt + c.t * 1000), text: t, audioId: a.id }); } };
  const stop = () => { if (signal && signal.aborted) throw new DOMException('やめました', 'AbortError'); };

  if (engine === 'browser') {
    const ai = browserEngine(opts.model, onState);
    try {
      onState('AIを準備しています…');
      const device = await ai.ready();
      // 先に全部の長さを数えて、進み具合を出す
      const plan = [];
      for (const a of chunks) { stop(); onState('録音を読み込んでいます…'); plan.push({ a, pieces: split(await decode(await a.blob())) }); }
      const total = plan.reduce((n, p) => n + p.pieces.reduce((m, x) => m + x.audio.length, 0), 0) / RATE;
      let done = 0; const t0 = performance.now();
      for (const { a, pieces } of plan) {
        for (const p of pieces) {
          stop();
          const pct = Math.round((done / total) * 100), el = (performance.now() - t0) / 1000;
          const left = done > 0 ? Math.round((el / done) * (total - done) / 60) : null;
          onState(`清書しています… ${pct}%${left !== null ? `（あと約${Math.max(1, left)}分）` : `（録音 ${Math.round(total / 60)}分ぶん。最初の区切りが終わると、残り時間が出ます）`}・${device === 'webgpu' ? 'WebGPU' : 'ふつうの計算'}`);
          const out = await ai.run(p.audio);
          add(a, out.map((c) => ({ t: p.off + c.t, text: c.text })));
          done += p.audio.length / RATE;
        }
      }
    } finally { ai.close(); }
    return rows;
  }

  // OpenAI・Gemini：録音の区切り（約10分）ごとに送る
  if (!opts.key) throw new Error('APIキーが入っていません。⚙ 設定で入れてください');
  let i = 0;
  for (const a of chunks) {
    stop();
    onState(`${engine === 'openai' ? 'OpenAI' : 'Gemini'}で清書しています… ${++i} / ${chunks.length}`);
    const blob = await a.blob();
    const sec = Math.max(1, ((a.endAt || a.startAt) - a.startAt) / 1000);
    const r = engine === 'openai' ? await openaiChunk(blob, opts) : await geminiChunk(blob, opts);
    add(a, Array.isArray(r) ? r : spread(r.text, sec));
  }
  return rows;
}
