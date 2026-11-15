// 清書（ブラウザの中の Whisper）の速さを試すページ
// 文字起こしAIは Transformers.js（Hugging Face）で動かす。音声は外に送らない。
// 初回だけ、AIのデータを Hugging Face からダウンロードし、ブラウザにしまう。
import * as store from './store.js';

const TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
const MODELS = [
  { id: 'Xenova/whisper-tiny', label: 'とても小さい（tiny）', size: '約40MB', note: 'いちばん速い。日本語の精度は低め' },
  { id: 'Xenova/whisper-base', label: '小さい（base）', size: '約80MB', note: '速い。精度はそこそこ' },
  { id: 'Xenova/whisper-small', label: '中くらい（small）', size: '約250MB', note: '速さと精度のつりあいがよい（おすすめ）', def: true },
  { id: 'onnx-community/whisper-large-v3-turbo', label: '大きい（large-v3-turbo）', size: '約0.6〜1.4GB', note: 'いちばん高精度。WebGPU が使えるPC向け' },
];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const mmss = (sec) => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}時間${pad(m)}分` : `${m}分${pad(s)}秒`; };
const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const log = (t) => { const el = $('#log'); el.textContent += t + '\n'; el.scrollTop = el.scrollHeight; };
let source = null;   // { name, getBlob }
let lastText = '';

/* ---------- 試す音声：講義メモの録音から選ぶ ---------- */
async function listChunks() {
  const box = $('#chunks');
  try {
    const lecs = await store.listLectures();
    const rows = [];
    for (const l of lecs) {
      const d = await store.getLecture(l.id);
      const names = Object.fromEntries((d.lecture.sessions || []).map((s) => [s.id, s.name]));
      for (const a of d.audio) if (a.status !== 'deleted' && a.bytes > 0) rows.push({ l, a, sname: names[a.sessionId] || '' });
    }
    if (!rows.length) { box.innerHTML = '<p class="note">講義メモの録音がまだありません。下の「ほかの音声ファイルを選ぶ」で、手元の音声ファイルを選んでください。</p>'; return; }
    box.innerHTML = rows.map((r, i) => `<label class="opt"><input type="radio" name="chunk" value="${i}"><span>${esc(r.l.date)} ${esc(r.l.title || '無題の講義')}・${esc(r.sname)}<small>${hm(r.a.startAt)}〜${r.a.endAt ? hm(r.a.endAt) : ''}　${(r.a.bytes / 1024 / 1024).toFixed(1)}MB</small></span></label>`).join('');
    box.addEventListener('change', (e) => {
      const r = rows[+e.target.value]; if (!r) return;
      source = { name: `${r.l.title || '無題の講義'}・${r.sname} ${hm(r.a.startAt)}〜`, getBlob: () => store.getAudioBlob(r.a.id) };
      $('#picked').textContent = '選んだ音声：' + source.name;
    });
  } catch (e) { box.innerHTML = `<p class="note">録音を読み込めませんでした：${esc(e.message)}</p>`; }
}
$('#file').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  source = { name: f.name, getBlob: async () => f };
  document.querySelectorAll('input[name=chunk]').forEach((r) => (r.checked = false));
  $('#picked').textContent = '選んだ音声：' + f.name;
});

/* ---------- AIの大きさ ---------- */
const hasGPU = !!navigator.gpu;
$('#models').innerHTML = MODELS.map((m) => `<label class="opt"><input type="radio" name="model" value="${m.id}" ${m.def ? 'checked' : ''}><span><b>${m.label}</b>　${m.size}<small>${m.note}</small></span></label>`).join('');
$('#gpu').textContent = hasGPU
  ? 'このブラウザでは WebGPU（グラフィック機能を使った高速な計算）が使えます。速く清書できる見込みです。'
  : 'このブラウザでは WebGPU が使えないため、ふつうの計算（WASM）で清書します。時間がかかることがあります。';

/* ---------- 音声を 16kHz・1チャンネルの数値の列にする ---------- */
async function decode(blob, maxSec) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const n = maxSec ? Math.min(buf.length, Math.round(maxSec * 16000)) : buf.length;
    const out = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels; }
    return out;
  } finally { ctx.close(); }
}

/* ---------- 試す ---------- */
$('#run').addEventListener('click', async () => {
  if (!source) { $('#state').textContent = '先に STEP 1 で音声を選んでください'; return; }
  const model = MODELS.find((m) => m.id === document.querySelector('input[name=model]:checked').value);
  const maxSec = +$('#len').value;
  const btn = $('#run'); btn.disabled = true; $('#log').textContent = ''; $('#result').hidden = true; $('#bar').style.width = '0%';
  try {
    $('#state').textContent = '音声を読み込んでいます…';
    const audio = await decode(await source.getBlob(), maxSec);
    const audioSec = audio.length / 16000;
    log(`音声：${mmss(audioSec)}（${source.name}）`);

    $('#state').textContent = '文字起こしAIを準備しています…';
    const T = await import(TF_URL);
    const device = hasGPU ? 'webgpu' : 'wasm';
    let f16 = false; try { const ad = hasGPU && await navigator.gpu.requestAdapter(); f16 = !!ad && ad.features.has('shader-f16'); } catch { /* 使えない */ }
    const large = /large/.test(model.id);
    const dtype = hasGPU ? { encoder_model: large ? (f16 ? 'fp16' : 'q4') : 'fp32', decoder_model_merged: 'q4' } : 'q8';
    const t0 = performance.now();
    const files = {};
    const asr = await T.pipeline('automatic-speech-recognition', model.id, {
      device, dtype,
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          files[p.file] = [p.loaded, p.total];
          const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
          $('#bar').style.width = (l / t * 100).toFixed(1) + '%';
          $('#state').textContent = `AIのデータを準備しています… ${(l / 1024 / 1024).toFixed(0)} / ${(t / 1024 / 1024).toFixed(0)}MB`;
        }
      },
    });
    log(`AIの準備：${((performance.now() - t0) / 1000).toFixed(1)}秒（${model.label}・${device}）`);

    $('#state').textContent = '清書しています…（この間、ページを閉じないでください）';
    $('#bar').style.width = '100%';
    const t1 = performance.now();
    const r = await asr(audio, { language: 'japanese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
    const sec = (performance.now() - t1) / 1000;
    log(`清書：${sec.toFixed(1)}秒`);

    const chunks = r.chunks || [{ timestamp: [0], text: r.text }];
    lastText = chunks.map((c) => `[${mmss(c.timestamp[0] || 0)}] ${String(c.text).trim()}`).join('\n');
    const ratio = sec / audioSec;
    $('#rAudio').textContent = mmss(audioSec);
    $('#rTime').textContent = mmss(sec);
    $('#rSpeed').textContent = `${(ratio * 60).toFixed(0)}秒`;
    $('#r4h').textContent = mmss(ratio * 4 * 3600);
    $('#verdict').textContent =
      ratio < 0.25 ? '◎ このPCなら、4時間の講義も1時間以内に清書できます。'
        : ratio < 0.5 ? '○ 4時間の講義は2時間以内。講義のあとに、ほかの作業をしながら待てます。'
          : ratio < 1 ? '△ 講義と同じくらいの時間がかかります。一晩かけて清書する使い方になります。'
            : '× このPCでは時間がかかりすぎます。小さいAIにするか、③④（外部のサービス）を考えましょう。';
    $('#out').textContent = lastText;
    $('#result').hidden = false;
    $('#state').textContent = '終わりました';
    $('#copy').onclick = () => {
      const info = `講義メモ 清書の試験\nAI：${model.label}（${device}）\n音声：${mmss(audioSec)}\n清書：${mmss(sec)}（音声1分あたり ${(ratio * 60).toFixed(0)}秒、4時間なら ${mmss(ratio * 4 * 3600)}）\nブラウザ：${navigator.userAgent}\n\n${lastText}`;
      navigator.clipboard.writeText(info).then(() => ($('#state').textContent = 'コピーしました'), () => ($('#state').textContent = 'コピーできませんでした'));
    };
  } catch (e) {
    $('#state').textContent = 'うまくいきませんでした';
    log('エラー：' + (e && e.message || e));
    if (hasGPU) log('→ WebGPU で失敗することがあります。小さいAIで試すか、もう一度試してください。');
  } finally { btn.disabled = false; }
});

listChunks();
