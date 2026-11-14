/**
 * 講義メモ（GAS版・試作）
 *
 * 構成
 *   Index.html … PC画面（リアルタイム文字起こし・録音・メモ・まとめ）
 *   Phone.html … スマホ画面（写真・メモの送信）
 *   Code.gs    … 保存とサーバー処理（このファイル）
 *
 * データの置き場所（初回アクセス時に自動作成）
 *   マイドライブ/講義メモ_データ/
 *     講義メモ_記録（スプレッドシート：lectures / transcript / memos / audio）
 *     <講義ごとのフォルダ>/audio, images
 *
 * 画面からは API_ に並べた関数だけを呼ぶ。
 * Supabase 版（B）を作るときは、画面側の api オブジェクトを差し替えるだけで済むようにしてある。
 */

const APP_NAME = '講義メモ';
const AUDIO_CHUNK_NOTE = '録音は約10分ごとに区切って保存';

const SHEETS = {
  lectures:   ['id', 'title', 'speaker', 'venue', 'date', 'folderId', 'createdAt', 'updatedAt', 'sessionsJson', 'summariesJson'],
  transcript: ['lectureId', 'sessionId', 'at', 'text', 'source', 'audioId'],
  memos:      ['id', 'lectureId', 'sessionId', 'at', 'type', 'text', 'from', 'imageFileId', 'createdAt', 'deleted'],
  audio:      ['id', 'lectureId', 'sessionId', 'startAt', 'endAt', 'fileId', 'mime', 'bytes', 'status'],
};

/* ============================== 画面 ============================== */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const view = p.view === 'phone' ? 'Phone' : 'Index';
  const t = HtmlService.createTemplateFromFile(view);
  t.boot = safeJson_({
    lectureId: p.id || '',
    appUrl: ScriptApp.getService().getUrl(),
    engine: getEngine_(),
  });
  return t.evaluate()
    .setTitle(view === 'Phone' ? APP_NAME + '（スマホ）' : APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function safeJson_(o) {
  return JSON.stringify(o).replace(/</g, '\\u003c').replace(/ | /g, '');
}

/* ============================== 保存先 ============================== */

let STORE_CACHE_ = null;

function store_() {
  if (STORE_CACHE_) return STORE_CACHE_;
  const props = PropertiesService.getScriptProperties();

  let root = null;
  const rootId = props.getProperty('ROOT_FOLDER_ID');
  if (rootId) { try { root = DriveApp.getFolderById(rootId); if (root.isTrashed()) root = null; } catch (err) { root = null; } }
  if (!root) {
    root = DriveApp.createFolder(APP_NAME + '_データ');
    props.setProperty('ROOT_FOLDER_ID', root.getId());
  }

  let ss = null;
  const ssId = props.getProperty('DATA_SS_ID');
  if (ssId) { try { ss = SpreadsheetApp.openById(ssId); } catch (err) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(APP_NAME + '_記録');
    DriveApp.getFileById(ss.getId()).moveTo(root);
    props.setProperty('DATA_SS_ID', ss.getId());
  }
  Object.keys(SHEETS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  const first = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1) ss.deleteSheet(first);

  STORE_CACHE_ = { root: root, ss: ss };
  return STORE_CACHE_;
}

function sheet_(name) { return store_().ss.getSheetByName(name); }

/** シートを {列名:値} の配列で読む */
function readRows_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const cols = SHEETS[name];
  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  return values.map(function (r, i) {
    const o = { _row: i + 2 };
    cols.forEach(function (c, j) { o[c] = r[j]; });
    return o;
  });
}

function appendRows_(name, objs) {
  if (!objs.length) return;
  const cols = SHEETS[name];
  const values = objs.map(function (o) { return cols.map(function (c) { return o[c] === undefined || o[c] === null ? '' : o[c]; }); });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(name);
    sh.getRange(sh.getLastRow() + 1, 1, values.length, cols.length).setValues(values);
  } finally {
    lock.releaseLock();
  }
}

function updateRow_(name, row, patch) {
  const cols = SHEETS[name];
  const sh = sheet_(name);
  const range = sh.getRange(row, 1, 1, cols.length);
  const cur = range.getValues()[0];
  cols.forEach(function (c, j) { if (Object.prototype.hasOwnProperty.call(patch, c)) cur[j] = patch[c]; });
  range.setValues([cur]);
}

// 先頭を英字にして、スプレッドシートが数値（1e5 など）と誤認しないようにする
function newId_() { return 'k' + Utilities.getUuid().replace(/-/g, '').slice(0, 15); }

function lectureFolder_(lec, sub) {
  const f = DriveApp.getFolderById(lec.folderId);
  if (!sub) return f;
  const it = f.getFoldersByName(sub);
  return it.hasNext() ? it.next() : f.createFolder(sub);
}

function findLecture_(id) {
  const rows = readRows_('lectures');
  for (let i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) return rows[i];
  throw new Error('講義が見つかりません（' + id + '）');
}

function lectureOut_(r) {
  return {
    id: String(r.id), title: r.title, speaker: r.speaker, venue: r.venue,
    date: r.date instanceof Date ? Utilities.formatDate(r.date, 'Asia/Tokyo', 'yyyy-MM-dd') : String(r.date || ''),
    folderId: r.folderId, createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt),
    sessions: parseJson_(r.sessionsJson, []), summaries: parseJson_(r.summariesJson, {}),
  };
}
function parseJson_(s, d) { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } }

/* ============================== API（画面から呼ぶ） ============================== */

function API_listLectures() {
  return readRows_('lectures').map(lectureOut_).sort(function (a, b) {
    return (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt;
  }).map(function (l) { return { id: l.id, title: l.title, speaker: l.speaker, date: l.date, sessions: l.sessions.length }; });
}

function API_createLecture(meta) {
  meta = meta || {};
  const id = newId_();
  const now = Date.now();
  const date = meta.date || Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const folder = store_().root.createFolder(date + '_' + (meta.title || '無題の講義') + '_' + id.slice(0, 4));
  folder.createFolder('audio');
  folder.createFolder('images');
  const row = {
    id: id, title: meta.title || '', speaker: meta.speaker || '', venue: meta.venue || '', date: "'" + date,
    folderId: folder.getId(), createdAt: now, updatedAt: now, sessionsJson: '[]', summariesJson: '{}',
  };
  appendRows_('lectures', [row]);
  return lectureOut_(Object.assign({}, row, { date: date }));
}

/** title / speaker / venue / date / sessions / summaries を更新 */
function API_updateLecture(id, patch) {
  const r = findLecture_(id);
  const p = { updatedAt: Date.now() };
  ['title', 'speaker', 'venue', 'date'].forEach(function (k) { if (k in patch) p[k] = patch[k]; });
  if ('sessions' in patch) p.sessionsJson = JSON.stringify(patch.sessions || []);
  if ('summaries' in patch) p.summariesJson = JSON.stringify(patch.summaries || {});
  if ('date' in patch) p.date = "'" + patch.date; // 日付の自動変換を防ぐ
  updateRow_('lectures', r._row, p);
  if ('title' in patch) {
    try { DriveApp.getFolderById(r.folderId).setName((patch.date || lectureOut_(r).date) + '_' + (patch.title || '無題の講義') + '_' + String(id).slice(0, 4)); } catch (e) {}
  }
  return lectureOut_(Object.assign({}, r, p, { date: String(p.date || r.date).replace(/^'/, '') }));
}

function API_getLecture(id) {
  const lec = lectureOut_(findLecture_(id));
  const transcript = readRows_('transcript').filter(function (t) { return String(t.lectureId) === lec.id; })
    .map(function (t) { return { sessionId: String(t.sessionId), at: Number(t.at), text: String(t.text), source: t.source, audioId: String(t.audioId || '') }; });
  const memos = readRows_('memos').filter(function (m) { return String(m.lectureId) === lec.id && !m.deleted; }).map(memoOut_);
  const audio = readRows_('audio').filter(function (a) { return String(a.lectureId) === lec.id; }).map(audioOut_);
  return { lecture: lec, transcript: transcript, memos: memos, audio: audio, engine: getEngine_(), now: Date.now() };
}

function memoOut_(m) {
  return { id: String(m.id), sessionId: String(m.sessionId || ''), at: Number(m.at), type: m.type, text: String(m.text || ''),
    from: m.from, imageFileId: String(m.imageFileId || ''), createdAt: Number(m.createdAt) };
}
function audioOut_(a) {
  return { id: String(a.id), sessionId: String(a.sessionId), startAt: Number(a.startAt), endAt: Number(a.endAt),
    fileId: String(a.fileId), bytes: Number(a.bytes), status: a.status };
}

/** リアルタイム文字起こしをまとめて追記 rows: [{sessionId, at, text}] */
function API_appendTranscript(lectureId, rows) {
  appendRows_('transcript', (rows || []).map(function (r) {
    return { lectureId: lectureId, sessionId: r.sessionId || '', at: r.at, text: r.text, source: 'live', audioId: '' };
  }));
  return { saved: (rows || []).length };
}

function API_addMemo(lectureId, memo) {
  const m = {
    id: memo.id || newId_(), lectureId: lectureId, sessionId: memo.sessionId || '', at: memo.at || Date.now(),
    type: memo.type || 'memo', text: memo.text || '', from: memo.from || 'pc', imageFileId: '', createdAt: Date.now(), deleted: '',
  };
  appendRows_('memos', [m]);
  return memoOut_(m);
}

function API_updateMemo(id, patch) {
  const rows = readRows_('memos');
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) {
      const p = {};
      ['type', 'text', 'deleted'].forEach(function (k) { if (k in patch) p[k] = patch[k]; });
      updateRow_('memos', rows[i]._row, p);
      return true;
    }
  }
  return false;
}

/** 前回以降に増えたメモ（スマホからの写真・メモ） */
function API_getUpdates(lectureId, since) {
  const memos = readRows_('memos').filter(function (m) {
    return String(m.lectureId) === String(lectureId) && Number(m.createdAt) > Number(since || 0) && !m.deleted;
  }).map(memoOut_);
  return { memos: memos, now: Date.now() };
}

/** スマホ・PCからの写真。dataUrl は画面側で縮小済み（長辺1600px程度のJPEG） */
function API_uploadImage(lectureId, info) {
  const lec = lectureOut_(findLecture_(lectureId));
  const m = String(info.dataUrl).match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (!m) throw new Error('画像の形式が読み取れません');
  const at = info.at || Date.now();
  const name = Utilities.formatDate(new Date(at), 'Asia/Tokyo', 'HHmmss') + '_' + newId_().slice(0, 4) + '.jpg';
  const file = lectureFolder_(lec, 'images').createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name));
  const memo = {
    id: newId_(), lectureId: lectureId, sessionId: info.sessionId || currentSessionId_(lec, at), at: at, type: 'photo',
    text: info.text || '', from: info.from || 'phone', imageFileId: file.getId(), createdAt: Date.now(), deleted: '',
  };
  appendRows_('memos', [memo]);
  return memoOut_(memo);
}

function API_getImage(fileId) {
  const blob = DriveApp.getFileById(fileId).getBlob();
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/** 講義中のセッション（スマホが送ったときにどのセッションか判定） */
function currentSessionId_(lec, at) {
  const ss = lec.sessions || [];
  for (let i = ss.length - 1; i >= 0; i--) {
    if (ss[i].start <= at && (!ss[i].end || at <= ss[i].end)) return ss[i].id;
  }
  return ss.length ? ss[ss.length - 1].id : '';
}

/** スマホ画面用：講義名と、いま進行中のセッション */
function API_getPhoneInfo(lectureId) {
  const lec = lectureOut_(findLecture_(lectureId));
  const open = (lec.sessions || []).filter(function (s) { return !s.end; }).pop();
  return { id: lec.id, title: lec.title, speaker: lec.speaker, session: open || null, now: Date.now() };
}

/** 録音の区切り1つ分を保存 */
function API_saveAudio(lectureId, info) {
  const lec = lectureOut_(findLecture_(lectureId));
  const mime = info.mime || 'audio/webm';
  const ext = /ogg/.test(mime) ? 'ogg' : /mp4|aac/.test(mime) ? 'm4a' : 'webm';
  const name = Utilities.formatDate(new Date(info.startAt), 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '_' + (info.sessionName || 'session') + '.' + ext;
  const bytes = Utilities.base64Decode(info.base64);
  const file = lectureFolder_(lec, 'audio').createFile(Utilities.newBlob(bytes, mime.split(';')[0], name));
  const row = {
    id: info.id || newId_(), lectureId: lectureId, sessionId: info.sessionId, startAt: info.startAt, endAt: info.endAt,
    fileId: file.getId(), mime: mime, bytes: bytes.length, status: 'saved',
  };
  appendRows_('audio', [row]);
  return audioOut_(row);
}

/* ============================== 高精度の文字起こし（清書） ============================== */
/*
 * 清書の方法は「スクリプト プロパティ」の TRANSCRIBE_ENGINE で切り替える。
 *   none   … 清書しない（初期設定。リアルタイムの速報だけ）
 *   openai … OpenAI の文字起こし（OPENAI_API_KEY が必要）
 * 今後追加予定：browser（PC内のWhisper。音声を外に出さない）、gemini
 */

function getEngine_() {
  const p = PropertiesService.getScriptProperties();
  const e = (p.getProperty('TRANSCRIBE_ENGINE') || 'none').toLowerCase();
  if (e === 'openai' && !p.getProperty('OPENAI_API_KEY')) return 'none';
  return e;
}

/** 録音1区切りを清書する。画面から区切りごとに順に呼ぶ（GASの6分制限を避けるため） */
function API_transcribeAudio(audioId) {
  const engine = getEngine_();
  if (engine === 'none') return { ok: false, reason: 'engine_none' };
  const rows = readRows_('audio');
  const a = rows.filter(function (r) { return String(r.id) === String(audioId); })[0];
  if (!a) throw new Error('録音が見つかりません');
  if (a.status === 'transcribed') return { ok: true, skipped: true };

  const blob = DriveApp.getFileById(a.fileId).getBlob();
  let segments;
  if (engine === 'openai') segments = transcribeOpenAI_(blob);
  else return { ok: false, reason: 'engine_unknown' };

  const base = Number(a.startAt);
  appendRows_('transcript', segments.filter(function (s) { return s.text; }).map(function (s) {
    return { lectureId: a.lectureId, sessionId: a.sessionId, at: Math.round(base + s.start * 1000), text: s.text, source: 'hq', audioId: a.id };
  }));
  updateRow_('audio', a._row, { status: 'transcribed' });
  return { ok: true, count: segments.length };
}

function transcribeOpenAI_(blob) {
  const key = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  const res = UrlFetchApp.fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + key },
    payload: { file: blob, model: 'whisper-1', language: 'ja', response_format: 'verbose_json' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('OpenAI: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
  const j = JSON.parse(res.getContentText());
  return (j.segments || [{ start: 0, text: j.text }]).map(function (s) { return { start: s.start || 0, text: String(s.text || '').trim() }; });
}

/** 清書が済んだ講義の音声を削除（ゴミ箱へ） */
function API_deleteAudio(lectureId, onlyTranscribed) {
  let n = 0;
  readRows_('audio').forEach(function (a) {
    if (String(a.lectureId) !== String(lectureId) || a.status === 'deleted') return;
    if (onlyTranscribed && a.status !== 'transcribed') return;
    try { DriveApp.getFileById(a.fileId).setTrashed(true); } catch (e) {}
    updateRow_('audio', a._row, { status: 'deleted' });
    n++;
  });
  return { deleted: n };
}

/* ============================== 出力 ============================== */

/** Google ドキュメントに出力（写真も挿入） */
function API_exportDoc(lectureId, opts) {
  opts = opts || {};
  const data = API_getLecture(lectureId);
  const lec = data.lecture;
  const tz = 'Asia/Tokyo';
  const hm = function (ms) { return Utilities.formatDate(new Date(ms), tz, 'HH:mm'); };
  const doc = DocumentApp.create((lec.date || '') + ' ' + (lec.title || '無題の講義'));
  const body = doc.getBody();
  body.appendParagraph(lec.title || '無題の講義').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph(['講師：' + (lec.speaker || ''), '日付：' + (lec.date || ''), '会場：' + (lec.venue || '')].join('　'));

  const sessions = lec.sessions.length ? lec.sessions : [{ id: '', name: '記録', start: 0 }];
  sessions.forEach(function (s) {
    body.appendParagraph(s.name + (s.start ? '（' + hm(s.start) + '〜' + (s.end ? hm(s.end) : '') + '）' : ''))
      .setHeading(DocumentApp.ParagraphHeading.HEADING1);
    const sum = lec.summaries[s.id];
    if (sum && sum.text) {
      body.appendParagraph('要約').setHeading(DocumentApp.ParagraphHeading.HEADING2);
      String(sum.text).split(/\n/).forEach(function (line) { body.appendParagraph(line); });
    }
    const ms = data.memos.filter(function (m) { return m.sessionId === s.id || (!s.id); }).sort(function (a, b) { return a.at - b.at; });
    if (ms.length) {
      body.appendParagraph('メモ・写真').setHeading(DocumentApp.ParagraphHeading.HEADING2);
      ms.forEach(function (m) {
        const label = { key: '【要点】', q: '【質問】', todo: '【TODO】', quote: '【引用】', photo: '【写真】' }[m.type] || '';
        body.appendListItem(hm(m.at) + ' ' + label + m.text);
        if (m.imageFileId) {
          try {
            const img = body.appendImage(DriveApp.getFileById(m.imageFileId).getBlob());
            const w = img.getWidth(), h = img.getHeight(), max = 400;
            if (w > max) img.setWidth(max).setHeight(Math.round(h * max / w));
          } catch (e) {}
        }
      });
    }
    if (opts.transcript !== false) {
      const hq = data.transcript.filter(function (t) { return t.sessionId === s.id && t.source === 'hq'; });
      const lines = (hq.length ? hq : data.transcript.filter(function (t) { return t.sessionId === s.id && t.source === 'live'; }))
        .sort(function (a, b) { return a.at - b.at; });
      if (lines.length) {
        body.appendParagraph('文字起こし（' + (hq.length ? '清書' : '速報') + '）').setHeading(DocumentApp.ParagraphHeading.HEADING2);
        lines.forEach(function (t) { body.appendParagraph(hm(t.at) + '  ' + t.text); });
      }
    }
  });
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(lec.folderId));
  return { url: doc.getUrl() };
}

/** 動作確認用：エディタで実行するとデータの保存先を作成し、場所をログに出す */
function setup() {
  const s = store_();
  Logger.log('保存フォルダ: ' + s.root.getUrl());
  Logger.log('記録シート: ' + s.ss.getUrl());
}
