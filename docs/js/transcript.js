// 貼り付けた文字起こし（トランスクリプト）を読み取る
// 読めるもの：
//   ・放送大学・YouTube などの「トランスクリプト」をコピーしたもの（時刻の行と文の行が交互）
//   ・行の頭に時刻があるもの（「06:47 こちらは…」「[1:02:03] …」）
//   ・Zoom・Teams などの字幕ファイル（.vtt / .srt）
//   ・時刻のない、ただの文章
// 返すもの：{ items: [{ sec, text }], timed, dropped }  sec は動画の始まりからの秒
// 途中から選んでコピーしたとき、時刻のない切れはし（最初または最後）は dropped に数えて省く
// order：時刻が文の 'before'（前）/'after'（後）にあるか。'auto' は最初と最後の行で決める

const TIME = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d{1,3})?`;
const ONLY_TIME = new RegExp(String.raw`^[\[(（]?${TIME}[\])）]?$`);
const HEAD_TIME = new RegExp(String.raw`^[\[(（]?${TIME}[\])）]?\s+(.+)$`);
const CUE = new RegExp(String.raw`^${TIME}\s*-->\s*`);

const toSec = (m) => (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]);
const clean = (s) => s.replace(/<v\s+([^>]+)>/g, '$1: ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
// 日本語どうしは空白を入れずにつなぐ（英数字どうしのときだけ空白を入れる）
const join = (a, b) => (!a ? b : !b ? a : /[A-Za-z0-9.,!?]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? a + ' ' + b : a + b);
const joinAll = (arr) => arr.map(clean).reduce(join, '');

export function parseTranscript(raw, order = 'auto') {
  const text = String(raw || '').replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  if (/-->/.test(text)) return parseCues(text);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { items: [], timed: false };

  const isTime = lines.map((l) => ONLY_TIME.exec(l));
  const nTime = isTime.filter(Boolean).length;

  // 時刻だけの行がある：時刻の行と文の行が交互に並んでいる
  if (nTime >= 2 || (nTime === 1 && lines.length > 1)) {
    // 自動：最初の行が時刻なら「前」、最後の行が時刻なら「後」。どちらでもなければ「前」とみなす
    const timeFirst = order === 'before' || (order === 'auto' && (!!isTime[0] || !isTime[lines.length - 1]));
    const items = [];
    let buf = [], cur = null;
    const flush = (sec) => { const t = joinAll(buf); if (t) items.push({ sec, text: t }); buf = []; };
    let dropped = 0;
    lines.forEach((l, i) => {
      const m = isTime[i];
      if (timeFirst) {
        if (m) { if (cur !== null) flush(cur); else if (buf.length) { dropped++; buf = []; } cur = toSec(m); } else buf.push(l);
      } else if (m) { flush(toSec(m)); cur = toSec(m); } else buf.push(l);
    });
    if (buf.length) { if (timeFirst) flush(cur); else { dropped++; buf = []; } }
    return { items, timed: true, dropped };
  }

  // 行の頭に時刻がある
  const heads = lines.map((l) => HEAD_TIME.exec(l));
  if (heads.filter(Boolean).length >= Math.max(1, lines.length / 2)) {
    const items = [];
    let last = 0;
    lines.forEach((l, i) => {
      const m = heads[i];
      if (m) { last = toSec(m); const t = clean(m[4]); if (t) items.push({ sec: last, text: t }); }
      else if (items.length) items[items.length - 1].text = join(items[items.length - 1].text, clean(l));
      else items.push({ sec: 0, text: clean(l) });
    });
    return { items, timed: true };
  }

  // 時刻がない：段落ごとに分ける
  const paras = text.split(/\n\s*\n/).map((b) => joinAll(b.split('\n'))).filter(Boolean);
  return { items: (paras.length > 1 ? paras : lines.map(clean)).map((t) => ({ sec: 0, text: t })), timed: false };
}

function parseCues(text) {
  const items = [];
  for (const block of text.split(/\n\s*\n/)) {
    const ls = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const i = ls.findIndex((l) => CUE.test(l));
    if (i < 0) continue;
    const t = joinAll(ls.slice(i + 1));
    if (t) items.push({ sec: toSec(CUE.exec(ls[i])), text: t });
  }
  // 字幕は細切れなので、同じ話し手の続きは数秒ごとにまとめる
  const out = [];
  for (const it of items) {
    const p = out[out.length - 1];
    if (p && it.sec - p.sec < 15 && p.text.length < 120 && !/^[^:：]{1,30}[:：]/.test(it.text)) p.text = join(p.text, it.text);
    else out.push({ ...it });
  }
  return { items: out, timed: true };
}
