// スマホとPCを直接つなぐ（WebRTC。つなぐ手続きだけ PeerJS の無料サーバーを使う）
// 写真やメモは端末から端末へ暗号化して届く。直接つながらないネットワークでは、
// PeerJS の中継サーバーを経由するが、暗号化されたままなので中身は見えない。
import { loadScript } from './media.js';

/** 自動確認のときだけ、手元の仲介サーバーを使う（?peer=localhost:9000） */
export function peerOptions() {
  const p = new URLSearchParams(location.search).get('peer');
  if (!p) return { debug: 0 };
  const [host, port] = p.split(':');
  return { debug: 0, host, port: Number(port), path: '/', secure: false, config: { iceServers: [] } };
}
export const randomLinkId = () => 'kougimemo-' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
export const phoneUrl = (id) => {
  const u = new URL('phone.html', location.href);
  const test = new URLSearchParams(location.search).get('peer');   // 自動確認のときだけ引き継ぐ
  u.search = test ? '?peer=' + encodeURIComponent(test) : '';
  u.hash = id;
  return u.href;
};

/**
 * PC側：スマホからの接続を待つ
 * handlers: onPhoto(msg) / onMemo(msg) は保存が済んだら resolve する Promise を返す
 *           onStatus({state, phones, error}) / getInfo() → {title, session}
 */
export async function startHost(linkId, handlers) {
  await loadScript('vendor/peerjs.min.js');
  const conns = new Set();
  let peer = null, stopped = false, retries = 0;
  const status = (state, error) => handlers.onStatus({ state, phones: conns.size, error });

  const open = () => {
    peer = new window.Peer(linkId, peerOptions());
    peer.on('open', () => { retries = 0; status('waiting'); });
    peer.on('connection', (conn) => {
      conn.on('open', () => { conns.add(conn); status('waiting'); conn.send({ t: 'info', ...handlers.getInfo() }); });
      conn.on('data', async (m) => {
        if (!m || typeof m !== 'object') return;
        try {
          if (m.t === 'photo') await handlers.onPhoto(m);
          else if (m.t === 'memo') await handlers.onMemo(m);
          else return;
          conn.send({ t: 'ack', id: m.id });
        } catch (e) { conn.send({ t: 'nack', id: m.id, error: String(e && e.message || e) }); }
      });
      const gone = () => { conns.delete(conn); status('waiting'); };
      conn.on('close', gone); conn.on('error', gone);
    });
    peer.on('disconnected', () => { if (!stopped) { status('reconnecting'); setTimeout(() => !stopped && !peer.destroyed && peer.reconnect(), 2000); } });
    peer.on('error', (e) => {
      if (stopped) return;
      // ページを開き直した直後は、前の登録が少し残っていることがある
      if (e.type === 'unavailable-id' && retries++ < 5) { peer.destroy(); setTimeout(open, 3000); status('reconnecting'); return; }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) { status('reconnecting', e.type); if (peer.destroyed) setTimeout(open, 5000); return; }
      status('error', e.type);
    });
  };
  open();

  return {
    broadcast(msg) { conns.forEach((c) => { try { c.send(msg); } catch { /* 切れている */ } }); },
    stop() { stopped = true; conns.forEach((c) => c.close()); conns.clear(); if (peer) peer.destroy(); status('off'); },
    get phones() { return conns.size; },
  };
}

/** QRコードの SVG */
export async function qrSvg(text) {
  await loadScript('vendor/qrcode.js');
  const qr = window.qrcode(0, 'M');
  qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
}
