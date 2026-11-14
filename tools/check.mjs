// 画面を実際にブラウザで開いて、基本の流れが動くかを確かめる（Playwright が必要）
// 仮のマイクを使うので、録音の保存まで確認できる。音声認識は確認できない。
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const server = await serve(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ permissions: ['microphone'] });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push('スクリプトのエラー：' + e.message));
/** テスト用の JPEG（at を渡すと撮影時刻 EXIF を入れる） */
async function jpegWithExif(page, at) {
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#0F5257'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.font = '28px sans-serif'; g.fillText('スライド', 40, 110); return c.toDataURL('image/jpeg').split(',')[1]; });
  const jpg = Buffer.from(b64, 'base64');
  if (!at) return jpg;
  const t = Buffer.alloc(64);
  t.write('II', 0); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, 8); t.writeUInt16LE(0x8769, 10); t.writeUInt16LE(4, 12); t.writeUInt32LE(1, 14); t.writeUInt32LE(26, 18); t.writeUInt32LE(0, 22);
  t.writeUInt16LE(1, 26); t.writeUInt16LE(0x9003, 28); t.writeUInt16LE(2, 30); t.writeUInt32LE(20, 32); t.writeUInt32LE(44, 36); t.writeUInt32LE(0, 40);
  t.write(at + '\0', 44, 'latin1');
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const head = Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]);
  return Buffer.concat([jpg.subarray(0, 2), head, body, jpg.subarray(2)]);
}
const step = async (name, fn) => { try { await fn(); console.log('OK ', name); } catch (e) { errors.push(`${name}：${e.message.split('\n')[0]}`); console.log('NG ', name); } };

await p.goto(base + '?test=1');
await step('はじめの画面が出る', () => p.waitForSelector('#welcome:not([hidden])', { timeout: 5000 }));
await step('講義を作れる', async () => {
  await p.click('#newBtn2');
  await p.waitForSelector('#metaBox:not([hidden])');
  await p.fill('#fTitle', 'テスト講義');
  await p.fill('#fSpeaker', 'テスト講師');
});
await step('メモを追加できる', async () => {
  await p.click('[data-type="key"]');
  await p.fill('#memoIn', '大事なところ');
  await p.press('#memoIn', 'Enter');
  await p.waitForSelector('#feed .fi.key');
});
await step('セッションを始めて録音が保存され、書き出しの案内が出る', async () => {
  await p.click('[data-act="start"]');
  await p.waitForSelector('[data-act="next"]');
  await p.waitForTimeout(5500);           // テスト用の区切り（4秒）をまたぐ
  await p.click('[data-act="end"]');
  await p.waitForSelector('#nudge:not([hidden])', { timeout: 3000 });
  if (!(await p.locator('#lecSel option:checked').textContent()).includes('未書き出し')) throw new Error('一覧に「未書き出し」の印が出ない');
  await p.waitForTimeout(800);
  await p.click('[data-tab="vSum"]');
  await p.waitForSelector('.state.warn');
  await p.waitForSelector('details.audio');
  const n = await p.locator('.alist li').count();
  if (n < 2) throw new Error(`録音の区切りが ${n} 件`);
});
await step('再読み込みしても記録が残る', async () => {
  await p.reload();
  await p.waitForSelector('#metaBox:not([hidden])');
  if ((await p.inputValue('#fTitle')) !== 'テスト講義') throw new Error('タイトルが消えた');
  if ((await p.locator('#feed .fi').count()) !== 1) throw new Error('メモが消えた');
});
await step('Markdown を保存できる', async () => {
  await p.click('[data-tab="vSum"]');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act="md"]')]);
  const text = await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
  if (!text.includes('# テスト講義') || !text.includes('【要点】大事なところ')) throw new Error('中身が足りない');
});
await step('バックアップを書き出すと「書き出し済み」になり、読み込める', async () => {
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act="backup"]')]);
  const path = await dl.path();
  await p.waitForSelector('.state.ok', { timeout: 3000 });
  if ((await p.locator('#lecSel option:checked').textContent()).includes('未書き出し')) throw new Error('書き出した後も「未書き出し」のまま');
  await p.click('#settingsBtn');
  await p.setInputFiles('#importIn', path);
  await p.waitForTimeout(800);
  if ((await p.locator('#feed .fi').count()) !== 1) throw new Error('読み込み後のメモの数が違う');
});

await step('デザインを切り替えて、開き直しても保たれる', async () => {
  await p.click('#settingsBtn');
  await p.click('.look:has(input[value="peach"])');
  if ((await p.evaluate(() => document.documentElement.dataset.look)) !== 'peach') throw new Error('切り替わらない');
  await p.reload();
  await p.waitForSelector('#metaBox:not([hidden])');
  if ((await p.evaluate(() => document.documentElement.dataset.look)) !== 'peach') throw new Error('開き直すと元に戻る');
  await p.click('#settingsBtn');
  await p.click('.look:has(input[value="aurora"])');
  await p.click('#settings [data-close]');
});
await step('メモを追加した直後に打った文字が消えない', async () => {
  await p.fill('#memoIn', '一つ目');
  await p.press('#memoIn', 'Enter');
  await p.type('#memoIn', '続き');
  await p.waitForTimeout(400);
  if ((await p.inputValue('#memoIn')) !== '続き') throw new Error('打った文字が消えた：' + await p.inputValue('#memoIn'));
  await p.fill('#memoIn', '');
});
await step('メモ欄が自動で下までスクロールする', async () => {
  for (let i = 0; i < 25; i++) { await p.fill('#memoIn', 'スクロールの確認 ' + i); await p.press('#memoIn', 'Enter'); }
  await p.waitForTimeout(300);
  const gap = await p.$eval('#fScroll', (e) => e.scrollHeight - e.scrollTop - e.clientHeight);
  if (gap > 4) throw new Error('いちばん下まで行かない（残り ' + gap + 'px）');
});
await step('広く表示・文字起こしをたたむ（開き直しても保たれる）', async () => {
  await p.click('[data-tab="vLive"]');
  await p.click('#focusBtn');
  if (await p.isVisible('#metaBox')) throw new Error('講義の情報が隠れない');
  if (!(await p.evaluate(() => !!document.querySelector('header #ctrl')))) throw new Error('セッション操作が上の帯に入らない');
  await p.click('#txClose');
  if (await p.isVisible('#tScroll')) throw new Error('文字起こしがたためない');
  await p.reload();
  await p.waitForSelector('#focusBtn:not([hidden])');
  if (await p.isVisible('#metaBox') || await p.isVisible('#tScroll')) throw new Error('開き直すと元に戻る');
  await p.click('#txOpen'); await p.click('#focusBtn');
  if (!(await p.isVisible('#metaBox')) || !(await p.isVisible('#tScroll'))) throw new Error('元に戻せない');
  if (await p.evaluate(() => !!document.querySelector('header #ctrl'))) throw new Error('セッション操作が元の場所に戻らない');
});
await step('アプリにする方法を案内できる', async () => {
  await p.click('#installBtn');
  await p.waitForSelector('#installModal:not([hidden]) .step.here');
  await p.click('#installModal [data-close]');
});
await step('写真の撮影時刻を読んで、その時刻の位置に並べる', async () => {
  await p.click('[data-tab="vLive"]');
  await p.setInputFiles('#imgIn', { name: 'slide.jpg', mimeType: 'image/jpeg', buffer: await jpegWithExif(p, '2026:11:14 09:30:00') });
  await p.waitForSelector('#feed .fi.photo');
  const row = await p.locator('#feed .fi.photo').first().textContent();
  if (!row.includes('09:30:00') || !row.includes('撮影時刻で配置')) throw new Error('撮影時刻で並んでいない：' + row.trim().slice(0, 60));
  if ((await p.$eval('#feed img', (i) => getComputedStyle(i).float)) !== 'left') throw new Error('写真の横に文字が回り込まない');
});

await step('拡大した写真を、写真を押しても Esc でも閉じられる', async () => {
  await p.click('#feed img');
  await p.waitForSelector('#imgModal:not([hidden])');
  await p.click('#bigImg');
  if (await p.isVisible('#imgModal')) throw new Error('写真を押しても閉じない');
  await p.click('#feed img');
  await p.keyboard.press('Escape');
  if (await p.isVisible('#imgModal')) throw new Error('Esc で閉じない');
});
await step('写真の大きさを変えられる（メモ欄・印刷）', async () => {
  await p.selectOption('#photoSize', 'l');
  const w = await p.$eval('#feed img', (i) => i.getBoundingClientRect().width);
  if (Math.abs(w - 300) > 2) throw new Error('メモ欄の写真が大きくならない：' + w);
  await p.selectOption('#photoSize', 'xl');
  if ((await p.$eval('#feed img', (i) => getComputedStyle(i).float)) !== 'none') throw new Error('幅いっぱいで回り込みが止まらない');
  await p.selectOption('#photoSize', 'm');
  await p.click('[data-tab="vSum"]');
  const [pop] = await Promise.all([p.waitForEvent('popup'), p.click('[data-act="print"]')]);
  await pop.waitForFunction(() => !!document.querySelector('input[name=sz]')?.onchange);
  await pop.click('.bar input[value="s"]');
  if ((await pop.$eval('.memo img', (i) => getComputedStyle(i).float)) !== 'left') throw new Error('印刷画面で回り込まない');
  await pop.click('.bar input[value="l"]');
  if ((await pop.$eval('.memo img', (i) => getComputedStyle(i).float)) !== 'none') throw new Error('大のときに回り込んでしまう');
  await pop.click('#side');
  if ((await pop.$eval('.cols', (c) => getComputedStyle(c).display)) !== 'grid') throw new Error('横に並ばない');
  if (!(await pop.$('h1'))) throw new Error('印刷画面が真っ白');
  await pop.close();
  // 設定を覚えている（もう一度開くと「大」「横に並べる」のまま）
  const [pop2] = await Promise.all([p.waitForEvent('popup'), p.click('[data-act="print"]')]);
  await pop2.waitForSelector('h1');
  if (!(await pop2.isChecked('.bar input[value="l"]')) || !(await pop2.isChecked('#side'))) throw new Error('印刷の設定を覚えていない');
  await pop2.close();
  // ポップアップが止められたときは、押して開くリンクが出る
  await p.evaluate(() => { window.__open = window.open; window.open = () => null; });
  await p.click('[data-act="print"]');
  await p.waitForSelector('.print-link');
  const [pop3] = await Promise.all([p.waitForEvent('popup'), p.click('.print-link')]);
  await pop3.waitForSelector('h1');
  await pop3.close();
  await p.evaluate(() => { window.open = window.__open; });
  await p.click('[data-tab="vLive"]');
});
await step('清書の試験ページが開き、録音を選べる', async () => {
  const b = await ctx.newPage();
  b.on('pageerror', (e) => errors.push('試験ページのエラー：' + e.message));
  await b.goto(base + 'bench.html');
  await b.waitForFunction(() => !document.querySelector('#chunks').textContent.includes('探しています'));
  // 1秒の無音の WAV を選ぶ
  const wav = Buffer.alloc(44 + 32000);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + 32000, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  await b.setInputFiles('#file', { name: 'test.wav', mimeType: 'audio/wav', buffer: wav });
  if (!(await b.textContent('#picked')).includes('test.wav')) throw new Error('音声を選べない');
  await b.close();
});
await step('広く表示のとき、状態の点に短い文字が付く', async () => {
  await p.click('#focusBtn');
  const t = await p.$eval('.ind > span[data-short="録音"]', (e) => getComputedStyle(e, '::after').content);
  await p.click('#focusBtn');
  if (!t.includes('録音')) throw new Error('文字が付かない：' + t);
});
// スマホとの連携（手元に仲介サーバーを立てて、PCとスマホの2つの画面で確かめる）
let peerServer = null;
try {
  const req = createRequire(import.meta.url);
  const { ExpressPeerServer } = req('peer');
  const express = req('express');
  const http = await import('node:http');
  const app = express();
  peerServer = http.createServer(app);
  app.use('/', ExpressPeerServer(peerServer, { path: '/' }));   // 'mount' のときに仲介の道筋ができる
  await new Promise((r) => peerServer.listen(0, '127.0.0.1', r));
} catch (e) { peerServer = null; console.log('-- スマホ連携の確認は省略（npm install で peer を入れると確かめられます）', e.message); }
if (peerServer) {
  const pp = peerServer.address().port;
  await step('スマホから写真とメモが届く', async () => {
    await p.goto(base + `?test=1&peer=127.0.0.1:${pp}`);
    await p.waitForSelector('#metaBox:not([hidden])');
    await p.click('#linkBtn');
    await p.waitForFunction(() => document.querySelector('#linkState').textContent.includes('待って'), null, { timeout: 8000 });
    const url = await p.textContent('#qrUrl');
    if (!(await p.locator('#qr svg').count())) throw new Error('QRコードが出ない');
    const ph = await ctx.newPage();
    ph.on('pageerror', (e) => errors.push('スマホ画面のエラー：' + e.message));
    await ph.setViewportSize({ width: 390, height: 800 });
    await ph.goto(url);
    await ph.waitForFunction(() => document.querySelector('#pill').textContent.includes('つながって'), null, { timeout: 10000 });
    await p.waitForFunction(() => document.querySelector('#tLink').textContent.includes('1台'), null, { timeout: 5000 });
    await ph.fill('#memo', 'スライド12の図');
    await ph.setInputFiles('#cam', { name: 'cam.jpg', mimeType: 'image/jpeg', buffer: await jpegWithExif(ph, null) });
    await ph.waitForSelector('.st.ok', { timeout: 10000 });
    await ph.click('[data-t="q"]'); await ph.fill('#memo', 'スマホからの質問'); await ph.click('#sendMemo');
    await ph.waitForFunction(() => document.querySelectorAll('.st.ok').length === 2, null, { timeout: 10000 });
    await p.waitForSelector('#feed .fi.photo .t:has-text("スライド12の図")', { timeout: 5000 });
    await p.waitForSelector('#feed .fi.q .t:has-text("スマホからの質問")', { timeout: 5000 });
    await ph.screenshot({ path: 'tools/.last-phone.png' }).catch(() => {});
    await ph.close();
  });
  peerServer.closeAllConnections?.(); peerServer.close();
}

await browser.close();
server.close();
if (errors.length) { console.log('\n' + errors.join('\n')); process.exit(1); }
console.log('\nすべて OK');
process.exit(0);
