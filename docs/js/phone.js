// スマホ側：PCの講義メモに、写真とメモを送る
import { resizeImage, exifTime, loadScript } from './media.js';
import { peerOptions } from './link.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const hms = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const TYPES = [{ k: 'memo', l: 'メモ' }, { k: 'key', l: '要点' }, { k: 'q', l: '疑問・質問' }, { k: 'todo', l: 'TODO' }];

const hostId = decodeURIComponent(location.hash.slice(1));
const items = [];        // 送ったもの（送れていないものは、つながり直したときに送り直す）
let type = 'memo', peer = null, conn = null, connected = false, everConnected = false;

/* ---------- 表示 ---------- */
function pill(cls, text) { $('#pill').innerHTML = `<i class="dot ${cls}"></i><span>${esc(text)}</span>`; }
function help(html) { const h = $('#help'); h.hidden = !html; h.innerHTML = html || ''; }
function renderTypes() { $('#types').innerHTML = TYPES.map((t) => `<button type="button" class="chip${type === t.k ? ' on' : ''}" data-t="${t.k}">${t.l}</button>`).join(''); }
function renderSent() {
  if (!items.length) return;
  $('#sent').innerHTML = items.slice().reverse().map((it) => {
    const st = it.state === 'ok' ? '<span class="st ok">✓ 届きました</span>' : it.state === 'ng' ? '<span class="st ng">届きませんでした</span>' : '<span class="st wait">送信待ち…</span>';
    return `<li>${it.thumb ? `<img src="${it.thumb}" alt="">` : '<span class="ph-thumb">メモ</span>'}
      <div class="ph-item"><div>${esc(it.text || (it.thumb ? '写真' : ''))}</div><div class="small muted mono">${hms(it.at)}</div></div>${st}</li>`;
  }).join('');
}

/* ---------- 送る ---------- */
function flush() {
  if (!connected) return;
  const now = Date.now();
  for (const it of items) if (it.state !== 'ok' && (!it.inflight || now - it.sentAt > 30000)) {
    it.inflight = true; it.sentAt = now; it.state = 'wait';
    try { conn.send(it.msg); } catch { it.inflight = false; }
  }
  renderSent();
}
async function addPhotos(files, fromCamera) {
  const text = $('#memo').value.trim();
  for (const f of files) {
    try {
      const now = Date.now();
      const ex = fromCamera ? null : await exifTime(f);
      const at = ex || (!fromCamera && f.lastModified && Math.abs(now - f.lastModified) < 12 * 3600e3 ? f.lastModified : now);
      const blob = await resizeImage(f);
      const thumb = URL.createObjectURL(await resizeImage(f, 160, 0.7));
      const it = { at, text, thumb, state: 'wait', msg: { t: 'photo', id: newId(), at, text, mime: 'image/jpeg', data: await blob.arrayBuffer() } };
      it.msg.id = it.id = it.msg.id;
      items.push(it);
    } catch (e) { help(esc(e.message)); }
  }
  if (text) $('#memo').value = '';
  renderSent(); flush();
}
function addMemo() {
  const text = $('#memo').value.trim(); if (!text) return;
  const at = Date.now(); const id = newId();
  items.push({ id, at, text, state: 'wait', msg: { t: 'memo', id, at, type, text } });
  $('#memo').value = '';
  renderSent(); flush();
}

/* ---------- つなぐ ---------- */
async function connect() {
  if (!hostId) { $('#title').textContent = 'PCの「📱 スマホ」のQRコードから開いてください'; pill('warn', 'つながっていません'); return; }
  try { await loadScript('vendor/peerjs.min.js'); }
  catch { pill('warn', 'インターネットにつながっていません'); setTimeout(connect, 5000); return; }
  peer = new window.Peer(peerOptions());
  peer.on('open', () => dial());
  peer.on('disconnected', () => { setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000); });
  peer.on('error', (e) => {
    if (e.type === 'peer-unavailable') { pill('warn', 'PCが見つかりません'); help('PCで講義メモが開いていて、「📱 スマホ」の連携が動いているかを確かめてください。PCのページを開き直したときは、QRコードを読み直してください。'); setTimeout(dial, 5000); return; }
    pill('warn', 'つなぎ直しています');
  });
  // しばらくつながらないときの案内
  setTimeout(() => {
    if (!everConnected) help('なかなかつながりません。<br>・PCとスマホが、どちらもインターネットにつながっているか確かめてください<br>・会場のWi-Fiでつながらないときは、スマホをモバイル通信（4G/5G）に切り替えてみてください<br>・それでもだめなときは、ふつうのカメラで撮っておき、あとでPCの「🖼」からまとめて取り込めます（撮った時刻の位置に並びます）');
  }, 20000);
}
function dial() {
  if (!peer || peer.destroyed || peer.disconnected) return;
  pill('warn', 'つないでいます');
  conn = peer.connect(hostId, { reliable: true });
  conn.on('open', () => {
    connected = everConnected = true; help('');
    pill('on', 'PCとつながっています');
    items.forEach((it) => { it.inflight = false; });
    flush();
  });
  conn.on('data', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'info') {
      if (['aurora', 'peach', 'citrus'].includes(m.look)) { document.documentElement.dataset.look = m.look; try { localStorage.setItem('kougi-look', m.look); } catch { /* なくてもよい */ } }
      $('#title').textContent = m.title || '無題の講義'; if (m.session) pill('on', `つながっています・${m.session}`); }
    if (m.t === 'ack' || m.t === 'nack') {
      const it = items.find((x) => x.id === m.id);
      if (it) { it.state = m.t === 'ack' ? 'ok' : 'ng'; it.inflight = false; if (it.state === 'ok') it.msg = null; renderSent(); }
    }
  });
  const lost = () => { if (!connected) return; connected = false; pill('warn', '切れました。つなぎ直しています'); setTimeout(dial, 3000); };
  conn.on('close', lost); conn.on('error', lost);
}

/* ---------- 操作 ---------- */
$('#types').addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (b) { type = b.dataset.t; renderTypes(); } });
$('#cam').addEventListener('change', (e) => { addPhotos([...e.target.files], true); e.target.value = ''; });
$('#lib').addEventListener('change', (e) => { addPhotos([...e.target.files], false); e.target.value = ''; });
$('#sendMemo').addEventListener('click', addMemo);
window.addEventListener('beforeunload', (e) => { if (items.some((i) => i.state !== 'ok')) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !connected && peer && !peer.destroyed) dial(); });
setInterval(() => { if (connected) flush(); }, 10000);   // 返事がないものを送り直す

renderTypes();
connect();
