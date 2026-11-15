// 講義メモ：画面とその動き
import * as store from './store.js';
import { resizeImage, exifTime } from './media.js';
import { startHost, randomLinkId, phoneUrl, qrSvg } from './link.js';
import { parseTranscript } from './transcript.js';
import { WhisperLive, MODELS as W_MODELS, defaultModel } from './whisper.js';
import { seisho, OPENAI_MODELS, GEMINI_DEFAULT } from './seisho.js';

export const APP_VERSION = '0.7.0 試験729ceb4';

/* ============================== 設定 ============================== */
const TEST = new URLSearchParams(location.search).has('test');   // 自動確認用：区切りを短くする
const CHUNK_MS = TEST ? 4000 : 10 * 60 * 1000;   // 録音を区切る長さ
const PART_MS = TEST ? 1000 : 60 * 1000;         // この間隔で録音をブラウザに書き込む
const TYPES = [
  { k: 'memo', label: 'メモ' }, { k: 'key', label: '要点' }, { k: 'q', label: '質問' },
  { k: 'todo', label: 'TODO' }, { k: 'quote', label: '引用' }];
const LOOKS = [
  { k: 'aurora', label: 'オーロラ', note: 'ミント×ラベンダー' },
  { k: 'peach', label: 'ピーチ', note: '桃×あんず' },
  { k: 'citrus', label: 'シトラス', note: 'レモン×ライム' },
];
const currentLook = () => document.documentElement.dataset.look || 'aurora';
function setLook(k) {
  if (!LOOKS.some((l) => l.k === k)) k = 'aurora';
  document.documentElement.dataset.look = k;
  try { localStorage.setItem('kougi-look', k); } catch { /* 保存できなくても見た目は変わる */ }
  sendInfo();   // つながっているスマホも同じデザインにする
}
const TAGS = { key: '要点', q: '質問', todo: 'TODO', quote: '引用', photo: '写真' };
const ENGINES = [
  { k: 'none', label: '① 清書しない（リアルタイムの速報だけ）', note: '設定はいりません', ready: true },
  { k: 'browser', label: '② このPCの中で清書する', note: '音声を外部に送りません。PCの性能によって時間がかかります。<a href="bench.html" target="_blank" rel="noopener">このPCでの速さを試す</a>', ready: true },
  { k: 'openai', label: '③ OpenAI で清書する', note: '自分のAPIキーが必要です（料金がかかります）。録音の音声を OpenAI に送ります', ready: true },
  { k: 'gemini', label: '④ Gemini で清書する', note: '自分のAPIキーが必要です（無料の枠があります）。録音の音声を Google に送ります', ready: true },
];

/* ============================== 状態と小道具 ============================== */
const S = { list: [], lec: null, transcript: [], memos: [], audio: [], type: 'memo', tab: 'vLive', urls: {} };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const hms = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dur = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`; };
const mb = (b) => (b / 1024 / 1024).toFixed(b > 100 * 1024 * 1024 ? 0 : 1) + 'MB';
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || '講義メモ';
let toastT;
function toast(m, ms = 2800) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
const errMsg = (e) => String((e && e.message) || e);
function ls(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch { return null; } }

const sessions = () => (S.lec && S.lec.sessions) || [];
const openSession = () => sessions().filter((s) => !s.end).pop() || null;
function sessionAt(at) { const ss = sessions(); for (let i = ss.length - 1; i >= 0; i--) if (ss[i].start <= at && (!ss[i].end || at <= ss[i].end)) return ss[i]; return null; }
const recording = () => Live.running || Rec.active;

/* 書き出しの状態
 * changedAt：記録が変わった時刻（メモ・写真・要約・セッション終了・講義の情報）
 * exportedAt：「フォルダに書き出し」か「バックアップ」をした時刻 */
function exportState(l) {
  if (!l || !l.changedAt) return 'empty';
  if (!l.exportedAt) return 'never';
  return l.changedAt > l.exportedAt ? 'changed' : 'done';
}
const unexported = (l) => ['never', 'changed'].includes(exportState(l));
const optLabel = (l) => `${unexported(l) ? '● ' : ''}${l.date}　${l.title || '無題の講義'}${unexported(l) ? '（未書き出し）' : ''}`;
async function markChanged() {
  if (!S.lec) return;
  S.lec = await store.updateLecture(S.lec.id, { changedAt: Date.now() });
  refreshOption();
}
async function markExported() {
  S.lec = await store.updateLecture(S.lec.id, { exportedAt: Date.now() });
  refreshOption(); $('#nudge').hidden = true;
  if (S.tab === 'vSum') renderSummary();
}
function refreshOption() {
  const o = [...$('#lecSel').options].find((x) => x.value === (S.lec && S.lec.id));
  if (o) o.textContent = optLabel(S.lec);
}

/* ============================== 講義 ============================== */
async function loadList(selectId) {
  S.list = await store.listLectures();
  $('#lecSel').innerHTML = '<option value="">講義を選ぶ…</option>' + S.list.map((l) =>
    `<option value="${esc(l.id)}">${esc(optLabel(l))}</option>`).join('');
  $('#lecSel').value = selectId || (S.lec ? S.lec.id : '');
}
async function openLecture(id) {
  if (recording()) { toast('記録中は講義を切り替えられません。先にセッションを終了してください'); $('#lecSel').value = S.lec ? S.lec.id : ''; return; }
  Object.values(S.urls).forEach((u) => URL.revokeObjectURL(u)); S.urls = {};
  $('#nudge').hidden = true;
  stopLink();
  if (!id) { S.lec = null; ls('lastLecture', null); render(); return; }
  const d = await store.getLecture(id);
  if (!d.lecture) { S.lec = null; render(); return; }
  Object.assign(S, { lec: d.lecture, transcript: d.transcript, memos: d.memos, audio: d.audio });
  ls('lastLecture', id);
  $('#lecSel').value = id;
  render(true);
}
async function newLecture() {
  if (recording()) { toast('記録中です。先にセッションを終了してください'); return; }
  const l = await store.createLecture();
  store.requestPersist();   // ブラウザに記録を消されにくくする
  await loadList(l.id);
  await openLecture(l.id);
  $('#fTitle').focus();
}
let metaT;
function saveMeta() {
  clearTimeout(metaT);
  metaT = setTimeout(async () => {
    const p = {}; document.querySelectorAll('#metaBox [data-f]').forEach((i) => (p[i.dataset.f] = i.value));
    S.lec = await store.updateLecture(S.lec.id, { ...p, changedAt: Date.now() });
    refreshOption();
  }, 500);
}
async function saveLecture(patch) {
  try { S.lec = await store.updateLecture(S.lec.id, patch); } catch (e) { toast('保存できませんでした：' + errMsg(e)); }
}

/* ============================== リアルタイム文字起こし ==============================
 * Chromeの音声認識は数十秒〜数分で自動的に止まるので、止まったらすぐ開き直す */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const Live = {
  running: false, rec: null, utterStart: 0, lastErr: '',
  start() {
    if (liveEngine() === 'whisper') { this.running = true; startWhisper(); return; }
    if (!SR) { setInd('Speech', 'warn', '音声認識 未対応（Chrome か Edge で開いてください）'); return; }
    this.running = true; this.open();
  },
  open() {
    const r = new SR();
    r.lang = 'ja-JP'; r.continuous = true; r.interimResults = true;
    r.onstart = () => { this.lastErr = ''; setInd('Speech', 'on', '音声認識 稼働中'); };
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], text = res[0].transcript.trim();
        if (!this.utterStart && text) this.utterStart = Date.now();
        if (res.isFinal) { if (text) this.push(text, this.utterStart || Date.now()); this.utterStart = 0; }
        else interim += text;
      }
      showInterim(interim);
    };
    r.onerror = (e) => {
      this.lastErr = e.error;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.running = false; setInd('Speech', 'warn', '音声認識 マイクが許可されていません'); }
      if (e.error === 'network') setInd('Speech', 'warn', '音声認識 ネットにつながりません（録音は続いています）');
    };
    r.onend = () => {
      showInterim('');
      if (!this.running) { if (!this.lastErr) setInd('Speech', '', '音声認識 停止'); return; }
      if (this.lastErr !== 'network') setInd('Speech', 'warn', '音声認識 再接続中…');
      setTimeout(() => { if (this.running) this.open(); }, this.lastErr === 'network' ? 3000 : 300);
    };
    this.rec = r;
    // 既定のマイク以外を選んでいるときは、その音声を音声認識にも渡す（対応しているブラウザだけ。対応していなければ既定のマイクを使う）
    const track = audioSourceId() && Rec.stream ? Rec.stream.getAudioTracks()[0] : null;
    try { if (track && track.readyState === 'live') r.start(track); else r.start(); }
    catch { try { r.start(); } catch { setTimeout(() => { if (this.running) this.open(); }, 1000); } }
  },
  stop() { this.running = false; this.lastErr = ''; if (WL) WL.stop(); try { this.rec && this.rec.stop(); } catch { /* 止まっている */ } },
  async push(text, at) {
    const s = sessionAt(at) || openSession();
    const row = await store.addTranscript(S.lec.id, { sessionId: s ? s.id : '', at, text });
    S.transcript.push(row);
    appendTLine(row);
  },
};

/* ============================== このPCのAI（Whisper）で文字起こし ==============================
 * 選んだ音声の入力（画面共有の音声など）をそのまま聞いて、少し遅れて文字にする。音声は外に送らない */
const liveEngine = () => ls('liveEngine') || 'web';
const whisperModel = () => ls('whisperModel') || defaultModel();
let WL = null;
function whisper() {
  if (!WL) WL = new WhisperLive({
    onText: (text, at) => Live.push(text, at),
    onState: (st) => {
      if (st.phase === 'loading') { setInd('Speech', 'warn', st.text); showInterim(st.text); return; }
      if (st.phase === 'error') { setInd('Speech', 'warn', st.text); toast(st.text, 6000); return; }
      const lag = st.lag > 3 ? `・遅れ ${st.lag}秒` : '';
      if (st.problem) { setInd('Speech', 'warn', `文字起こし（PCのAI）${st.problem}`); showInterim(`⚠ ${st.problem}${lag ? `（${st.lag}秒分が待っています）` : ''}`); return; }
      if (st.phase === 'on') setInd('Speech', 'on', `文字起こし（PCのAI）稼働中${lag}`);
      else if (st.phase === 'finishing') setInd('Speech', 'warn', `文字起こし（PCのAI）残りを文字にしています${lag}`);
      else setInd('Speech', '', '文字起こし（PCのAI）停止');
      showInterim(st.pending ? `🎧 AIが聞き取っています…${lag ? `（${st.lag}秒遅れ）` : ''}` : '');
    },
  });
  return WL;
}
async function startWhisper() {
  if (!Rec.stream) { setInd('Speech', 'warn', '文字起こし（PCのAI）音声の入力がありません'); return; }
  try { await whisper().start(Rec.stream, whisperModel(), Gain.raw && Gain.raw.getAudioTracks()[0]); }
  catch (e) { setInd('Speech', 'warn', '文字起こし（PCのAI）を始められません：' + errMsg(e)); }
}

/* ============================== 録音 ==============================
 * 約10分で1区切り。1分ごとにブラウザへ書き込むので、止まっても失うのは最大1分 */
const Rec = {
  active: false, stream: null, mr: null, timer: null, mime: '', count: 0,
  async start() {
    if (!window.MediaRecorder) { setInd('Rec', 'warn', '録音 未対応'); return; }
    const raw = await openAudioSource();
    if (!raw) { setInd('Rec', 'warn', '録音 マイクが使えません'); return; }
    this.stream = Gain.wrap(raw);   // 「入力の大きさ」をかけた音を、録音と文字起こしに使う
    this.mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    this.active = true; this.begin();
    recMeter.start(this.stream, $('#lvl'));
  },
  async begin() {
    const s = openSession(); if (!s || !this.stream) return;
    if (!Gain.alive()) { setInd('Rec', 'warn', '録音 音声の入力が切れています'); clearTimeout(this.timer); this.timer = setTimeout(() => this.rotate(), 5000); return; }
    const mr = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 32000 } : {});
    const chunk = await store.startAudio({ lectureId: S.lec.id, sessionId: s.id, startAt: Date.now(), mime: mr.mimeType || this.mime });
    S.audio.push(chunk);
    let seq = 0, writing = Promise.resolve();
    mr.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const n = seq++;
      writing = writing.then(() => store.appendAudioPart(chunk.id, n, e.data)).catch((err) => toast('録音を保存できませんでした：' + errMsg(err), 6000));
    };
    mr.onstop = () => {
      writing.then(() => store.finishAudio(chunk.id, Date.now())).then((a) => { const i = S.audio.findIndex((x) => x.id === chunk.id); if (i >= 0 && a) S.audio[i] = a; });
    };
    mr.start(PART_MS);
    this.mr = mr; this.count++;
    setInd('Rec', 'rec', `録音中（${s.name}・区切り${this.count}）`);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rotate(), CHUNK_MS);
  },
  rotate() { if (this.mr && this.mr.state !== 'inactive') this.mr.stop(); if (this.active) this.begin(); },
  stop() {
    this.active = false; clearTimeout(this.timer);
    if (this.mr && this.mr.state !== 'inactive') this.mr.stop();
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    Gain.close();
    this.count = 0; setInd('Rec', '', '録音 停止'); recMeter.stop();
  },
};

/* ============================== 入力の大きさ ==============================
 * 入ってくる音を、⚙ 設定の「入力の大きさ」の分だけ大きく（小さく）してから、録音と文字起こしに渡す。記録中でもすぐ効く */
const gainDb = () => { const v = +ls('inGainDb'); return Number.isFinite(v) ? v : 0; };
const dbLabel = (db) => (db === 0 ? 'そのまま' : `${db > 0 ? '+' : ''}${db}dB（${Math.pow(10, db / 20).toFixed(db > 0 ? 1 : 2)}倍）`);
const Gain = {
  ctx: null, node: null, raw: null,
  wrap(raw) {
    this.close();
    this.raw = raw;
    const ctx = this.ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const g = this.node = ctx.createGain(); g.gain.value = Math.pow(10, gainDb() / 20);
    const dst = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(raw).connect(g).connect(dst);
    return dst.stream;
  },
  set(db) { if (this.node) this.node.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.05); },
  alive() { return !!this.raw && this.raw.getAudioTracks().some((t) => t.readyState === 'live'); },
  close() {
    try { this.ctx && this.ctx.close(); } catch { /* 閉じている */ }
    if (this.raw) this.raw.getTracks().forEach((t) => t.stop());
    this.ctx = null; this.node = null; this.raw = null;
  },
};

/* ============================== 音の大きさのゲージ ==============================
 * 入ってくる音の大きさを、動く棒で見せる。小さすぎると文字起こしが聞き取れない */
function meter() {
  let ctx = null, raf = 0, el = null, lv = 0, quietSince = 0;
  return {
    start(stream, box) {
      this.stop();
      const t = stream && stream.getAudioTracks()[0]; if (!t || !box) return;
      el = box; el.hidden = false;
      ctx = new AudioContext();
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      ctx.createMediaStreamSource(new MediaStream([t])).connect(an);
      const buf = new Float32Array(an.fftSize); quietSince = Date.now();
      const loop = () => {
        an.getFloatTimeDomainData(buf);
        let p = 0; for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > p) p = v; }
        const db = 20 * Math.log10(p || 1e-6);                 // -60dB〜0dB を 0〜100% に
        const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
        lv = pct > lv ? pct : lv * 0.9 + pct * 0.1;            // 上がるのは速く、下がるのはゆっくり
        if (pct > 25) quietSince = Date.now();
        const quiet = Date.now() - quietSince > 8000;
        el.firstElementChild.style.width = lv.toFixed(0) + '%';
        el.className = 'lvl' + (db > -3 ? ' clip' : db > -12 ? ' hot' : '') + (quiet ? ' quiet' : '');
        el.title = (quiet ? '音が小さいか、入っていません（音量や、音声の入力を確かめてください）' : `入力の大きさ ${db.toFixed(0)}dB`) + '。押すと、⚙ 設定で大きさを変えられます';
        raf = requestAnimationFrame(loop);
      };
      loop();
    },
    stop() { cancelAnimationFrame(raf); raf = 0; try { ctx && ctx.close(); } catch { /* 閉じている */ } ctx = null; if (el) { el.firstElementChild.style.width = '0%'; el.hidden = true; } },
  };
}
const recMeter = meter(), testMeter = meter();
let testStream = null, testT = 0;
// ⚙ 設定で「音を確かめる」：選んだ音声の入力を15秒だけ開いて、ゲージを動かす
let testCtx = null, testGain = null;
function endTest() {
  testMeter.stop();
  if (testStream) { testStream.getTracks().forEach((t) => t.stop()); testStream = null; }
  try { testCtx && testCtx.close(); } catch { /* 閉じている */ }
  testCtx = null; testGain = null;
}
async function testLevel() {
  clearTimeout(testT); endTest();
  let s = Rec.stream;   // 記録中は、録音に使っている音（大きさを変えたあと）をそのまま見せる
  if (!s) {
    testStream = await openAudioSource(); if (!testStream) return;
    testCtx = new AudioContext(); testGain = testCtx.createGain(); testGain.gain.value = Math.pow(10, gainDb() / 20);
    const dst = testCtx.createMediaStreamDestination();
    testCtx.createMediaStreamSource(testStream).connect(testGain).connect(dst);
    s = dst.stream;
  }
  testMeter.start(s, $('#lvlTest'));
  testT = setTimeout(endTest, 15000);
}

// 記録中に、録音と文字起こしの音源を、画面共有の音声に取りかえる
async function useSharedAudio() {
  const t = Screen.audioTrack(); if (!t) return false;
  const old = Rec.stream;
  Rec.stream = Gain.wrap(new MediaStream([t.clone()]));
  Rec.rotate();                                   // 録音はここで区切り、新しい音で続ける
  if (old) old.getTracks().forEach((x) => x.stop());
  recMeter.start(Rec.stream, $('#lvl'));
  if (Live.running && liveEngine() === 'whisper') { whisper().stop(); await startWhisper(); }
  return true;
}

/* ============================== 音声の入力（音源の選択） ==============================
 * ''      … いつものマイク（ブラウザの既定）
 * 'share' … 画面共有の音声（Zoom・YouTube などのタブ、または画面全体）
 * それ以外 … 選んだ機器（ステレオミキサー・仮想オーディオ機器・外付けマイクなど）の deviceId */
const audioSourceId = () => ls('audioIn') || '';
async function openAudioSource() {
  const src = audioSourceId();
  if (src === 'share') {
    const t = Screen.audioTrack();
    if (t) return new MediaStream([t.clone()]);
    toast('まだ画面の音声を共有していません。それまではマイクで録音します。「🖥 画面を撮る」で共有すると（「タブの音声も共有する」をオン）、その音声に切り替えます', 9000);
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: src && src !== 'share' ? { deviceId: { exact: src } } : true });
  } catch (e) {
    if (src && src !== 'share') {
      toast('選んだ音声の入力が見つかりません。既定のマイクで録音します', 6000);
      try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { /* 下へ */ }
    }
    toast('録音を開始できませんでした：' + errMsg(e)); return null;
  }
}
async function renderAudioIn() {
  const sel = $('#audioIn'); if (!sel) return;
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'); } catch { /* 一覧なし */ }
  const cur = audioSourceId();
  sel.innerHTML = '<option value="">いつものマイク（既定）</option>'
    + devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `音声の入力 ${i + 1}`)}${/stereo|ステレオ|mix|ミキサー|cable|blackhole|loopback/i.test(d.label) ? '（PCの音）' : ''}</option>`).join('')
    + '<option value="share">画面共有の音声（Zoom・YouTube などのタブ）</option>';
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  $('#audioInHint').hidden = !devs.some((d) => !d.label) ;
}

/* ============================== 画面の共有とスクリーンショット ============================== */
const Screen = {
  stream: null, video: null, region: ls('shotRegion'), timer: null, shots: [], lastAt: 0, prev: null, still: 0,
  audioTrack() { return this.stream ? this.stream.getAudioTracks().find((t) => t.readyState === 'live') || null : null; },
  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { toast('このブラウザでは画面の共有ができません（Chrome か Edge のパソコン版で使えます）'); return; }
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: true, selfBrowserSurface: 'exclude', systemAudio: 'include' });
    } catch { return; }   // 共有をやめた
    this.video = document.createElement('video');
    this.video.muted = true; this.video.playsInline = true; this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.stream.getVideoTracks()[0].addEventListener('ended', () => this.stop());
    renderShare();
    // 記録中に共有を始めたときは、録音と文字起こしを、共有した音声に切り替える
    const switched = Rec.active && audioSourceId() === 'share' && this.audioTrack() ? await useSharedAudio() : false;
    if (!this.region) openRegion();
    else toast(switched ? '画面の共有を始めました。録音と文字起こしを、共有した音声に切り替えました' : '画面の共有を始めました。「📷 撮る」でスライドを写真にします', 5000);
    if (audioSourceId() === 'share' && !this.audioTrack()) toast('音声が共有されていません。共有するとき「タブの音声も共有する」（「システム オーディオを共有」）をオンにしてください', 8000);
  },
  stop() {
    this.setAuto(false);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.video = null;
    renderShare();
    if (Rec.active && audioSourceId() === 'share') toast('画面の共有が終わったので、録音と文字起こしの音声が止まっています。もう一度「🖥 画面を撮る」で共有すると、続きから記録します', 9000);
  },
  frame(maxW) {
    const v = this.video; if (!v || !v.videoWidth) return null;
    const r = this.region || { x: 0, y: 0, w: 1, h: 1 };
    const sx = r.x * v.videoWidth, sy = r.y * v.videoHeight, sw = r.w * v.videoWidth, sh = r.h * v.videoHeight;
    const k = Math.min(1, maxW / sw);
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  },
  async shot(auto) {
    if (!S.lec) return;
    const c = this.frame(1600); if (!c) { toast('画面がまだ映っていません'); return; }
    if (auto && this.blank()) return false;   // 真っ黒・真っ白の画面（場面の切りかわり）は自動では撮らない
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    const at = Date.now(); const s = sessionAt(at) || openSession();
    const m = await store.addImage(S.lec.id, { blob, at, sessionId: s ? s.id : '', text: auto ? '（自動で撮影）' : '', from: 'screen' });
    S.memos.push(m); renderFeed(true); markChanged();
    this.remember(this.sig()); this.lastAt = Date.now();
    if (!auto) toast('📷 撮りました');
    return true;
  },
  // 範囲の画面を 64×36 の白黒にした「目印」。スライドが変わったかを比べる
  sig() {
    const W = 64, H = 36;
    const c = this.frame(W); if (!c) return null;
    const t = document.createElement('canvas'); t.width = W; t.height = H;
    const g = t.getContext('2d'); g.drawImage(c, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    // 下の 1/6（動画の再生ボタンや字幕が出る帯）は比べない
    const out = new Uint8Array(W * (H - 6));
    for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
    return out;
  },
  // いまの画面が、ほぼ一色（真っ黒など）か
  blank() {
    const c = this.frame(32); if (!c) return true;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lo = 255, hi = 0; for (let i = 0; i < d.length; i += 4) { const v = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10; if (v < lo) lo = v; if (v > hi) hi = v; }
    return hi - lo < 24;
  },
  // 変わったマスの割合（0〜1）。マウスの矢印や小さな印は数マスしか変わらない
  diff(a, b) { if (!a || !b || a.length !== b.length) return 1; let n = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) n++; return n / a.length; },
  // 最近撮った画面の目印を覚えておく。同じ画面に戻っただけなら撮らない
  remember(sig) { if (!sig) return; this.shots = [sig, ...(this.shots || [])].slice(0, 6); },
  seen(cur) { return (this.shots || []).some((s) => this.diff(cur, s) < 0.03); },
  autoState(t) { const el = $('#autoState'); if (el) el.textContent = t; },
  setAuto(on) {
    clearInterval(this.timer); this.timer = null;
    const cb = $('#autoShot'); if (cb) cb.checked = !!on;
    this.autoState('');
    if (!on) return;
    if (!(this.shots || []).length) this.remember(this.sig());
    this.prev = null; this.still = 0; this.autoN = 0;
    this.autoState('見張り中');
    // 2秒ごとに見る。最近撮ったどの画面とも違い、4秒以上止まっていて（めくり終わった）、前に撮ってから8秒たっていれば撮る
    this.timer = setInterval(async () => {
      const cur = this.sig(); if (!cur) { this.autoState('画面が映っていません'); return; }
      this.still = this.prev && this.diff(cur, this.prev) < 0.02 ? this.still + 1 : 0;
      this.prev = cur;
      if (this.seen(cur)) { this.autoState(`見張り中${this.autoN ? `（自動 ${this.autoN}枚）` : ''}`); return; }
      if (this.still < 2) { this.autoState('画面が変わりました…止まるのを待っています'); return; }
      if (Date.now() - (this.lastAt || 0) < 8000) return;
      if (await this.shot(true)) this.autoN++;
      this.autoState(`見張り中（自動 ${this.autoN}枚）`);
    }, 2000);
  },
};
function renderShare() {
  const on = !!Screen.stream;
  $('#shareBar').hidden = !on;
  $('#shareBtn').classList.toggle('primary', on);
  $('#shareBtn').title = on ? '画面を共有中（押すと共有をやめる）' : 'ZoomやYouTubeの画面を共有して、スライドを撮る';
  $('#shareBtn').textContent = on ? '🖥 共有中' : '🖥 画面を撮る';
  if (on) $('#shareAudio').textContent = Screen.audioTrack() ? '（音声あり）' : '（音声なし）';
}
/* ============================== 文字起こしの貼り付け取り込み ==============================
 * 放送大学・YouTube のトランスクリプトや Zoom・Teams の字幕を、講義の時刻に直して入れる */
const timeStr = (ms) => hms(ms);
function pasteBaseAt() {
  const s = sessions().find((x) => x.id === $('#pasteSess').value);
  const v = $('#pasteBase').value; const d = new Date(s ? s.start : Date.now());
  if (v) { const [h, m, x] = v.split(':').map(Number); d.setHours(h, m, x || 0, 0); }
  return d.getTime();
}
// 貼り付けた文を、講義の時刻に直す。すでに取り込んだ文と同じ時刻のものは、重なりとして飛ばす（長いほうを残す）
function pastePlan() {
  const { items, timed, dropped = 0 } = parseTranscript($('#pasteText').value, $('#pasteOrder').value);
  const base = pasteBaseAt(), sid = $('#pasteSess').value, replace = $('#pasteReplace').checked;
  const have = new Map();
  for (const t of S.transcript) if (t.source === 'import' && !(replace && t.sessionId === sid)) have.set(Math.round(t.at / 1000), t);
  const add = [], update = []; let same = 0;
  // 時刻がないものは、1行ごとに1秒ずつずらして順番を保つ
  items.forEach((it, i) => {
    const at = base + (timed ? it.sec : i) * 1000, k = Math.round(at / 1000);
    const old = have.get(k);
    if (old) { if (it.text.length > old.text.length) update.push({ row: old, text: it.text }); else same++; return; }
    const s = sessionAt(at); const row = { at, text: it.text, sessionId: s ? s.id : sid };
    add.push(row); have.set(k, row);
  });
  return { add, update, same, dropped, timed, all: items.length };
}
function renderPastePreview() {
  const p = pastePlan(), el = $('#pastePreview');
  if (!$('#pasteText').value.trim()) { el.innerHTML = ''; return; }
  if (!p.all) { el.innerHTML = '読み取れる文がありません'; return; }
  const rows = p.add;
  const extra = [p.same && `取り込み済みの${p.same}行は飛ばします`, p.update.length && `${p.update.length}行は長いほうに置きかえます`, p.dropped && `最初か最後の、途中で切れた文（時刻なし）を省きます`].filter(Boolean).join('。');
  const head = rows.length
    ? `<b>${rows.length}行</b>を ${p.timed ? `<b>${timeStr(rows[0].at)}〜${timeStr(rows[rows.length - 1].at)}</b> に並べます` : '時刻なしで、動画の 0:00 の時刻から順に並べます'}`
    : '<b>新しい行はありません</b>';
  el.innerHTML = head + (extra ? `<div>${extra}</div>` : '') + rows.slice(0, 4).map((r) => `<div><span class="tm">${timeStr(r.at)}</span>${esc(r.text.slice(0, 80))}</div>`).join('') + (rows.length > 4 ? '<div>…</div>' : '');
}
const savedBase = (sid) => (S.lec.pasteBase || {})[sid];
function openPaste() {
  if (!S.lec) return;
  const ss = sessions(), cur = openSession() || ss[ss.length - 1];
  $('#pasteSess').innerHTML = ss.length ? ss.map((s) => `<option value="${esc(s.id)}" ${cur && s.id === cur.id ? 'selected' : ''}>${esc(s.name)}（${hm(s.start)}〜）</option>`).join('') : '<option value="">セッション外</option>';
  $('#pasteBase').value = savedBase($('#pasteSess').value) || timeStr(cur ? cur.start : Date.now());
  $('#pasteOrder').value = ls('pasteOrder') || 'auto';
  $('#pasteAuto').checked = !!ls('pasteAuto');
  renderPastePreview();
  $('#pasteModal').hidden = false; $('#pasteText').focus();
}
async function doPaste(keepOpen) {
  const p = pastePlan(), sid = $('#pasteSess').value;
  if (!p.all) { toast('取り込む文がありません。トランスクリプトを貼り付けてください'); return; }
  try {
    const r = await store.importTranscript(S.lec.id, p.add, $('#pasteReplace').checked ? sid : undefined, p.update.map((u) => ({ key: u.row.key, text: u.text })));
    if (r.removed) S.transcript = S.transcript.filter((t) => !(t.source === 'import' && t.sessionId === sid));
    p.update.forEach((u) => { u.row.text = u.text; });
    S.transcript.push(...r.rows); S.transcript.sort((a, b) => a.at - b.at);
    // 動画の 0:00 の時刻は、次に貼るときのために覚えておく（続きを貼るとき、毎回合わせなくてよい）
    S.lec = await store.updateLecture(S.lec.id, { pasteBase: { ...(S.lec.pasteBase || {}), [sid]: $('#pasteBase').value }, changedAt: Date.now() });
    refreshOption();
    $('#pasteReplace').checked = false; $('#pasteText').value = ''; $('#pasteFile').value = ''; renderPastePreview();
    if (!keepOpen) $('#pasteModal').hidden = true; else $('#pasteText').focus();
    renderTranscript(); if (S.tab === 'vSum') renderSummary();
    toast(`${r.rows.length}行を取り込みました${p.update.length ? `・${p.update.length}行を直しました` : ''}${p.same ? `（重なり${p.same}行は飛ばしました）` : ''}${r.removed ? `（前の${r.removed}行を置きかえ）` : ''}`);
  } catch (e) { toast('取り込めませんでした：' + errMsg(e)); }
}
['#pasteText', '#pasteOrder', '#pasteBase', '#pasteReplace'].forEach((id) => $(id).addEventListener('input', renderPastePreview));
$('#pasteReplace').addEventListener('change', renderPastePreview);
$('#pasteAuto').addEventListener('change', () => ls('pasteAuto', $('#pasteAuto').checked));
$('#pasteText').addEventListener('paste', () => { if ($('#pasteAuto').checked) setTimeout(() => { if ($('#pasteText').value.trim()) doPaste(true); }, 0); });
$('#pasteOrder').addEventListener('change', () => { ls('pasteOrder', $('#pasteOrder').value); renderPastePreview(); });
$('#pasteSess').addEventListener('change', () => { const sid = $('#pasteSess').value, s = sessions().find((x) => x.id === sid); $('#pasteBase').value = savedBase(sid) || (s ? timeStr(s.start) : $('#pasteBase').value); renderPastePreview(); });
$('#pasteFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; $('#pasteText').value = await f.text(); renderPastePreview(); });

/* 範囲を決める：共有した画面の上をドラッグする */
let regionDrag = null;
function openRegion() {
  const v = Screen.video; if (!v || !v.videoWidth) { setTimeout(openRegion, 300); return; }
  const cv = $('#regionCanvas');
  const k = Math.min(1, (window.innerWidth * 0.9) / v.videoWidth, (window.innerHeight * 0.62) / v.videoHeight);
  cv.width = Math.round(v.videoWidth * k); cv.height = Math.round(v.videoHeight * k);
  regionDrag = { r: Screen.region ? { ...Screen.region } : null };
  drawRegion();
  $('#regionModal').hidden = false;
}
function drawRegion() {
  const cv = $('#regionCanvas'), g = cv.getContext('2d'), v = Screen.video; if (!v) return;
  g.drawImage(v, 0, 0, cv.width, cv.height);
  const r = regionDrag && regionDrag.r;
  if (r) {
    g.fillStyle = 'rgba(20,36,59,.55)';
    const x = r.x * cv.width, y = r.y * cv.height, w = r.w * cv.width, h = r.h * cv.height;
    g.fillRect(0, 0, cv.width, y); g.fillRect(0, y + h, cv.width, cv.height - y - h); g.fillRect(0, y, x, h); g.fillRect(x + w, y, cv.width - x - w, h);
    g.strokeStyle = '#FFE45C'; g.lineWidth = 3; g.strokeRect(x, y, w, h);
  }
}
function regionPoint(e) {
  const cv = $('#regionCanvas'), b = cv.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
}
$('#regionCanvas').addEventListener('pointerdown', (e) => { e.preventDefault(); $('#regionCanvas').setPointerCapture(e.pointerId); regionDrag.start = regionPoint(e); });
$('#regionCanvas').addEventListener('pointermove', (e) => {
  if (!regionDrag || !regionDrag.start) return;
  const a = regionDrag.start, b = regionPoint(e);
  regionDrag.r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  drawRegion();
});
$('#regionCanvas').addEventListener('pointerup', () => { if (regionDrag) regionDrag.start = null; });
function saveRegion(r) {
  Screen.region = r && r.w > 0.03 && r.h > 0.03 ? r : null;
  ls('shotRegion', Screen.region);
  $('#regionModal').hidden = true;
  Screen.shots = [];
  toast(Screen.region ? 'この範囲を撮ります。「📷 撮る」（Alt+S）で撮影' : '画面全体を撮ります。「📷 撮る」（Alt+S）で撮影');
}

/* ============================== セッション ============================== */
async function startSession() {
  const s = { id: store.newId(), name: `セッション${sessions().length + 1}`, start: Date.now(), end: null };
  S.lec.sessions = [...sessions(), s];
  await saveLecture({ sessions: S.lec.sessions, changedAt: Date.now() });
  refreshOption();
  await Rec.start();   // 先に音源を開く（選んだ音源を音声認識にも渡すため）
  Live.start();
  keepAwake();
  renderCtrl(); renderTranscript(); sendInfo();
}
async function nextSession() {
  const cur = openSession(); if (cur) cur.end = Date.now();
  S.lec.sessions.push({ id: store.newId(), name: `セッション${sessions().length + 1}`, start: Date.now(), end: null });
  await saveLecture({ sessions: S.lec.sessions });
  Rec.rotate();   // 録音もここで区切る
  renderCtrl(); renderTranscript(); sendInfo();
}
async function endSession() {
  const cur = openSession(); if (cur) cur.end = Date.now();
  Live.stop(); Rec.stop(); releaseWake();
  await saveLecture({ sessions: S.lec.sessions });
  renderCtrl();
  await markChanged();
  $('#nudge').hidden = false;   // 書き出しの案内
  sendInfo();
}

/* ============================== スマホと連携 ============================== */
const L = { host: null, state: 'off', phones: 0 };
const linkInfo = () => { const s = openSession(); return { title: S.lec ? S.lec.title || '無題の講義' : '', session: s ? s.name : '', look: currentLook() }; };
function sendInfo() { if (L.host) L.host.broadcast({ t: 'info', ...linkInfo() }); }
async function receivePhoto(m) {
  if (!S.lec || !(m.data instanceof ArrayBuffer || ArrayBuffer.isView(m.data))) throw new Error('受け取れませんでした');
  const at = Number(m.at) || Date.now();
  const s = sessionAt(at) || openSession();
  const blob = new Blob([m.data], { type: m.mime || 'image/jpeg' });
  const memo = await store.addImage(S.lec.id, { id: String(m.id), blob, at, sessionId: s ? s.id : '', text: String(m.text || ''), from: 'phone' });
  if (!S.memos.some((x) => x.id === memo.id)) { S.memos.push(memo); renderFeed(true); toast('📱 スマホから写真が届きました'); markChanged(); }
}
async function receiveMemo(m) {
  if (!S.lec) throw new Error('講義が開いていません');
  const at = Number(m.at) || Date.now();
  const s = sessionAt(at) || openSession();
  const type = ['memo', 'key', 'q', 'todo', 'quote'].includes(m.type) ? m.type : 'memo';
  const memo = await store.addMemo(S.lec.id, { id: String(m.id), at, sessionId: s ? s.id : '', type, text: String(m.text || ''), from: 'phone' });
  if (!S.memos.some((x) => x.id === memo.id)) { S.memos.push(memo); renderFeed(true); markChanged(); }
}
function linkStatus({ state, phones, error }) {
  Object.assign(L, { state, phones });
  const text = state === 'off' ? '' : phones ? `📱 スマホ ${phones}台とつながっています`
    : state === 'waiting' ? '📱 スマホを待っています' : state === 'reconnecting' ? '📱 つなぎ直しています…' : `📱 連携できません（${error}）`;
  $('#tLink').textContent = text; $('#linkInd').hidden = !text;
  $('#dLink').className = 'dot ' + (phones ? 'on' : state === 'error' ? 'warn' : '');
  const st = $('#linkState'); if (st) st.textContent = text || '止まっています';
  $('#linkBtn').classList.toggle('primary', !!phones);
}
async function openLink() {
  if (!S.lec) return;
  if (!S.lec.linkId) S.lec = await store.updateLecture(S.lec.id, { linkId: randomLinkId() });
  const url = phoneUrl(S.lec.linkId);
  $('#qr').innerHTML = await qrSvg(url).catch(() => '<p class="note">QRコードを作れませんでした。下のURLをスマホで開いてください。</p>');
  $('#qrUrl').textContent = url;
  $('#linkModal').hidden = false;
  if (!L.host) {
    linkStatus({ state: 'reconnecting', phones: 0 });
    try { L.host = await startHost(S.lec.linkId, { onPhoto: receivePhoto, onMemo: receiveMemo, onStatus: linkStatus, getInfo: linkInfo }); }
    catch (e) { linkStatus({ state: 'error', phones: 0, error: errMsg(e) }); }
  } else linkStatus({ state: L.state, phones: L.phones });
}
function stopLink() { if (L.host) { L.host.stop(); L.host = null; } linkStatus({ state: 'off', phones: 0 }); }
async function newLinkId() {
  stopLink();
  S.lec = await store.updateLecture(S.lec.id, { linkId: randomLinkId() });
  await openLink();
  toast('新しいQRコードにしました。前のQRコードではつながりません');
}

/* ============================== メモ・写真 ============================== */
async function addMemo() {
  const ta = $('#memoIn'); const text = ta.value.trim(); if (!text || !S.lec) return;
  const at = Date.now(); const s = sessionAt(at) || openSession();
  ta.value = ''; autosize();   // 保存を待たずに空にする（続けて打った文字が消えないように）
  let m;
  try { m = await store.addMemo(S.lec.id, { at, sessionId: s ? s.id : '', type: S.type, text }); }
  catch (e) { if (!ta.value) { ta.value = text; autosize(); } toast('メモを保存できませんでした：' + errMsg(e)); return; }
  S.memos.push(m); renderFeed(true);
  markChanged();
}
async function removeMemo(id) {
  await store.deleteMemo(id);
  markChanged();
  S.memos = S.memos.filter((m) => m.id !== id); renderFeed();
}
async function addImages(files) {
  if (!S.lec) { toast('先に講義を選んでください'); return; }
  const text = $('#memoIn').value.trim();
  let placed = 0;
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      // 写真に撮影時刻が入っていれば、その時刻の位置に並べる（あとでまとめて取り込むとき）
      const now = Date.now();
      const shot = await exifTime(f);
      const at = shot && Math.abs(now - shot) > 2 * 60 * 1000 ? shot : now;
      const blob = await resizeImage(f);
      const s = sessionAt(at) || (at === now ? openSession() : null);
      const m = await store.addImage(S.lec.id, { blob, at, sessionId: s ? s.id : '', text, from: at === now ? 'pc' : 'import' });
      S.memos.push(m); placed += at === now ? 0 : 1;
    } catch (e) { toast('写真を追加できませんでした：' + errMsg(e)); }
  }
  if (placed) toast(`${placed}枚を、撮った時刻の位置に並べました`);
  if (text) { $('#memoIn').value = ''; autosize(); }
  renderFeed(true);
  markChanged();
}
async function imageUrl(imageId) {
  if (!S.urls[imageId]) { const b = await store.getImage(imageId); if (b) S.urls[imageId] = URL.createObjectURL(b); }
  return S.urls[imageId] || '';
}

/* ============================== 表示 ============================== */
function setInd(k, cls, text) { $('#d' + k).className = 'dot' + (cls ? ' ' + cls : ''); $('#t' + k).textContent = text; $('#d' + k).parentElement.title = text; }
function render(full) {
  const has = !!S.lec;
  $('#welcome').hidden = has; $('#metaBox').hidden = !has; $('#linkBtn').hidden = !has; $('#focusBtn').hidden = !has; $('#tabs').hidden = !has; $('#ctrl').hidden = !has || S.tab !== 'vLive';
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', has && v.id === S.tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === S.tab));
  if (!has) return;
  if (full) { $('#fTitle').value = S.lec.title || ''; $('#fSpeaker').value = S.lec.speaker || ''; $('#fDate').value = S.lec.date || ''; $('#fVenue').value = S.lec.venue || ''; }
  renderCtrl(); renderTranscript(); renderFeed(true); renderTypes();
  if (S.tab === 'vSum') renderSummary();
}
function renderCtrl() {
  const s = openSession(), ss = sessions();
  $('#ctrlBtns').innerHTML = s
    ? '<button class="btn" type="button" data-act="next" title="次のセッションへ">⏭ 次<span class="lbl">のセッション</span>へ</button><button class="btn" type="button" data-act="end">■ 終了</button>'
    : `<button class="btn rec" type="button" data-act="start" title="${ss.length ? 'セッションを追加して開始' : 'セッション開始'}">●<span class="lbl"> ${ss.length ? 'セッションを追加して' : 'セッション'}</span>開始</button>`;
  $('#sName').textContent = s ? s.name : ss.length ? `${ss.length}セッション記録済み` : '開始前';
  $('#sName').classList.toggle('idle', !s);
  // ページを開き直したとき、記録中のまま残ったセッションがあれば知らせる
  if (s && !recording()) $('#ctrlBtns').insertAdjacentHTML('afterbegin', '<button class="btn rec" type="button" data-act="resume">● 記録を再開</button>');
  tick();
}
function tick() {
  const s = openSession(), ss = sessions();
  $('#sEl').textContent = s ? dur((Date.now() - s.start) / 1000) : '0:00';
  $('#sTot').textContent = ss.length ? `全体 ${dur(((s ? Date.now() : ss[ss.length - 1].end || Date.now()) - ss[0].start) / 1000)}` : '';
}
setInterval(() => { if (S.lec && S.tab === 'vLive') tick(); }, 1000);

const tlineHtml = (t) => `<div class="tline${t.source === 'import' ? ' imp' : ''}"${t.source === 'import' ? ' title="貼り付けて取り込んだ文字"' : ''}><span class="tm">${hms(t.at)}</span><span class="tx">${esc(t.text)}</span></div>`;
function renderTranscript() {
  const list = $('#tList');
  const live = S.transcript.filter((t) => t.source !== 'hq');
  if (!live.length) { list.innerHTML = `<p class="empty">${openSession() ? '話し声を待っています…' + (audioSourceId() && liveEngine() === 'web' ? '<br><small>音声の入力を「マイク以外」にしています。録音はその音声で行いますが、ブラウザによっては文字起こしがマイクの音しか聞けません（Edge では共有した音声を聞けないことがあります）。共有した音声を文字にするには、⚙ 設定の「リアルタイム文字起こしの方法」で「このPCのAI」を選んでください。</small>' : '') : '「セッション開始」を押すと、ここに文字起こしが流れます。'}</p>`; list.dataset.last = ''; return; }
  const names = Object.fromEntries(sessions().map((s) => [s.id, s.name]));
  let html = '', last = null;
  for (const t of live) {
    if (t.sessionId !== last) { last = t.sessionId; html += `<div class="shead">${esc(names[t.sessionId] || 'セッション外')}</div>`; }
    html += tlineHtml(t);
  }
  list.innerHTML = html; list.dataset.last = last || '';
  scrollBottom('#tScroll');
}
function appendTLine(t) {
  const list = $('#tList');
  if (list.querySelector('.empty')) { renderTranscript(); return; }
  if (t.sessionId !== list.dataset.last) {
    list.dataset.last = t.sessionId;
    const s = sessions().find((x) => x.id === t.sessionId);
    list.insertAdjacentHTML('beforeend', `<div class="shead">${esc(s ? s.name : 'セッション外')}</div>`);
  }
  list.insertAdjacentHTML('beforeend', tlineHtml(t));
  scrollBottom('#tScroll');
}
function showInterim(text) { const el = $('#interim'); el.hidden = !text; el.querySelector('.tx').textContent = text; if (text) scrollBottom('#tScroll'); }
function scrollBottom(sel) { if (sel === '#tScroll' && !$('#autoScroll').checked) return; if (sel === '#fScroll' && !$('#autoScrollF').checked) return; const el = $(sel); el.scrollTop = el.scrollHeight; }

function renderFeed(scroll) {
  const items = S.memos.slice().sort((a, b) => a.at - b.at);
  $('#feedCount').textContent = items.length ? `${items.length}件` : '';
  if (!items.length) { $('#feed').innerHTML = '<li class="empty">気づいたことや写真がここに並びます。写真は貼り付け（Ctrl+V）やドラッグでも追加できます。</li>'; return; }
  $('#feed').innerHTML = items.map((m) => {
    const tag = TAGS[m.type];
    // 写真は左に寄せ、続くメモの文字が写真の横に回り込むようにする
    return `<li class="fi ${esc(m.type)}${m.imageId ? ' hasimg' : ''}">${m.imageId ? `<img data-img="${esc(m.imageId)}" alt="写真 ${hms(m.at)}">` : ''}<span class="tm">${hms(m.at)}</span><span class="tx">${tag ? `<span class="tag">${tag}</span>` : ''}<span class="t">${esc(m.text)}</span>${m.from === 'phone' ? '<span class="from"> 📱</span>' : m.from === 'screen' ? '<span class="from"> 🖥</span>' : m.from === 'import' ? '<span class="from"> （撮影時刻で配置）</span>' : ''}</span><button class="x" type="button" data-del="${esc(m.id)}" title="削除" aria-label="削除">×</button></li>`;
  }).join('');
  document.querySelectorAll('#feed img[data-img]').forEach(async (img) => {
    img.addEventListener('load', () => scrollBottom('#fScroll'), { once: true });   // 写真が読み込まれて高さが変わっても、いちばん下を見せる
    img.src = await imageUrl(img.dataset.img);
  });
  if (scroll) scrollBottom('#fScroll');
}
function renderTypes() {
  $('#types').innerHTML = TYPES.map((t, i) => `<button type="button" class="chip${S.type === t.k ? ' on' : ''}" data-type="${t.k}" title="Alt+${i + 1}">${t.label}</button>`).join('');
}
let memoSetH = 0;
function autosize() {
  const ta = $('#memoIn');
  const base = (typeof VIEW !== 'undefined' && VIEW.memoH) || (document.body.classList.contains('focus') ? 140 : 92);
  ta.style.height = 'auto';
  memoSetH = Math.round(Math.max(base, Math.min(ta.scrollHeight + 4, window.innerHeight * 0.45)));
  ta.style.height = memoSetH + 'px';
}
// 右下のつまみで高さを変えたら、その高さを覚える（狭くも広くもできる）
['pointerup', 'mouseup'].forEach((ev) => $('#memoIn').addEventListener(ev, () => {
  const h = $('#memoIn').offsetHeight;
  if (memoSetH && Math.abs(h - memoSetH) > 6) { memoSetH = h; setView({ memoH: h }); }
}));

/* ============================== 表示の切り替え（広く表示・文字起こしをたたむ） ============================== */
const VIEW = Object.assign({ focus: false, tx: true, memoH: 0, photo: 'm' }, ls('view') || {});
function applyView() {
  document.body.classList.toggle('focus', VIEW.focus);
  // 広く表示：タブとセッション操作を上の帯へ。戻すときは元の場所へ
  if (VIEW.focus) { $('#focusSlot').append($('#tabs'), $('#ctrl')); }
  else { $('#metaBox').after($('#tabs')); $('header').after($('#ctrl')); }
  $('#vLive').classList.toggle('tx-off', !VIEW.tx);
  const fb = $('#focusBtn');
  fb.setAttribute('aria-pressed', String(VIEW.focus));
  fb.innerHTML = VIEW.focus ? '⤡<span class="lbl"> 元の表示</span>' : '⤢<span class="lbl"> 広く表示</span>';
  fb.title = VIEW.focus ? '隠した講義の情報や表示を元に戻します' : '講義の情報や表示を隠して、記録の画面を広くします';
  $('#memoIn').style.height = ''; autosize();
  applyPhotoSize();
}
/* メモ欄の写真の大きさ。欄の幅が足りないときは回り込ませず、写真の下に文字を置く */
function applyPhotoSize() {
  const p = PHOTO_SIZES.find((x) => x.k === VIEW.photo) || PHOTO_SIZES[1];
  const feed = $('#feed');
  feed.style.setProperty('--photo-w', p.feed ? p.feed + 'px' : '100%');
  const w = $('#fScroll').clientWidth;
  feed.classList.toggle('nowrap', !p.feed || w - p.feed < 220);
  const sel = $('#photoSize');
  if (!sel.options.length) sel.innerHTML = PHOTO_SIZES.map((x) => `<option value="${x.k}">${x.label}</option>`).join('');
  sel.value = p.k;
}
$('#photoSize').addEventListener('change', (e) => { setView({ photo: e.target.value }); scrollBottom('#fScroll'); });
if (window.ResizeObserver) new ResizeObserver(() => applyPhotoSize()).observe($('#fScroll'));
function setView(patch) { Object.assign(VIEW, patch); ls('view', VIEW); applyView(); }
$('#focusBtn').addEventListener('click', () => setView({ focus: !VIEW.focus }));
$('#txClose').addEventListener('click', () => setView({ tx: false }));
$('#txOpen').addEventListener('click', () => { setView({ tx: true }); scrollBottom('#tScroll'); });

/* ============================== まとめ・出力 ============================== */
// 文字起こしは、清書 ＞ 取り込み ＞ 速報 の順に、あるものを使う
function sessionText(s) {
  const of = (src) => S.transcript.filter((t) => t.sessionId === s.id && t.source === src);
  const hq = of('hq'); if (hq.length) return { kind: '清書', lines: hq };
  const im = of('import'); if (im.length) return { kind: '取り込み', lines: im };
  return { kind: '速報', lines: S.transcript.filter((t) => t.sessionId === s.id && !['hq', 'import'].includes(t.source)) };
}
function renderSummary() {
  const ss = sessions();
  const used = S.audio.filter((a) => a.status !== 'deleted').reduce((n, a) => n + (a.bytes || 0), 0);
  let html = `<div class="card"><h3>講義全体</h3>
    <div class="sumrow">
      <button class="btn primary" type="button" data-act="md">テキスト（Markdown）で保存</button>
      <button class="btn" type="button" data-act="print">写真入りで印刷・PDF</button>
      ${window.showDirectoryPicker ? '<button class="btn" type="button" data-act="folder">フォルダに書き出し（音声・写真も）</button>' : ''}
    </div>
    <div class="sumrow">
      <button class="btn" type="button" data-act="backup">バックアップを書き出す</button>
      <label class="small"><input type="checkbox" id="bkAudio"> 音声も含める（${mb(used)}）</label>
      <span class="sp"></span>
      <button class="btn ghost danger" type="button" data-act="dellec">この講義を削除</button>
    </div>
    ${exportNote()}</div>`;
  if (!ss.length) html += '<p class="empty">まだセッションがありません。「記録」でセッションを開始してください。</p>';
  for (const s of ss) {
    const tx = sessionText(s);
    const nm = S.memos.filter((m) => m.sessionId === s.id);
    const au = S.audio.filter((a) => a.sessionId === s.id && a.status !== 'deleted');
    const chars = tx.lines.reduce((n, t) => n + t.text.length, 0);
    const sum = (S.lec.summaries || {})[s.id] || {};
    html += `<div class="card">
      <h3><input value="${esc(s.name)}" data-sname="${esc(s.id)}" aria-label="セッション名"><small>${hm(s.start)}〜${s.end ? hm(s.end) : '記録中'}（${dur(((s.end || Date.now()) - s.start) / 1000)}）</small></h3>
      <div class="stats"><span>文字起こし（${tx.kind}）<b>${chars.toLocaleString()}</b>字</span><span>メモ <b>${nm.filter((m) => m.type !== 'photo').length}</b></span>
        <span>写真 <b>${nm.filter((m) => m.type === 'photo').length}</b></span><span>録音 <b>${au.length}</b>区切り</span></div>
      ${seishoRow(s, au)}
      <div class="sumrow">
        <label>要約の文字数 <input type="number" min="50" step="50" value="${sum.chars || 400}" data-chars="${esc(s.id)}"> 字</label>
        <button class="btn primary" type="button" data-act="prompt" data-sid="${esc(s.id)}">要約用にコピー</button>
      </div>
      <p class="note">コピーした文章を、使ってよいAI（学校のGeminiなど）に貼り付けて要約させ、結果を下に貼って保存します。</p>
      <textarea data-sum="${esc(s.id)}" placeholder="ここに要約を貼り付け（自分で書いてもかまいません）">${esc(sum.text || '')}</textarea>
      <div class="sumrow"><button class="btn" type="button" data-act="savesum" data-sid="${esc(s.id)}">要約を保存</button><span class="small muted">${sum.savedAt ? '保存：' + hm(sum.savedAt) : ''}</span></div>
      ${au.length ? `<details class="audio"><summary>録音を聞く・保存する（${au.length}区切り）</summary><ul class="alist">${au.map((a, i) => `
        <li><span class="mono">${hm(a.startAt)}〜${a.endAt ? hm(a.endAt) : ''}</span><span class="muted">${mb(a.bytes || 0)}${a.recovered ? '・途中で中断' : ''}</span>
          <button class="btn" type="button" data-act="play" data-aid="${esc(a.id)}">▶ 聞く</button>
          <button class="btn" type="button" data-act="dlaudio" data-aid="${esc(a.id)}" data-n="${i + 1}" data-sname="${esc(s.name)}">保存</button></li>`).join('')}</ul></details>` : ''}
    </div>`;
  }
  $('#sumWrap').innerHTML = html;
}
function seishoRow(s, au) {
  const hq = (S.lec.hq || {})[s.id], has = S.transcript.some((t) => t.source === 'hq' && t.sessionId === s.id);
  const engine = ls('engine') || 'none';
  if (SEI && SEI.sid === s.id) return `<div class="sumrow seisho"><span class="small" data-seistate="${esc(s.id)}">${esc(SEI.state)}</span><button class="btn ghost" type="button" data-act="seisho-stop">やめる</button></div>`;
  if (!s.end) return au.length ? `<div class="sumrow seisho"><span class="small muted">✨ 清書は、このセッションを終了すると使えます（「記録」の「■ 終了」）</span></div>` : '';
  const how = engine === 'none' ? '' : `（${ENGINE_NAME[engine]}）`;
  return `<div class="sumrow seisho">
    ${au.length ? `<button class="btn" type="button" data-act="seisho" data-sid="${esc(s.id)}">✨ ${has ? '清書をやり直す' : '清書する'}${how}</button>` : ''}
    ${has ? `<span class="small">✓ 清書済み${hq ? `（${new Date(hq.at).toLocaleDateString('ja-JP')} ${hm(hq.at)}・${ENGINE_NAME[hq.engine] || ''}）` : ''}</span>` : au.length ? '<span class="small muted">録音を、ていねいに文字にし直します</span>' : ''}
    ${has && au.length ? `<span class="sp"></span><button class="btn ghost danger" type="button" data-act="delaudio-hq" data-sid="${esc(s.id)}">清書が済んだ録音を消す（${mb(au.reduce((n, a) => n + (a.bytes || 0), 0))}）</button>` : ''}
  </div>`;
}
function exportNote() {
  const st = exportState(S.lec);
  const when = S.lec.exportedAt ? `${new Date(S.lec.exportedAt).toLocaleDateString('ja-JP')} ${hm(S.lec.exportedAt)}` : '';
  if (st === 'done') return `<p class="state ok">✓ 書き出し済み（${when}）。その後の変更はありません。</p>`;
  if (st === 'changed') return `<p class="state warn">⚠ 書き出した後（${when}）に変更があります。もう一度書き出してください。</p>`;
  if (st === 'never') return '<p class="state warn">⚠ まだ書き出していません。記録はこのブラウザの中だけにあり、サイトのデータを消すと失われます。</p>';
  return '<p class="note">記録はこのブラウザの中だけにあります。終わったら書き出しておいてください。</p>';
}
function buildPrompt(s, chars) {
  const tx = sessionText(s);
  const memos = S.memos.filter((m) => m.sessionId === s.id && m.type !== 'photo');
  return [
    `次は「${S.lec.title || '（無題）'}」（講師：${S.lec.speaker || '不明'}）の「${s.name}」の文字起こしと、聞き手のメモです。`,
    '文字起こしは自動認識のため、誤字や聞き間違いを含みます。文脈から正しく補って読んでください。',
    '',
    `【お願い】この内容を日本語で${chars}字程度に要約してください。`,
    '・最初に要旨、続けて重要なポイントを箇条書き',
    '・聞き手のメモの【要点】【質問】【TODO】は優先して反映',
    '・文字起こしにない内容は付け足さない',
    '',
    '■ 聞き手のメモ',
    ...(memos.length ? memos.map((m) => `${hm(m.at)} ${TAGS[m.type] ? '【' + TAGS[m.type] + '】' : ''}${m.text}`) : ['（なし）']),
    '',
    `■ 文字起こし（${tx.kind}）`,
    ...tx.lines.map((t) => `${hm(t.at)} ${t.text}`),
  ].join('\n');
}
/** 書き出し用：セッションに加えて、セッションの外で書いたメモ・文字起こしもまとめる */
function exportGroups() {
  const ids = new Set(sessions().map((s) => s.id));
  const orphan = S.memos.some((m) => !ids.has(m.sessionId)) || S.transcript.some((t) => !ids.has(t.sessionId));
  return orphan ? [{ id: '', name: 'セッション外', start: 0, outside: ids }, ...sessions()] : sessions();
}
const inGroup = (g, x) => (g.outside ? !g.outside.has(x.sessionId) : x.sessionId === g.id);
const range = (s) => (s.start ? `（${hm(s.start)}〜${s.end ? hm(s.end) : ''}）` : '');

function toMarkdown() {
  const L = S.lec, out = [`# ${L.title || '無題の講義'}`, '', `- 講師：${L.speaker || ''}`, `- 日付：${L.date || ''}`, `- 会場：${L.venue || ''}`, ''];
  for (const s of exportGroups()) {
    out.push(`## ${s.name}${range(s)}`, '');
    const sum = (L.summaries || {})[s.id]; if (sum && sum.text) out.push('### 要約', '', sum.text.trim(), '');
    const ms = S.memos.filter((m) => inGroup(s, m));
    if (ms.length) { out.push('### メモ・写真', ''); ms.forEach((m) => out.push(`- ${hm(m.at)} ${TAGS[m.type] ? '【' + TAGS[m.type] + '】' : ''}${m.text.replace(/\n/g, ' ')}`)); out.push(''); }
    const tx = s.outside ? { kind: '速報', lines: S.transcript.filter((t) => inGroup(s, t)) } : sessionText(s);
    if (tx.lines.length) { out.push(`### 文字起こし（${tx.kind}）`, ''); tx.lines.forEach((t) => out.push(`${hms(t.at)}　${t.text}  `)); out.push(''); }
  }
  return out.join('\n');
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const ext = (mime) => (/ogg/.test(mime) ? 'ogg' : /mp4|aac/.test(mime) ? 'm4a' : 'webm');
const blobToDataUrl = (b) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });

/* 写真の大きさ（印刷とメモ欄で共通）。幅の割合が半分以下なら、写真の横に文字を回り込ませる */
const PHOTO_SIZES = [
  { k: 's', label: '小', print: 28, feed: 140 },
  { k: 'm', label: '中', print: 42, feed: 200 },
  { k: 'l', label: '大', print: 62, feed: 300 },
  { k: 'xl', label: '幅いっぱい', print: 100, feed: 0 },
];
/* 印刷画面の設定（印刷画面の側からも書き換えるので、別の場所に保存する） */
const PRINT_KEY = 'kougi-print';
const printPrefs = () => { try { return Object.assign({ photo: 'm', side: false, wrap: true }, JSON.parse(localStorage.getItem(PRINT_KEY) || '{}')); } catch { return { photo: 'm', side: false, wrap: true }; } };
async function printView(btn) {
  // 印刷画面のページを先に作り、できあがってから開く。
  // （空の窓を開いて後から書き込む方法だと、アプリとして入れた窓から開いたときに真っ白になる）
  toast('印刷画面を準備しています…');
  const L = S.lec;
  let body = `<h1>${esc(L.title || '無題の講義')}</h1><p class="meta">講師：${esc(L.speaker)}　日付：${esc(L.date)}　会場：${esc(L.venue)}</p>`;
  for (const s of exportGroups()) {
    body += `<h2>${esc(s.name)}${range(s)}</h2>`;
    const sum = (L.summaries || {})[s.id]; if (sum && sum.text) body += `<h3>要約</h3><div class="pre">${esc(sum.text)}</div>`;
    const ms = S.memos.filter((m) => inGroup(s, m));
    let memoHtml = '', txHtml = '';
    if (ms.length) {
      memoHtml += '<h3>メモ・写真</h3><div class="memos">';
      for (const m of ms) {
        let img = ''; if (m.imageId) { const b = await store.getImage(m.imageId); if (b) img = `<img src="${await blobToDataUrl(b)}" alt="写真 ${hm(m.at)}">`; }
        memoHtml += `<div class="memo">${img}<span class="tm">${hm(m.at)}</span>${TAGS[m.type] ? '【' + TAGS[m.type] + '】' : ''}${esc(m.text)}</div>`;
      }
      memoHtml += '</div>';
    }
    const tx = s.outside ? { kind: '速報', lines: S.transcript.filter((t) => inGroup(s, t)) } : sessionText(s);
    if (tx.lines.length) txHtml = `<h3>文字起こし（${tx.kind}）</h3>` + tx.lines.map((t) => `<p class="t"><span>${hm(t.at)}</span>${esc(t.text)}</p>`).join('');
    // 縦に並べる：メモ→文字起こし。横に並べる：左に文字起こし、右にメモ
    if (memoHtml || txHtml) body += `<div class="cols"><div class="col-tx">${txHtml}</div><div class="col-memo">${memoHtml}</div></div>`;
  }
  const pp = printPrefs();
  const size = PHOTO_SIZES.some((p) => p.k === pp.photo) ? pp.photo : 'm';
  const side = pp.side ? ' side' : '';
  const wrap = pp.wrap ? ' wrap' : '';
  const opts = PHOTO_SIZES.map((p) => `<label><input type="radio" name="sz" value="${p.k}" ${p.k === size ? 'checked' : ''}> ${p.label}</label>`).join('');
  const css = PHOTO_SIZES.map((p) => `body.sz-${p.k} .memo img{width:${p.print}%}` + (p.print <= 50 ? `body.sz-${p.k}.wrap .memo img{float:left;margin:4px 16px 8px 0}` : '')).join('\n');
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${esc(L.title || '講義メモ')}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700&display=swap"><style>
body{font-family:"BIZ UDPGothic","Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;max-width:760px;margin:0 auto;padding:0 16px 24px;line-height:1.75;color:#111}
h1{font-size:22px;margin:20px 0 4px}h2{font-size:17px;border-bottom:2px solid #1B3A6B;padding-bottom:4px;margin-top:28px;clear:both}h3{font-size:14px;color:#1B3A6B;clear:both}
.meta{color:#444;margin:0}.pre{white-space:pre-wrap}.t{margin:2px 0;font-size:13px}.t span,.tm{color:#666;margin-right:10px;font-family:monospace}
.memos::after{content:"";display:block;clear:both}.memo{margin:6px 0}
.memo img{display:block;height:auto;margin:6px 0;border:1px solid #ccc;border-radius:4px;break-inside:avoid}
${css}
.bar{position:sticky;top:0;background:#F2F6FA;border-bottom:1px solid #D9E2EC;margin:0 -16px;padding:10px 16px;display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:14px;z-index:1}
.bar button{font:inherit;border:1.5px solid #1B3A6B;background:#1B3A6B;color:#fff;border-radius:999px;padding:5px 16px;cursor:pointer}
.bar .hint{color:#555;font-size:12px}
@media print{.bar{display:none}body{max-width:none}}
.cols{display:flex;flex-direction:column}.col-memo{order:1}.col-tx{order:2}
body.side{max-width:1180px}
body.side .cols{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:28px;align-items:start}
body.side .col-tx{order:0}body.side .col-memo{order:0;border-left:1px solid #D9E2EC;padding-left:20px}
body.side .col-tx:empty,body.side .col-memo:empty{display:none}
@page{margin:14mm}
</style></head><body class="sz-${size}${wrap}${side}">
<div class="bar"><b>写真の大きさ</b>${opts}<label><input type="checkbox" id="wrap"${wrap ? ' checked' : ''}> 写真の横に文字を回り込ませる</label><span class="hint">（小・中のとき）</span><label><input type="checkbox" id="side"${side ? ' checked' : ''}> 文字起こしとメモを横に並べる</label><span class="hint">（印刷は横向きがおすすめ）</span><span style="flex:1"></span><button type="button" id="pr">印刷・PDFに保存</button></div>
${body}
<script>
function save(k,v){try{var o=JSON.parse(localStorage.getItem('${PRINT_KEY}')||'{}');o[k]=v;localStorage.setItem('${PRINT_KEY}',JSON.stringify(o))}catch(e){}}
document.querySelectorAll('input[name=sz]').forEach(function(r){r.onchange=function(){document.body.className=document.body.className.replace(/sz-\\w+/,'sz-'+r.value);save('photo',r.value)}});
document.getElementById('wrap').onchange=function(e){document.body.classList.toggle('wrap',e.target.checked);save('wrap',e.target.checked)};
document.getElementById('side').onchange=function(e){document.body.classList.toggle('side',e.target.checked);save('side',e.target.checked)};
document.getElementById('pr').onclick=function(){print()};
<\/script></body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  const w = window.open(url, '_blank');
  if (!w && btn) {
    // ポップアップが止められたときは、押して開くリンクを出す
    btn.parentElement.querySelector('.print-link')?.remove();
    btn.insertAdjacentHTML('afterend', `<a class="btn primary print-link" href="${url}" target="_blank" rel="noopener">印刷画面を開く</a>`);
    toast('「印刷画面を開く」を押してください');
  }
}
async function exportFolder() {
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
  const L = S.lec; const name = `${L.date || ''}_${safeName(L.title)}`;
  try {
    const root = await dir.getDirectoryHandle(name, { create: true });
    const write = async (d, fname, data) => { const fh = await d.getFileHandle(fname, { create: true }); const w = await fh.createWritable(); await w.write(data); await w.close(); };
    await write(root, '講義メモ.md', toMarkdown());
    const imgs = S.memos.filter((m) => m.imageId);
    if (imgs.length) { const d = await root.getDirectoryHandle('写真', { create: true }); for (const m of imgs) { const b = await store.getImage(m.imageId); if (b) await write(d, `${hms(m.at).replace(/:/g, '')}_${m.id.slice(-4)}.jpg`, b); } }
    const au = S.audio.filter((a) => a.status !== 'deleted');
    if (au.length) {
      const d = await root.getDirectoryHandle('録音', { create: true });
      const names = Object.fromEntries(sessions().map((s) => [s.id, s.name]));
      for (const a of au) await write(d, `${hms(a.startAt).replace(/:/g, '')}_${safeName(names[a.sessionId])}.${ext(a.mime)}`, await store.getAudioBlob(a.id));
    }
    toast(`「${name}」フォルダに書き出しました`);
    await markExported();
  } catch (e) { toast('書き出せませんでした：' + errMsg(e), 5000); }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch { /* 使えない */ }
    ta.remove(); return ok;
  }
}
async function importFile(file) {
  try {
    const b = JSON.parse(await file.text());
    const r = await store.importBackup(b);
    await loadList(r.id); await openLecture(r.id);
    toast(r.replaced ? 'バックアップで置き換えました' : 'バックアップを読み込みました');
  } catch (e) { toast('読み込めませんでした：' + errMsg(e), 5000); }
}

/* ============================== 設定画面 ============================== */
async function openSettings() {
  const info = await store.storageInfo();
  S.list = await store.listLectures();
  const left = S.list.filter(unexported);
  const pct = info.quota ? Math.min(100, (info.usage / info.quota) * 100) : 0;
  $('#storeInfo').innerHTML = `
    <div>使用量：<b class="mono">${mb(info.usage)}</b>${info.quota ? ` ／ 使える目安 ${mb(info.quota)}` : ''}</div>
    <div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div style="margin-top:6px">${info.persisted ? '✅ ブラウザに記録を消されにくい設定になっています' : '⚠ ブラウザが容量不足のときに記録を消すことがあります。「アプリとして入れる」と消されにくくなります'}</div>
    <div style="margin-top:6px">${left.length ? `⚠ まだ書き出していない講義が <b>${left.length}</b> 件あります（講義の一覧で「●」の付いたもの）` : '✓ すべての講義を書き出し済みです'}</div>
    <div class="sumrow" style="margin-top:8px"><label class="btn">バックアップを読み込む<input type="file" id="importIn" accept=".json,application/json" hidden></label></div>`;
  refreshInstall();
  renderAudioIn();
  $('#looks').innerHTML = LOOKS.map((l) => `<label class="look"><input type="radio" name="look" value="${l.k}" ${currentLook() === l.k ? 'checked' : ''}><span class="sw ${l.k}"></span><span><b>${l.label}</b><small>${l.note}</small></span></label>`).join('');
  const cur = ls('engine') || 'none';
  $('#inGain').value = gainDb(); $('#inGainV').textContent = dbLabel(gainDb());
  const le = liveEngine(), wm = whisperModel();
  $('#liveEngines').innerHTML = [
    { k: 'web', label: 'ブラウザの音声認識', note: 'すぐに文字が出ます。マイクの音だけを聞きます。話している音声は Google（Edge では Microsoft）に送られます' },
    { k: 'whisper', label: 'このPCのAI（Whisper）', note: '「音声の入力」で選んだ音（画面共有の音声も）を、30秒〜1分ほど遅れて文字にします。音声は外に送りません。初めて使うときに、AIのデータをダウンロードします' },
  ].map((e) => `<label><input type="radio" name="liveEngine" value="${e.k}" ${le === e.k ? 'checked' : ''}><span>${e.label}<small>${e.note}</small></span></label>`).join('');
  $('#whisperRow').hidden = le !== 'whisper';
  $('#whisperModel').innerHTML = W_MODELS.map((m) => `<option value="${m.id}" ${m.id === wm ? 'selected' : ''}>${m.label}　${m.size}</option>`).join('');
  $('#whisperNote').textContent = (W_MODELS.find((m) => m.id === wm) || {}).note || '';
  $('#engines').innerHTML = ENGINES.map((e) => `<label class="${e.ready ? '' : 'off'}"><input type="radio" name="engine" value="${e.k}" ${cur === e.k ? 'checked' : ''} ${e.ready ? '' : 'disabled'}><span>${e.label}<small>${e.note}</small></span></label>`).join('');
  renderEngineOpts();
  $('#version').textContent = `版：${APP_VERSION}`;
  $('#settings').hidden = false;
}

/* 清書の方法ごとの設定（AIの大きさ・APIキー） */
const hqModel = () => ls('hqModel') || (navigator.gpu ? 'onnx-community/whisper-large-v3-turbo' : 'Xenova/whisper-small');
function renderEngineOpts() {
  const e = ls('engine') || 'none', box = $('#engineOpts');
  if (e === 'browser') box.innerHTML = `<label class="small">清書に使うAIの大きさ <select id="hqModel" class="mini-sel">${W_MODELS.map((m) => `<option value="${m.id}" ${m.id === hqModel() ? 'selected' : ''}>${m.label}　${m.size}</option>`).join('')}</select></label>
    <p class="small muted">清書はあとから時間をかけてできるので、リアルタイムより大きいAIがおすすめです。</p>`;
  else if (e === 'openai') box.innerHTML = `<label class="small">OpenAI の APIキー <input type="password" id="openaiKey" autocomplete="off" placeholder="sk-…" value="${esc(ls('openaiKey') || '')}"></label>
    <label class="small">モデル <select id="openaiModel" class="mini-sel">${OPENAI_MODELS.map((m) => `<option ${m === (ls('openaiModel') || 'whisper-1') ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    <p class="small muted">whisper-1 は、細かい時刻が付きます。キーはこのブラウザの中にだけ保存します。共用のPCでは入れないでください。</p>`;
  else if (e === 'gemini') box.innerHTML = `<label class="small">Gemini の APIキー <input type="password" id="geminiKey" autocomplete="off" placeholder="AIza…" value="${esc(ls('geminiKey') || '')}"></label>
    <label class="small">モデル <input id="geminiModel" value="${esc(ls('geminiModel') || GEMINI_DEFAULT)}" style="width:14em"></label>
    <p class="small muted">キーはこのブラウザの中にだけ保存します。共用のPCでは入れないでください。無料の枠では、送った音声が Google のサービス改善に使われることがあります。</p>`;
  else box.innerHTML = '';
}
document.addEventListener('input', (e) => {
  const id = e.target.id;
  if (['openaiKey', 'geminiKey', 'geminiModel'].includes(id)) ls(id, e.target.value.trim() || null);
});

/* 清書を実行する（一度に1つのセッション） */
let SEI = null;   // { sid, ctrl, state }
const ENGINE_NAME = { browser: 'このPCのAI', openai: 'OpenAI', gemini: 'Gemini' };
async function runSeisho(sid) {
  if (SEI) { toast('ほかのセッションを清書しています。終わってから押してください'); return; }
  const engine = ls('engine') || 'none';
  if (engine === 'none') { toast('先に ⚙ 設定の「清書の方法」で、清書のしかたを選んでください', 5000); openSettings(); return; }
  const s = sessions().find((x) => x.id === sid); if (!s) return;
  const au = S.audio.filter((a) => a.sessionId === sid && a.status !== 'deleted' && a.bytes > 0).sort((a, b) => a.startAt - b.startAt);
  if (!au.length) { toast('このセッションには録音がありません'); return; }
  if (engine !== 'browser' && !confirm(`${ENGINE_NAME[engine]} に、このセッションの録音（${mb(au.reduce((n, a) => n + a.bytes, 0))}）を送って清書します。よろしいですか？`)) return;
  const opts = engine === 'browser' ? { model: hqModel() }
    : engine === 'openai' ? { key: ls('openaiKey'), model: ls('openaiModel') || 'whisper-1' }
      : { key: ls('geminiKey'), model: ls('geminiModel') || GEMINI_DEFAULT };
  SEI = { sid, ctrl: new AbortController(), state: '準備しています…' };
  const show = (t) => { SEI.state = t; const el = document.querySelector(`[data-seistate="${sid}"]`); if (el) el.textContent = t; };
  renderSummary(); keepAwake();
  try {
    const rows = await seisho(au.map((a) => ({ id: a.id, startAt: a.startAt, endAt: a.endAt, blob: () => store.getAudioBlob(a.id) })),
      { engine, ...opts, signal: SEI.ctrl.signal, onState: show });
    if (!rows.length) throw new Error('文字にできる声がありませんでした');
    const saved = await store.replaceTranscript(S.lec.id, sid, 'hq', rows.map((r) => ({ ...r, sessionId: sid })));
    S.transcript = S.transcript.filter((t) => !(t.source === 'hq' && t.sessionId === sid)).concat(saved).sort((a, b) => a.at - b.at);
    S.lec = await store.updateLecture(S.lec.id, { hq: { ...(S.lec.hq || {}), [sid]: { at: Date.now(), engine, model: opts.model } }, changedAt: Date.now() });
    refreshOption();
    toast(`「${s.name}」を清書しました（${saved.length}行）`, 4000);
  } catch (e) {
    toast(e.name === 'AbortError' ? '清書をやめました' : '清書できませんでした：' + errMsg(e), 8000);
  } finally {
    SEI = null; if (!recording()) releaseWake(); renderSummary();
  }
}
// 清書が済んだセッションの録音を消す（場所をあける）
async function deleteHqAudio(sid) {
  const au = S.audio.filter((a) => a.sessionId === sid && a.status !== 'deleted');
  const size = au.reduce((n, a) => n + (a.bytes || 0), 0);
  if (!au.length) return;
  if (!confirm(`このセッションの録音（${au.length}区切り・${mb(size)}）を消します。消した録音は元に戻せません。\n清書した文字・メモ・写真は残ります。よろしいですか？`)) return;
  for (const a of au) await store.deleteAudio(a.id);
  const d = await store.getLecture(S.lec.id); S.audio = d.audio;
  await markChanged(); renderSummary();
  toast(`録音を消しました（${mb(size)} あきました）`);
}

/* ============================== 画面を消さない・閉じるときの確認 ============================== */
let wake = null;
async function keepAwake() { try { if (navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => (wake = null)); } } catch { /* 使えない環境 */ } }
function releaseWake() { try { wake && wake.release(); } catch { /* 済み */ } wake = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && recording()) keepAwake(); });
window.addEventListener('beforeunload', (e) => { if (recording() || SEI) { e.preventDefault(); e.returnValue = ''; } });

/* ============================== 操作 ============================== */
$('#newBtn').addEventListener('click', newLecture);
$('#newBtn2').addEventListener('click', newLecture);
$('#lecSel').addEventListener('change', (e) => openLecture(e.target.value));
$('#metaBox').addEventListener('input', saveMeta);
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { S.tab = b.dataset.tab; render(); } });
$('#types').addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (b) { S.type = b.dataset.type; renderTypes(); $('#memoIn').focus(); } });
$('#memoIn').addEventListener('input', autosize);
$('#memoIn').addEventListener('keydown', (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addMemo(); } });
$('#memoBtn').addEventListener('click', addMemo);
$('#imgIn').addEventListener('change', (e) => { addImages([...e.target.files]); e.target.value = ''; });
$('#settingsBtn').addEventListener('click', openSettings);
$('#inGain').addEventListener('input', (e) => { const db = +e.target.value; ls('inGainDb', db); Gain.set(db); if (testGain) testGain.gain.value = Math.pow(10, db / 20); $('#inGainV').textContent = dbLabel(db); });
$('#linkBtn').addEventListener('click', openLink);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal:not([hidden])').forEach((m) => (m.hidden = true)); });
document.addEventListener('keydown', (e) => { if (e.altKey && (e.key === 's' || e.key === 'S') && Screen.stream) { e.preventDefault(); Screen.shot(false); } });
document.addEventListener('keydown', (e) => { if (e.altKey && /^[1-5]$/.test(e.key) && S.lec) { e.preventDefault(); S.type = TYPES[+e.key - 1].k; renderTypes(); } });
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length && S.lec) { e.preventDefault(); addImages(files); }
});
let dragN = 0;
document.addEventListener('dragenter', (e) => { if (S.lec && e.dataTransfer?.types.includes('Files')) { dragN++; $('#drop').hidden = false; } });
document.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('#drop').hidden = true; } });
document.addEventListener('dragover', (e) => { if (S.lec) e.preventDefault(); });
document.addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; $('#drop').hidden = true; if (S.lec) addImages([...e.dataTransfer.files]); });

document.addEventListener('change', async (e) => {
  if (e.target.id === 'importIn' && e.target.files[0]) { $('#settings').hidden = true; importFile(e.target.files[0]); e.target.value = ''; return; }
  if (e.target.name === 'engine') { ls('engine', e.target.value); renderEngineOpts(); if (S.tab === 'vSum') renderSummary(); return; }
  if (e.target.id === 'hqModel' || e.target.id === 'openaiModel') { ls(e.target.id, e.target.value); return; }
  if (e.target.name === 'liveEngine') { ls('liveEngine', e.target.value); $('#whisperRow').hidden = e.target.value !== 'whisper'; toast(recording() ? '次にセッションを始めるときから、この方法を使います' : 'この方法で文字起こしします'); renderTranscript(); return; }
  if (e.target.id === 'whisperModel') { ls('whisperModel', e.target.value); $('#whisperNote').textContent = (W_MODELS.find((m) => m.id === e.target.value) || {}).note || ''; return; }
  if (e.target.name === 'look') { setLook(e.target.value); return; }
  if (e.target.id === 'audioIn') { ls('audioIn', e.target.value || null); toast(recording() ? '次のセッションから、この音声の入力を使います' : 'この音声の入力を使います'); return; }
  if (e.target.id === 'autoShot') { Screen.setAuto(e.target.checked); if (e.target.checked) toast('スライドが変わったら自動で撮ります'); return; }
  const sn = e.target.closest('[data-sname]');
  if (sn && sn.tagName === 'INPUT') {
    const s = sessions().find((x) => x.id === sn.dataset.sname); if (!s) return;
    s.name = sn.value.trim() || s.name; await saveLecture({ sessions: S.lec.sessions }); renderTranscript();
  }
});

let player = null;
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-close]') || e.target.classList.contains('modal') || e.target.closest('#imgModal')) { e.target.closest('.modal').hidden = true; return; }
  const img = e.target.closest('.fi img'); if (img && img.src) { $('#bigImg').src = img.src; $('#imgModal').hidden = false; return; }
  const del = e.target.closest('[data-del]'); if (del) { removeMemo(del.dataset.del); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const sid = b.dataset.sid, s = sessions().find((x) => x.id === sid);
  switch (b.dataset.act) {
    case 'start': startSession(); break;
    case 'whisper-prep': {
      b.disabled = true; $('#whisperState').textContent = '準備しています…';
      const w = whisper(), keep = w.onState;
      w.onState = (st) => { if (st.phase === 'loading') $('#whisperState').textContent = st.text; keep(st); };
      w.prepare(whisperModel()).then((d) => { $('#whisperState').textContent = `準備できました（${d === 'webgpu' ? 'WebGPU で速く動きます' : d === 'wasm' ? 'ふつうの計算で動きます' : d}）`; if (!recording()) setInd('Speech', '', '文字起こし（PCのAI）準備済み'); })
        .catch((err) => { $('#whisperState').textContent = '準備できませんでした：' + errMsg(err); })
        .finally(() => { b.disabled = false; w.onState = keep; });
      break;
    }
    case 'resume': await Rec.start(); Live.start(); keepAwake(); renderCtrl(); break;
    case 'next': nextSession(); break;
    case 'end': endSession(); break;
    case 'seisho': runSeisho(sid); break;
    case 'seisho-stop': if (SEI) SEI.ctrl.abort(); break;
    case 'delaudio-hq': deleteHqAudio(sid); break;
    case 'prompt': {
      const chars = +document.querySelector(`[data-chars="${sid}"]`).value || 400;
      toast((await copyText(buildPrompt(s, chars))) ? 'コピーしました。AIに貼り付けてください' : 'コピーできませんでした');
      break;
    }
    case 'savesum': {
      const text = document.querySelector(`[data-sum="${sid}"]`).value;
      const chars = +document.querySelector(`[data-chars="${sid}"]`).value || 400;
      await saveLecture({ summaries: { ...(S.lec.summaries || {}), [sid]: { text, chars, savedAt: Date.now() } } });
      await markChanged();
      toast('要約を保存しました'); renderSummary();
      break;
    }
    case 'nudge-folder': S.tab = 'vSum'; render(); if (window.showDirectoryPicker) exportFolder(); break;
    case 'nudge-backup': S.tab = 'vSum'; render(); break;
    case 'nudge-close': $('#nudge').hidden = true; break;
    case 'share': Screen.stream ? Screen.stop() : Screen.start(); break;
    case 'shot': Screen.shot(false); break;
    case 'paste': openPaste(); break;
    case 'paste-ok': doPaste(false); break;
    case 'paste-more': doPaste(true); break;
    case 'region': openRegion(); break;
    case 'region-ok': saveRegion(regionDrag && regionDrag.r); break;
    case 'region-all': saveRegion(null); break;
    case 'share-stop': Screen.stop(); break;
    case 'level-test': testLevel(); break;
    case 'open-settings': openSettings(); break;
    case 'diag': {
      const tr = Rec.stream && Rec.stream.getAudioTracks()[0];
      const info = {
        版: APP_VERSION + (store.PREVIEW ? '（試験版）' : ''), ブラウザ: navigator.userAgent,
        文字起こしの方法: liveEngine(), 音声の入力の設定: audioSourceId() || '既定のマイク',
        記録中: recording(), 録音: Rec.active ? `${tr ? `${tr.label || '(名前なし)'}・${tr.readyState}` : '音源なし'}` : '停止',
        画面の共有: Screen.stream ? `あり・音声${Screen.audioTrack() ? 'あり' : 'なし'}` : 'なし',
        音声の点: $('#tSpeech').textContent, WebGPU: !!navigator.gpu,
        PCのAI: WL ? WL.status() : 'まだ使っていません',
      };
      const text = '講義メモ 状態の記録\n' + JSON.stringify(info, null, 1).replace(/^[{}]$/gm, '').replace(/"/g, '');
      const box = $('#diagOut'); box.hidden = false; box.value = text; box.scrollIntoView({ block: 'nearest' });
      toast((await copyText(text)) ? '状態をコピーしました。チャットに貼り付けてください（下にも表示しています）' : 'コピーできませんでした。下に表示した文を、スクリーンショットで送ってください', 6000);
      break;
    }
    case 'audio-refresh':
      try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch { /* 許可されなかった */ }
      renderAudioIn(); break;
    case 'install': $('#settings').hidden = true; doInstall(); break;
    case 'link-stop': stopLink(); $('#linkModal').hidden = true; toast('スマホとの連携を止めました'); break;
    case 'link-new': newLinkId(); break;
    case 'link-copy': toast((await copyText($('#qrUrl').textContent)) ? 'URLをコピーしました' : 'コピーできませんでした'); break;
    case 'md': download(new Blob([toMarkdown()], { type: 'text/markdown' }), `${S.lec.date}_${safeName(S.lec.title)}.md`); break;
    case 'print': printView(b); break;
    case 'folder': exportFolder(); break;
    case 'backup': {
      b.disabled = true;
      try {
        const data = await store.exportBackup(S.lec.id, { withAudio: $('#bkAudio').checked });
        download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `講義メモ_バックアップ_${S.lec.date}_${safeName(S.lec.title)}.json`);
        await markExported();
      } catch (err) { toast('書き出せませんでした：' + errMsg(err)); }
      b.disabled = false;
      break;
    }
    case 'dellec': {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'もう一度押すと完全に削除'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'この講義を削除'; }, 4000); break; }
      if (recording()) { toast('記録中は削除できません'); break; }
      await store.deleteLecture(S.lec.id); S.lec = null; ls('lastLecture', null);
      await loadList(); render(); toast('削除しました');
      break;
    }
    case 'play': {
      const blob = await store.getAudioBlob(b.dataset.aid);
      if (player) { player.pause(); URL.revokeObjectURL(player.src); player.remove(); }
      player = document.createElement('audio'); player.controls = true; player.src = URL.createObjectURL(blob);
      b.replaceWith(player); player.play().catch(() => {});
      break;
    }
    case 'dlaudio': {
      const a = S.audio.find((x) => x.id === b.dataset.aid);
      download(await store.getAudioBlob(a.id), `${S.lec.date}_${safeName(b.dataset.sname)}_${b.dataset.n}.${ext(a.mime)}`);
      break;
    }
  }
});

/* ============================== アプリとして入れる・更新の知らせ ============================== */
let installEvt = null;
const isApp = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
function browserKind() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'other';
}
const INSTALL_STEPS = [
  { k: 'chrome', t: 'パソコンの Chrome', d: 'アドレスバーの右端にある「インストール」のマーク（画面に下向き矢印）を押す。見当たらないときは、右上の「⋮」→「キャスト、保存、共有」→「ページをアプリとしてインストール」。' },
  { k: 'edge', t: 'パソコンの Edge', d: 'アドレスバーの右端にある「アプリを利用できます」のマークを押す。見当たらないときは、右上の「…」→「アプリ」→「このサイトをアプリとしてインストール」。' },
  { k: 'android', t: 'Android の Chrome', d: '右上の「⋮」→「アプリをインストール」（または「ホーム画面に追加」）。' },
  { k: 'ios', t: 'iPhone・iPad の Safari', d: '下の「共有」ボタン（四角から上向き矢印）→「ホーム画面に追加」。※iPhoneでは文字起こしは使えません。スマホ連携の送信用にどうぞ。' },
];
async function doInstall() {
  if (installEvt) {
    installEvt.prompt();
    const r = await installEvt.userChoice.catch(() => null);
    installEvt = null;
    if (r && r.outcome === 'accepted') { store.requestPersist(); toast('アプリとして登録しました'); refreshInstall(); }
    return;
  }
  const here = browserKind();
  $('#installSteps').innerHTML = INSTALL_STEPS.map((s) => `<div class="step${s.k === here ? ' here' : ''}"><b>${s.k === here ? 'いま使っている：' : ''}${s.t}</b>${s.d}</div>`).join('')
    + (here === 'other' ? '<p class="note">いまのブラウザでは、アプリとして登録できないことがあります。Chrome か Edge で開いてください。</p>' : '');
  $('#installModal').hidden = false;
}
function refreshInstall() {
  const app = isApp();
  $('#installBtn').hidden = app;
  const row = $('#installRow');
  if (row) row.innerHTML = app ? '<span class="state ok">✓ アプリとして開いています</span>'
    : '<button class="btn primary" type="button" data-act="install">⬇ アプリにする</button><span class="small muted">専用の窓で開け、記録も消されにくくなります</span>';
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; store.requestPersist(); refreshInstall(); });
$('#installBtn').addEventListener('click', doInstall);
refreshInstall();
applyView();

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !store.PREVIEW) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const ask = (w) => { $('#updateBar').hidden = false; $('#updateBtn').onclick = () => { if (recording()) { toast('記録中は更新できません。セッションを終了してから押してください'); return; } w.postMessage('skipWaiting'); }; };
    if (reg.waiting && navigator.serviceWorker.controller) ask(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ask(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

/* ============================== タブは1つで ============================== */
if (navigator.locks) {
  navigator.locks.request(store.PREVIEW ? 'kougi-memo-preview-tab' : 'kougi-memo-tab', { ifAvailable: true }, (lock) => {
    if (!lock) { toast('このアプリは別のタブでも開いています。記録が混ざらないよう、タブは1つで使ってください', 8000); return; }
    return new Promise(() => {});   // このタブが開いている間は持ち続ける
  });
}

/* ============================== 試験版の表示 ============================== */
if (store.PREVIEW) {
  document.body.insertAdjacentHTML('afterbegin', `<div class="update preview-bar">試験版です（版 ${APP_VERSION}）。公開前の新しい機能を試すためのもので、記録は本番とは別に保存されます（本番の記録は見えません・変わりません）。</div>`);
  document.title = '【試験版】' + document.title;
}

/* ============================== 起動 ============================== */
(async () => {
  try {
    const n = await store.recoverAudio();
    await loadList();
    const id = ls('lastLecture');
    if (id && S.list.some((l) => l.id === id)) await openLecture(id); else render();
    if (n) toast(`前回、途中で閉じた録音を${n}区切り分保存しました`);
  } catch (e) { toast('起動できませんでした：' + errMsg(e), 8000); render(); }
  if (!SR) setInd('Speech', 'warn', '音声認識 未対応（Chrome か Edge で開いてください）');
})();
