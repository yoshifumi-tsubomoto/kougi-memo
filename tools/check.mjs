// 画面を実際にブラウザで開き、スクリプトのエラーがないかを確認する（Playwrightが必要）
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { resolve } from 'node:path';

const browser = await chromium.launch();
let failed = false;
for (const page of ['preview/index.html', 'preview/phone.html']) {
  const p = await browser.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('file://' + resolve(page));
  await p.waitForTimeout(800);
  if (page.endsWith('index.html')) {
    // 新しい講義を作り、メモを1件追加してみる
    await p.click('#newBtn2');
    await p.waitForSelector('#metaBox:not([hidden])');
    await p.fill('#fTitle', 'テスト講義');
    await p.fill('#memoIn', 'テストのメモ');
    await p.press('#memoIn', 'Enter');
    await p.waitForTimeout(300);
    const n = await p.locator('#feed .fi').count();
    if (n !== 1) errors.push(`メモが表示されない（${n}件）`);
    await p.click('[data-tab="vSum"]');
    await p.waitForTimeout(200);
  }
  console.log(errors.length ? `NG ${page}\n  ` + errors.join('\n  ') : `OK ${page}`);
  if (errors.length) failed = true;
}
await browser.close();
process.exit(failed ? 1 : 0);
