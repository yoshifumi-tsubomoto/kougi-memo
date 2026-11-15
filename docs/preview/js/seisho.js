// 清書：セッションのあとで、録音をもう一度、ていねいに文字にする
//   openai  … OpenAI の文字起こし（自分のAPIキー）。音声を OpenAI に送る
//   gemini  … Google の Gemini（自分のAPIキー・有料の枠で）。音声を Google に送る
// できた行は { at, text, audioId } の形で返す。at は講義の時刻（ミリ秒）
import { parseTranscript } from './transcript.js';

export const OPENAI_MODELS = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'];
export const GEMINI_DEFAULT = 'gemini-2.5-flash';

// 同じ言葉が何回も続いたら、2回までに縮める（「なんか、なんか、なんか、…」）。ほとんどがくり返しなら、その行は捨てる
function squash(t) {
  const out = t.replace(/(.{1,15}?)\1{2,}/gu, '$1$1');
  return out.length < t.length * 0.4 && t.length > 40 ? '' : out;
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
