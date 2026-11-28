// 画面を実際にブラウザで開いて、基本の流れが動くかを確かめる（Playwright が必要）
// 仮のマイクを使うので、録音の保存まで確認できる。音声認識は確認できない。
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const server = await serve(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing'] });
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
  // 「まとめ・出力」の「バックアップを読み込む」から読み込む
  await p.setInputFiles('#vSum input[data-import]', path);
  await p.waitForFunction(() => /バックアップ/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 });
  await p.waitForTimeout(500);
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
await step('トランスクリプトを貼り付けて、講義の時刻に直して取り込める（置きかえもできる）', async () => {
  await p.click('[data-tab="vLive"]');
  await p.click('[data-act="paste"]');
  await p.waitForSelector('#pasteModal:not([hidden])');
  await p.fill('#pasteBase', '10:00:00');
  await p.fill('#pasteText', '0:05\n地球の内部は\n層に分かれています\n1:02:03\n終わります');
  await p.waitForSelector('#pastePreview:has-text("10:00:05")');
  await p.click('[data-act="paste-ok"]');
  await p.waitForSelector('#tList .tline.imp');
  const got = await p.$$eval('#tList .tline.imp', (els) => els.map((e) => e.textContent));
  if (!got.some((t) => t.includes('10:00:05') && t.includes('地球の内部は層に分かれています'))) throw new Error('時刻か文がちがう：' + got.join(' / '));
  if (!got.some((t) => t.includes('11:02:03'))) throw new Error('1時間をこえる時刻が読めない：' + got.join(' / '));
  await p.click('[data-act="paste"]');
  await p.fill('#pasteBase', '10:00:00');
  // 続きを貼る：重なった行は飛ばし、新しい行だけ足す
  await p.fill('#pasteText', '層に分かれています\n1:02:03\n終わります\n1:02:10\n本当に終わり');
  await p.waitForSelector('#pastePreview:has-text("取り込み済みの1行は飛ばします")');
  await p.click('[data-act="paste-more"]');
  await p.waitForSelector('#tList .tline.imp:has-text("本当に終わり")');
  if ((await p.$$eval('#tList .tline.imp', (els) => els.length)) !== 3) throw new Error('重なりが飛ばされない');
  await p.check('#pasteReplace');
  await p.fill('#pasteText', 'WEBVTT\n\n00:00:10.000 --> 00:00:12.000\n<v 講師>こんにちは');
  await p.click('[data-act="paste-ok"]');
  await p.waitForSelector('#tList .tline.imp:has-text("講師: こんにちは")');
  const n = await p.$$eval('#tList .tline.imp', (els) => els.length);
  if (n !== 1) throw new Error('前に取り込んだ文字が置きかわらない（' + n + '行）');
});
await step('入力の大きさを変え、音の大きさのゲージで確かめられる', async () => {
  await p.click('#settingsBtn');
  await p.fill('#inGain', '6'); await p.dispatchEvent('#inGain', 'input');
  if (!(await p.textContent('#inGainV')).includes('+6dB')) throw new Error('入力の大きさが表示されない');
  await p.click('[data-act="level-test"]');
  await p.waitForFunction(() => { const e = document.querySelector('#lvlTest'); return !e.hidden && parseFloat(e.firstElementChild.style.width) > 0; }, null, { timeout: 5000 });
  await p.click('#settings [data-close]');
  await p.click('[data-tab="vLive"]');
  await p.click('[data-act="start"]');
  await p.waitForSelector('#lvl:not([hidden])');
  await p.waitForFunction(() => parseFloat(document.querySelector('#lvl i').style.width) > 0, null, { timeout: 5000 });   // 録音中のゲージが動く
  await p.waitForTimeout(1500);
  await p.click('[data-act="end"]');
  await p.evaluate(() => localStorage.removeItem('kougi.inGainDb'));
});
await step('清書（OpenAI）で録音を文字にし直し、清書が済んだ録音を消せる', async () => {
  // OpenAI の代わりに、手元で決まった答えを返す（キーや通信は使わない）
  let sent = 0;
  await p.route('https://api.openai.com/v1/audio/transcriptions', async (r) => { sent++; await new Promise((ok) => setTimeout(ok, 1500)); r.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: '清書の試験', segments: [{ start: 0, text: '清書の試験です。' }, { start: 2, text: 'つづきです。' }] }) }); });
  await p.click('#settingsBtn');
  await p.check('input[name="engine"][value="openai"]');
  await p.fill('#openaiKey', 'sk-test');
  await p.click('#settings [data-close]');
  await p.click('[data-tab="vSum"]');
  p.once('dialog', (d) => d.accept());   // 送ってよいかの確認
  await p.locator('[data-act="seisho"]').last().click();
  await p.waitForSelector('.seisho:has-text("清書済み")', { timeout: 30000 });
  if (!sent) throw new Error('OpenAI に送られていない');
  if (!(await p.textContent('#sumWrap')).includes('文字起こし（清書）')) throw new Error('清書した文字が使われない');
  p.once('dialog', (d) => d.accept());
  await p.click('[data-act="delaudio-hq"]');
  await p.waitForFunction(() => !document.querySelector('[data-act="delaudio-hq"]'), null, { timeout: 5000 });
  // 同じキーで要約を作る（OpenAI の代わりに、手元で決まった答えを返す）
  await p.route('https://api.openai.com/v1/chat/completions', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '**要旨**\n* 清書の試験の要約' } }] }) }));
  const accept = (d) => d.accept(); p.on('dialog', accept);
  await p.locator('[data-act="autosum"]').last().click();
  await p.waitForFunction(() => [...document.querySelectorAll('textarea[data-sum]')].some((t) => t.value.includes('・清書の試験の要約')), null, { timeout: 5000 });
  // まだのセッションを、まとめて清書・要約する（録音のある新しいセッションを1つ作ってから）
  await p.click('[data-tab="vLive"]'); await p.click('[data-act="start"]'); await p.waitForTimeout(2500); await p.click('[data-act="end"]');
  await p.waitForTimeout(800); await p.click('[data-tab="vSum"]');
  await p.waitForSelector('[data-act="seisho-all"]');
  await p.click('[data-act="seisho-all"]');
  // 清書の途中で「まとめて要約」を押すと、清書が終わってから作る
  await p.click('[data-act="sum-all"]');
  await p.waitForSelector('.seisho:has-text("清書が終わったら、要約を作ります")', { timeout: 3000 });
  await p.waitForFunction(() => /件のセッションを清書しました|要約を作りました/.test(document.querySelector('#toast').textContent), null, { timeout: 30000 });
  await p.waitForFunction(() => /件のセッションの要約を作りました/.test(document.querySelector('#toast').textContent), null, { timeout: 30000 });
  const sumByTime = await p.evaluate(() => [...document.querySelectorAll('textarea[data-sum]')].filter((t) => t.value.includes('清書の試験の要約')).length);
  if (!sumByTime) throw new Error('清書のあとに要約が作られない');
  if (await p.$('[data-act="seisho-all"]')) throw new Error('まとめて清書したあとも、まだのセッションが残る');
  if (await p.$('[data-act="sum-all"]')) throw new Error('まとめて要約したあとも、まだのセッションが残る');
  p.off('dialog', accept);
  if ((await p.locator('textarea[data-sum]').last().inputValue()).includes('**')) throw new Error('要約に記号が残る');
  await p.unroute('https://api.openai.com/v1/chat/completions');
  await p.unroute('https://api.openai.com/v1/audio/transcriptions');
  await p.evaluate(() => { localStorage.removeItem('kougi.engine'); localStorage.removeItem('kougi.openaiKey'); });
});
await step('要約の方法で Claude を選び、清書しなくても要約を作れる', async () => {
  let body = null;
  await p.route('https://api.anthropic.com/v1/messages', (r) => { body = r.request().postDataJSON(); r.fulfill({ contentType: 'application/json', body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '## 要旨\nClaude の要約です' }] }) }); });
  await p.click('#settingsBtn');
  await p.check('input[name="sumEngine"][value="claude"]');
  await p.fill('#claudeKey', 'sk-ant-test');
  if (await p.isVisible('#openaiKey')) throw new Error('使わないサービスのキーの欄が出る');
  // 方法を切り替えて戻しても、入れたキーは残る
  await p.check('input[name="sumEngine"][value="copy"]');
  await p.check('input[name="sumEngine"][value="claude"]');
  if ((await p.inputValue('#claudeKey')) !== 'sk-ant-test' || !(await p.textContent('[data-keyok="claudeKey"]')).includes('保存済み')) throw new Error('切り替えるとキーが消える');
  await p.click('#settings [data-close]');
  await p.click('[data-tab="vSum"]');
  const accept = (d) => d.accept(); p.on('dialog', accept);
  await p.locator('[data-act="autosum"]').first().click();
  await p.waitForFunction(() => [...document.querySelectorAll('textarea[data-sum]')].some((t) => t.value.includes('Claude の要約です')), null, { timeout: 5000 });
  p.off('dialog', accept);
  if (!body || body.model !== 'claude-haiku-5-5') throw new Error('Claude に送る内容がちがう：' + JSON.stringify(body && body.model));
  await p.unroute('https://api.anthropic.com/v1/messages');
  await p.evaluate(() => { localStorage.removeItem('kougi.sumEngine'); localStorage.removeItem('kougi.claudeKey'); });
});
await step('要約に付いた ** や # の記号を、保存するときに取る', async () => {
  await p.click('[data-tab="vSum"]');
  const box = p.locator('textarea[data-sum]').first();
  await box.fill('## 要約\n**マイログの仕組み**：本人の回答だけ\n* 振り返り');
  await p.locator('[data-act="savesum"]').first().click();
  await p.waitForTimeout(300);
  const v = await box.inputValue();
  if (v.includes('**') || v.includes('#') || !v.includes('・振り返り')) throw new Error('記号が残る：' + v);
});
await step('上の ✎ で講義の名前を変えられる', async () => {
  p.once('dialog', (d) => d.accept('名前を変えた講義'));
  await p.click('#renameBtn');
  await p.waitForFunction(() => document.querySelector('#lecSel option:checked').textContent.includes('名前を変えた講義'));
  if ((await p.inputValue('#fTitle')) !== '名前を変えた講義') throw new Error('タイトルの欄が変わらない');
});
await step('右上に版の番号が出る', async () => {
  const v = await p.textContent('#verBadge');
  if (!/^v\d+\.\d+\.\d+/.test(v)) throw new Error('版の番号が出ない：' + v);
});
await step('講義の一覧で、名前を変え、中身のない講義をまとめて削除できる', async () => {
  await p.click('#newBtn'); await p.waitForTimeout(300);   // 中身のない講義を作る
  await p.click('#lecListBtn');
  await p.waitForSelector('#lecModal:not([hidden]) #lecList li');
  p.once('dialog', (d) => d.accept('一覧で名前を変えた'));
  await p.locator('[data-act="lm-rename"]').last().click();
  await p.waitForSelector('#lecList li:has-text("一覧で名前を変えた")');
  const before = await p.locator('#lecList li').count();
  await p.waitForSelector('#delEmptyBtn:not([hidden])');
  p.once('dialog', (d) => d.accept());
  await p.click('#delEmptyBtn');
  await p.waitForFunction((n) => document.querySelectorAll('#lecList li').length < n, before, { timeout: 5000 });
  // 開いていた（中身のない）講義が消えたので、一覧から別の講義を開く
  await p.locator('[data-act="lm-open"]').first().click();
  await p.waitForSelector('#lecModal', { state: 'hidden' });
  await p.waitForSelector('#metaBox:not([hidden])');
});
await step('前の版で保存した設定を、新しい名前（kougi.）へ写して読める（元も残す）', async () => {
  await p.evaluate(() => localStorage.setItem('pasteOrder', JSON.stringify('after')));
  await p.reload(); await p.waitForSelector('#lecSel');
  await p.click('[data-tab="vLive"]').catch(() => {});
  await p.click('[data-act="paste"]');
  if ((await p.inputValue('#pasteOrder')) !== 'after') throw new Error('前の設定が読めない');
  const moved = await p.evaluate(() => [localStorage.getItem('pasteOrder'), localStorage.getItem('kougi.pasteOrder')]);
  if (moved[1] !== '"after"') throw new Error('新しい名前に写らない：' + moved);
  if (moved[0] === null) throw new Error('前の版のための元の設定まで消えている');
  await p.click('#pasteModal [data-close]');
});
await step('「音声」の点を押すと、音声認識を開き直せる（セッション中だけ）', async () => {
  await p.click('[data-tab="vLive"]');
  await p.click('#speechInd');
  await p.waitForFunction(() => document.querySelector('#toast').textContent.includes('セッション中だけ'));
});
await step('セッションの上限を設定でき、上限になると自動で終了する', async () => {
  await p.click('#settingsBtn');
  await p.waitForFunction(() => document.querySelector('#sessLimit').value === '240', null, { timeout: 3000 }).catch(() => { throw new Error('はじめの上限が4時間でない'); });
  await p.selectOption('#sessLimit', '60');
  await p.click('#settings [data-close]');
  await p.click('[data-tab="vLive"]');
  await p.click('[data-act="start"]');
  await p.waitForSelector('[data-act="end"]');
  // セッションの始まりを1時間前にずらして、上限をこえたことにする
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kougi.sessLimit')); if (v !== 60) throw new Error('保存されない'); });
  await p.evaluate(() => window.__kougiTest && window.__kougiTest.ageSession(61 * 60000));
  await p.waitForSelector('[data-act="end"]', { state: 'detached', timeout: 12000 });
  if (!(await p.textContent('#toast')).includes('上限')) throw new Error('止まったことが知らされない');
  await p.evaluate(() => localStorage.removeItem('kougi.sessLimit'));
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
await step('広く表示のとき、状態の点に短い文字が付く', async () => {
  await p.click('#focusBtn');
  const t = await p.$eval('.ind > span[data-short="録音"]', (e) => getComputedStyle(e, '::after').content);
  await p.click('#focusBtn');
  if (!t.includes('録音')) throw new Error('文字が付かない：' + t);
});
await step('画面を共有して、範囲を決めてスクリーンショットを撮る', async () => {
  await p.click('[data-tab="vLive"]');
  const before = await p.locator('#feed .fi.photo').count();
  await p.click('#shareBtn');
  await p.waitForSelector('#regionModal:not([hidden])', { timeout: 8000 });
  const box = await p.$eval('#regionCanvas', (c) => { const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await p.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.2); await p.mouse.down();
  await p.mouse.move(box.x + box.w * 0.7, box.y + box.h * 0.6, { steps: 5 }); await p.mouse.up();
  await p.click('[data-act="region-ok"]');
  if (!(await p.isVisible('#shareBar'))) throw new Error('共有中の帯が出ない');
  await p.click('[data-act="shot"]');
  await p.waitForFunction((n) => document.querySelectorAll('#feed .fi.photo').length > n, before, { timeout: 5000 });
  const r = await p.evaluate(() => JSON.parse(localStorage.getItem('kougi.shotRegion')));
  if (!r || Math.abs(r.w - 0.5) > 0.05) throw new Error('範囲が保存されない：' + JSON.stringify(r));
  await p.click('[data-act="share-stop"]');
  if (await p.isVisible('#shareBar')) throw new Error('共有をやめられない');
});
await step('音声の入力を選べる（設定）', async () => {
  await p.click('#settingsBtn');
  await p.waitForFunction(() => document.querySelectorAll('#audioIn option').length >= 2);
  await p.selectOption('#audioIn', 'share');
  if ((await p.evaluate(() => JSON.parse(localStorage.getItem('kougi.audioIn')))) !== 'share') throw new Error('保存されない');
  await p.selectOption('#audioIn', '');
  await p.click('#settings [data-close]');
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
