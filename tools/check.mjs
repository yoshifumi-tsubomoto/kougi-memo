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
await step('セッションを始めて録音が保存される', async () => {
  await p.click('[data-act="start"]');
  await p.waitForSelector('[data-act="next"]');
  await p.waitForTimeout(5500);           // テスト用の区切り（4秒）をまたぐ
  await p.click('[data-act="end"]');
  await p.waitForTimeout(800);
  await p.click('[data-tab="vSum"]');
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
await step('バックアップを書き出して読み込める', async () => {
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act="backup"]')]);
  const path = await dl.path();
  await p.click('#settingsBtn');
  await p.setInputFiles('#importIn', path);
  await p.waitForTimeout(800);
  if ((await p.locator('#feed .fi').count()) !== 1) throw new Error('読み込み後のメモの数が違う');
});

await browser.close();
server.close();
if (errors.length) { console.log('\n' + errors.join('\n')); process.exit(1); }
console.log('\nすべて OK');
