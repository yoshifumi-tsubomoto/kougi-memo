// 保存先：ブラウザの中（IndexedDB）
// 画面からはこのファイルの関数だけを呼ぶ。Googleドライブ連携版を作るときは、
// 同じ関数を持つ別の保存先を用意して差し替える。

// 試験版（/preview/）は、本番とは別の保存場所を使う（本番の記録をこわさないため）
export const PREVIEW = /\/preview\//.test(location.pathname);
const DB_NAME = PREVIEW ? 'kougi-memo-preview' : 'kougi-memo';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('lectures', { keyPath: 'id' });
      db.createObjectStore('transcript', { keyPath: 'key', autoIncrement: true }).createIndex('lectureId', 'lectureId');
      db.createObjectStore('memos', { keyPath: 'id' }).createIndex('lectureId', 'lectureId');
      db.createObjectStore('images', { keyPath: 'id' }).createIndex('lectureId', 'lectureId');
      db.createObjectStore('audio', { keyPath: 'id' }).createIndex('lectureId', 'lectureId');
      db.createObjectStore('audioParts', { keyPath: ['chunkId', 'seq'] }).createIndex('chunkId', 'chunkId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('別のタブでこのアプリが開いています。閉じてから再読み込みしてください'));
  });
  return dbp;
}

const done = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

async function tx(stores, mode, fn) {
  const db = await open();
  const t = db.transaction(stores, mode);
  const finished = txDone(t);
  const out = await fn(t);
  await finished;
  return out;
}
const all = (t, store, lectureId) => done(t.objectStore(store).index('lectureId').getAll(lectureId));

export const newId = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/* ---------- 講義 ---------- */
export async function listLectures() {
  const ls = await tx(['lectures'], 'readonly', (t) => done(t.objectStore('lectures').getAll()));
  return ls.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
}
export async function createLecture(meta = {}) {
  const now = Date.now();
  const l = { id: newId(), title: '', speaker: '', venue: '', date: today(), sessions: [], summaries: {}, createdAt: now, updatedAt: now, ...meta };
  await tx(['lectures'], 'readwrite', (t) => done(t.objectStore('lectures').put(l)));
  return l;
}
export async function updateLecture(id, patch) {
  return tx(['lectures'], 'readwrite', async (t) => {
    const s = t.objectStore('lectures');
    const l = await done(s.get(id));
    if (!l) throw new Error('講義が見つかりません');
    Object.assign(l, patch, { updatedAt: Date.now() });
    await done(s.put(l));
    return l;
  });
}
export async function getLecture(id) {
  return tx(['lectures', 'transcript', 'memos', 'audio'], 'readonly', async (t) => ({
    lecture: await done(t.objectStore('lectures').get(id)),
    transcript: (await all(t, 'transcript', id)).sort((a, b) => a.at - b.at),
    memos: (await all(t, 'memos', id)).sort((a, b) => a.at - b.at),
    audio: (await all(t, 'audio', id)).sort((a, b) => a.startAt - b.startAt),
  }));
}
export async function deleteLecture(id) {
  const chunks = await tx(['audio'], 'readonly', (t) => all(t, 'audio', id));
  await tx(['lectures', 'transcript', 'memos', 'images', 'audio', 'audioParts'], 'readwrite', async (t) => {
    t.objectStore('lectures').delete(id);
    for (const st of ['transcript', 'memos', 'images', 'audio']) {
      const keys = await done(t.objectStore(st).index('lectureId').getAllKeys(id));
      keys.forEach((k) => t.objectStore(st).delete(k));
    }
    for (const c of chunks) {
      const keys = await done(t.objectStore('audioParts').index('chunkId').getAllKeys(c.id));
      keys.forEach((k) => t.objectStore('audioParts').delete(k));
    }
  });
}

/* ---------- 文字起こし ---------- */
export async function addTranscript(lectureId, row) {
  const r = { lectureId, sessionId: row.sessionId || '', at: row.at, text: row.text, source: row.source || 'live', audioId: row.audioId || '' };
  r.key = await tx(['transcript'], 'readwrite', (t) => done(t.objectStore('transcript').add(r)));
  return r;
}

// 貼り付けた文字起こしをまとめて入れる。replaceSessionId を渡すと、そのセッションに前に取り込んだものを消してから入れる。updates は文を直す行
export async function importTranscript(lectureId, rows, replaceSessionId, updates = []) {
  return tx(['transcript'], 'readwrite', async (t) => {
    const st = t.objectStore('transcript');
    let removed = 0;
    if (replaceSessionId !== undefined) {
      const old = await done(st.index('lectureId').getAll(lectureId));
      for (const r of old) if (r.source === 'import' && r.sessionId === replaceSessionId) { st.delete(r.key); removed++; }
    }
    for (const u of updates) { const r = await done(st.get(u.key)); if (r) { r.text = u.text; st.put(r); } }
    const out = [];
    for (const row of rows) {
      const r = { lectureId, sessionId: row.sessionId || '', at: row.at, text: row.text, source: 'import', audioId: '' };
      r.key = await done(st.add(r)); out.push(r);
    }
    return { rows: out, removed };
  });
}

/* ---------- メモ・写真 ---------- */
export async function addMemo(lectureId, memo) {
  if (memo.id && !memo.imageId) { const dup = await tx(['memos'], 'readonly', (t) => done(t.objectStore('memos').get(memo.id))); if (dup) return dup; }
  const m = { id: memo.id || newId(), lectureId, sessionId: memo.sessionId || '', at: memo.at || Date.now(), type: memo.type || 'memo',
    text: memo.text || '', imageId: memo.imageId || '', from: memo.from || 'pc', createdAt: Date.now() };
  await tx(['memos'], 'readwrite', (t) => done(t.objectStore('memos').put(m)));
  return m;
}
export async function updateMemo(id, patch) {
  return tx(['memos'], 'readwrite', async (t) => {
    const s = t.objectStore('memos');
    const m = await done(s.get(id));
    if (m) { Object.assign(m, patch); await done(s.put(m)); }
    return m;
  });
}
export async function deleteMemo(id) {
  await tx(['memos', 'images'], 'readwrite', async (t) => {
    const m = await done(t.objectStore('memos').get(id));
    if (m && m.imageId) t.objectStore('images').delete(m.imageId);
    t.objectStore('memos').delete(id);
  });
}
export async function addImage(lectureId, { blob, at, sessionId, text, id, from }) {
  if (id) { const dup = await tx(['memos'], 'readonly', (t) => done(t.objectStore('memos').get(id))); if (dup) return dup; }   // 送り直しで同じものが来たとき
  const imageId = newId();
  await tx(['images'], 'readwrite', (t) => done(t.objectStore('images').put({ id: imageId, lectureId, blob, at })));
  return addMemo(lectureId, { id, at, sessionId, type: 'photo', text: text || '', imageId, from });
}
export async function getImage(imageId) {
  const r = await tx(['images'], 'readonly', (t) => done(t.objectStore('images').get(imageId)));
  return r ? r.blob : null;
}

/* ---------- 録音 ----------
 * 1区切り（約10分）= audio の1件。録音中は1分ごとの断片を audioParts に足していくので、
 * PCが止まっても失うのは最後の1分だけ。 */
export async function startAudio(meta) {
  const a = { id: newId(), lectureId: meta.lectureId, sessionId: meta.sessionId, startAt: meta.startAt, endAt: null,
    mime: meta.mime || 'audio/webm', bytes: 0, parts: 0, status: 'recording' };
  await tx(['audio'], 'readwrite', (t) => done(t.objectStore('audio').put(a)));
  return a;
}
export async function appendAudioPart(chunkId, seq, blob) {
  await tx(['audio', 'audioParts'], 'readwrite', async (t) => {
    t.objectStore('audioParts').put({ chunkId, seq, blob });
    const s = t.objectStore('audio');
    const a = await done(s.get(chunkId));
    if (a) { a.bytes += blob.size; a.parts = Math.max(a.parts, seq + 1); a.lastAt = Date.now(); s.put(a); }
  });
}
export async function finishAudio(chunkId, endAt) {
  return tx(['audio'], 'readwrite', async (t) => {
    const s = t.objectStore('audio');
    const a = await done(s.get(chunkId));
    if (a) { a.endAt = endAt; a.status = 'saved'; s.put(a); }
    return a;
  });
}
export async function getAudioBlob(chunkId) {
  return tx(['audio', 'audioParts'], 'readonly', async (t) => {
    const a = await done(t.objectStore('audio').get(chunkId));
    const parts = (await done(t.objectStore('audioParts').index('chunkId').getAll(chunkId))).sort((x, y) => x.seq - y.seq);
    return new Blob(parts.map((p) => p.blob), { type: (a && a.mime) || 'audio/webm' });
  });
}
export async function deleteAudio(chunkId) {
  await tx(['audio', 'audioParts'], 'readwrite', async (t) => {
    const keys = await done(t.objectStore('audioParts').index('chunkId').getAllKeys(chunkId));
    keys.forEach((k) => t.objectStore('audioParts').delete(k));
    const s = t.objectStore('audio');
    const a = await done(s.get(chunkId));
    if (a) { a.status = 'deleted'; a.bytes = 0; s.put(a); }
  });
}
/** 前回、録音中のままページが閉じた区切りを「保存済み」に直す */
export async function recoverAudio() {
  return tx(['audio'], 'readwrite', async (t) => {
    const s = t.objectStore('audio');
    const list = await done(s.getAll());
    let n = 0;
    for (const a of list) if (a.status === 'recording') { a.status = 'saved'; a.endAt = a.lastAt || a.startAt; a.recovered = true; s.put(a); n++; }
    return n;
  });
}

/* ---------- 容量 ---------- */
export async function storageInfo() {
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : {};
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  return { usage: est.usage || 0, quota: est.quota || 0, persisted };
}
export async function requestPersist() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

/* ---------- バックアップ ---------- */
const toB64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(blob); });
const fromB64 = (b64, type) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };

export async function exportBackup(id, { withAudio = false } = {}) {
  const d = await getLecture(id);
  const images = [];
  for (const m of d.memos) if (m.imageId) {
    const b = await getImage(m.imageId);
    if (b) images.push({ id: m.imageId, at: m.at, type: b.type, data: await toB64(b) });
  }
  const audio = [];
  for (const a of d.audio) {
    if (a.status === 'deleted') continue;
    const item = { ...a };
    if (withAudio) item.data = await toB64(await getAudioBlob(a.id));
    audio.push(item);
  }
  return { app: 'kougi-memo', format: 1, exportedAt: Date.now(), lecture: d.lecture, transcript: d.transcript.map(({ key, ...r }) => r), memos: d.memos, images, audio };
}

/** バックアップを読み込む。同じ講義がすでにあれば置き換える */
export async function importBackup(b) {
  if (!b || b.app !== 'kougi-memo' || !b.lecture) throw new Error('講義メモのバックアップではありません');
  const id = b.lecture.id;
  const exists = await tx(['lectures'], 'readonly', (t) => done(t.objectStore('lectures').get(id)));
  if (exists) await deleteLecture(id);
  await tx(['lectures', 'transcript', 'memos', 'images', 'audio', 'audioParts'], 'readwrite', (t) => {
    t.objectStore('lectures').put(b.lecture);
    (b.transcript || []).forEach((r) => t.objectStore('transcript').add({ ...r, lectureId: id }));
    (b.memos || []).forEach((m) => t.objectStore('memos').put({ ...m, lectureId: id }));
    (b.images || []).forEach((im) => t.objectStore('images').put({ id: im.id, lectureId: id, at: im.at, blob: fromB64(im.data, im.type || 'image/jpeg') }));
    (b.audio || []).forEach((a) => {
      const { data, ...meta } = a;
      if (data) {
        t.objectStore('audio').put({ ...meta, lectureId: id, status: meta.status === 'recording' ? 'saved' : meta.status, parts: 1 });
        t.objectStore('audioParts').put({ chunkId: a.id, seq: 0, blob: fromB64(data, a.mime || 'audio/webm') });
      }
    });
  });
  return { id, replaced: !!exists };
}
