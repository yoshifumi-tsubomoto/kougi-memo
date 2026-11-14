// 講義メモ：画面とその動き
import * as store from './store.js';
import { resizeImage, exifTime } from './media.js';
import { startHost, randomLinkId, phoneUrl, qrSvg } from './link.js';

export const APP_VERSION = '0.4.1';

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
  { k: 'browser', label: '② このPCの中で清書する', note: '音声を外部に送りません。PCの性能によって時間がかかります（準備中）' },
  { k: 'openai', label: '③ OpenAI で清書する', note: '自分のAPIキーが必要です（準備中）' },
  { k: 'gemini', label: '④ Gemini で清書する', note: '自分のAPIキーが必要です（準備中）' },
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
    try { r.start(); } catch { setTimeout(() => { if (this.running) this.open(); }, 1000); }
  },
  stop() { this.running = false; this.lastErr = ''; try { this.rec && this.rec.stop(); } catch { /* 止まっている */ } },
  async push(text, at) {
    const s = sessionAt(at) || openSession();
    const row = await store.addTranscript(S.lec.id, { sessionId: s ? s.id : '', at, text });
    S.transcript.push(row);
    appendTLine(row);
  },
};

/* ============================== 録音 ==============================
 * 約10分で1区切り。1分ごとにブラウザへ書き込むので、止まっても失うのは最大1分 */
const Rec = {
  active: false, stream: null, mr: null, timer: null, mime: '', count: 0,
  async start() {
    if (!window.MediaRecorder) { setInd('Rec', 'warn', '録音 未対応'); return; }
    try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { setInd('Rec', 'warn', '録音 マイクが使えません'); toast('録音を開始できませんでした：' + errMsg(e)); return; }
    this.mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    this.active = true; this.begin();
  },
  async begin() {
    const s = openSession(); if (!s || !this.stream) return;
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
    this.count = 0; setInd('Rec', '', '録音 停止');
  },
};

/* ============================== セッション ============================== */
async function startSession() {
  const s = { id: store.newId(), name: `セッション${sessions().length + 1}`, start: Date.now(), end: null };
  S.lec.sessions = [...sessions(), s];
  Live.start();   // クリックの直後に呼ぶ（マイクの許可のため）
  await saveLecture({ sessions: S.lec.sessions, changedAt: Date.now() });
  refreshOption();
  await Rec.start();
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
  renderCtrl(); renderTranscript(); renderFeed(); renderTypes();
  if (S.tab === 'vSum') renderSummary();
}
function renderCtrl() {
  const s = openSession(), ss = sessions();
  $('#ctrlBtns').innerHTML = s
    ? '<button class="btn" type="button" data-act="next">⏭ 次のセッションへ</button><button class="btn" type="button" data-act="end">■ 終了</button>'
    : `<button class="btn rec" type="button" data-act="start">● ${ss.length ? 'セッションを追加して開始' : 'セッション開始'}</button>`;
  $('#sName').textContent = s ? s.name : ss.length ? `${ss.length}セッション記録済み` : '開始前';
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

const tlineHtml = (t) => `<div class="tline"><span class="tm">${hms(t.at)}</span><span class="tx">${esc(t.text)}</span></div>`;
function renderTranscript() {
  const list = $('#tList');
  const live = S.transcript.filter((t) => t.source !== 'hq');
  if (!live.length) { list.innerHTML = `<p class="empty">${openSession() ? '話し声を待っています…' : '「セッション開始」を押すと、ここに文字起こしが流れます。'}</p>`; list.dataset.last = ''; return; }
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
function scrollBottom(sel) { if (sel === '#tScroll' && !$('#autoScroll').checked) return; const el = $(sel); el.scrollTop = el.scrollHeight; }

function renderFeed(scroll) {
  const items = S.memos.slice().sort((a, b) => a.at - b.at);
  $('#feedCount').textContent = items.length ? `${items.length}件` : '';
  if (!items.length) { $('#feed').innerHTML = '<li class="empty">気づいたことや写真がここに並びます。写真は貼り付け（Ctrl+V）やドラッグでも追加できます。</li>'; return; }
  $('#feed').innerHTML = items.map((m) => {
    const tag = TAGS[m.type];
    return `<li class="fi ${esc(m.type)}"><span class="tm">${hms(m.at)}</span>
      <div class="tx">${tag ? `<span class="tag">${tag}</span>` : ''}<span class="t">${esc(m.text)}</span>${m.from === 'phone' ? '<span class="from"> 📱</span>' : m.from === 'import' ? '<span class="from"> （撮影時刻で配置）</span>' : ''}${m.imageId ? `<img data-img="${esc(m.imageId)}" alt="写真 ${hms(m.at)}">` : ''}</div>
      <button class="x" type="button" data-del="${esc(m.id)}" title="削除" aria-label="削除">×</button></li>`;
  }).join('');
  document.querySelectorAll('#feed img[data-img]').forEach(async (img) => { img.src = await imageUrl(img.dataset.img); });
  if (scroll) scrollBottom('#fScroll');
}
function renderTypes() {
  $('#types').innerHTML = TYPES.map((t, i) => `<button type="button" class="chip${S.type === t.k ? ' on' : ''}" data-type="${t.k}" title="Alt+${i + 1}">${t.label}</button>`).join('');
}
function autosize() {
  const ta = $('#memoIn'); ta.style.height = 'auto';
  const min = parseFloat(getComputedStyle(ta).minHeight) || 0;
  ta.style.height = Math.max(min, Math.min(ta.scrollHeight + 4, window.innerHeight * 0.45)) + 'px';
}

/* ============================== 表示の切り替え（広く表示・文字起こしをたたむ） ============================== */
const VIEW = Object.assign({ focus: false, tx: true }, ls('view') || {});
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
}
function setView(patch) { Object.assign(VIEW, patch); ls('view', VIEW); applyView(); }
$('#focusBtn').addEventListener('click', () => setView({ focus: !VIEW.focus }));
$('#txClose').addEventListener('click', () => setView({ tx: false }));
$('#txOpen').addEventListener('click', () => { setView({ tx: true }); scrollBottom('#tScroll'); });

/* ============================== まとめ・出力 ============================== */
function sessionText(s) {
  const hq = S.transcript.filter((t) => t.sessionId === s.id && t.source === 'hq');
  return { kind: hq.length ? '清書' : '速報', lines: hq.length ? hq : S.transcript.filter((t) => t.sessionId === s.id && t.source !== 'hq') };
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

async function printView() {
  const w = window.open('', '_blank');
  if (!w) { toast('ポップアップが止められました。許可してからもう一度押してください'); return; }
  const L = S.lec; let body = `<h1>${esc(L.title || '無題の講義')}</h1><p>講師：${esc(L.speaker)}　日付：${esc(L.date)}　会場：${esc(L.venue)}</p>`;
  for (const s of exportGroups()) {
    body += `<h2>${esc(s.name)}${range(s)}</h2>`;
    const sum = (L.summaries || {})[s.id]; if (sum && sum.text) body += `<h3>要約</h3><div class="pre">${esc(sum.text)}</div>`;
    const ms = S.memos.filter((m) => inGroup(s, m));
    if (ms.length) {
      body += '<h3>メモ・写真</h3><ul>';
      for (const m of ms) {
        let img = ''; if (m.imageId) { const b = await store.getImage(m.imageId); if (b) img = `<br><img src="${await blobToDataUrl(b)}" alt="">`; }
        body += `<li>${hm(m.at)} ${TAGS[m.type] ? '【' + TAGS[m.type] + '】' : ''}${esc(m.text)}${img}</li>`;
      }
      body += '</ul>';
    }
    const tx = s.outside ? { kind: '速報', lines: S.transcript.filter((t) => inGroup(s, t)) } : sessionText(s);
    if (tx.lines.length) body += `<h3>文字起こし（${tx.kind}）</h3>` + tx.lines.map((t) => `<p class="t"><span>${hm(t.at)}</span>${esc(t.text)}</p>`).join('');
  }
  w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${esc(L.title || '講義メモ')}</title><style>
    body{font-family:"Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;max-width:760px;margin:24px auto;padding:0 16px;line-height:1.7;color:#111}
    h1{font-size:22px}h2{font-size:17px;border-bottom:2px solid #0F5257;padding-bottom:4px;margin-top:28px}h3{font-size:14px;color:#0F5257}
    img{max-width:60%;margin:6px 0;border:1px solid #ccc}.pre{white-space:pre-wrap}.t{margin:2px 0;font-size:13px}.t span{color:#666;margin-right:10px;font-family:monospace}
    li{margin:4px 0}</style></head><body>${body}<script>onload=()=>print()<\/script></body></html>`);
  w.document.close();
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
  $('#looks').innerHTML = LOOKS.map((l) => `<label class="look"><input type="radio" name="look" value="${l.k}" ${currentLook() === l.k ? 'checked' : ''}><span class="sw ${l.k}"></span><span><b>${l.label}</b><small>${l.note}</small></span></label>`).join('');
  const cur = ls('engine') || 'none';
  $('#engines').innerHTML = ENGINES.map((e) => `<label class="${e.ready ? '' : 'off'}"><input type="radio" name="engine" value="${e.k}" ${cur === e.k ? 'checked' : ''} ${e.ready ? '' : 'disabled'}><span>${e.label}<small>${e.note}</small></span></label>`).join('');
  $('#version').textContent = `版：${APP_VERSION}`;
  $('#settings').hidden = false;
}

/* ============================== 画面を消さない・閉じるときの確認 ============================== */
let wake = null;
async function keepAwake() { try { if (navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => (wake = null)); } } catch { /* 使えない環境 */ } }
function releaseWake() { try { wake && wake.release(); } catch { /* 済み */ } wake = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && recording()) keepAwake(); });
window.addEventListener('beforeunload', (e) => { if (recording()) { e.preventDefault(); e.returnValue = ''; } });

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
$('#linkBtn').addEventListener('click', openLink);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal:not([hidden])').forEach((m) => (m.hidden = true)); });
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
  if (e.target.name === 'engine') { ls('engine', e.target.value); return; }
  if (e.target.name === 'look') { setLook(e.target.value); return; }
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
    case 'resume': Live.start(); await Rec.start(); keepAwake(); renderCtrl(); break;
    case 'next': nextSession(); break;
    case 'end': endSession(); break;
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
    case 'install': $('#settings').hidden = true; doInstall(); break;
    case 'link-stop': stopLink(); $('#linkModal').hidden = true; toast('スマホとの連携を止めました'); break;
    case 'link-new': newLinkId(); break;
    case 'link-copy': toast((await copyText($('#qrUrl').textContent)) ? 'URLをコピーしました' : 'コピーできませんでした'); break;
    case 'md': download(new Blob([toMarkdown()], { type: 'text/markdown' }), `${S.lec.date}_${safeName(S.lec.title)}.md`); break;
    case 'print': printView(); break;
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

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
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
  navigator.locks.request('kougi-memo-tab', { ifAvailable: true }, (lock) => {
    if (!lock) { toast('このアプリは別のタブでも開いています。記録が混ざらないよう、タブは1つで使ってください', 8000); return; }
    return new Promise(() => {});   // このタブが開いている間は持ち続ける
  });
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
