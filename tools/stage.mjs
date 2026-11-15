// 試験版を作る：指定したブランチの docs/ を、docs/preview/ に写す
// 使い方（main で実行）: node tools/stage.mjs <ブランチ名>
//   → https://yoshifumi-tsubomoto.github.io/kougi-memo/preview/ で公開前に試せる
//   試験版は本番と別の保存場所（IndexedDB: kougi-memo-preview）を使い、サービスワーカーも登録しない
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const branch = process.argv[2];
if (!branch) { console.error('使い方: node tools/stage.mjs <ブランチ名>'); process.exit(1); }
const tmp = mkdtempSync(join(tmpdir(), 'kougi-stage-'));
const tar = execFileSync('git', ['archive', '--format=tar', branch, 'docs']);
execFileSync('tar', ['-x', '-C', tmp], { input: tar });
const dest = 'docs/preview';
if (existsSync(dest)) rmSync(dest, { recursive: true });
cpSync(join(tmp, 'docs'), dest, { recursive: true, filter: (src) => !src.includes(join(tmp, 'docs', 'preview')) });
rmSync(join(dest, '.nojekyll'), { force: true });
const rev = execFileSync('git', ['rev-parse', '--short', branch]).toString().trim();
writeFileSync(join(dest, 'STAGED.txt'), `branch: ${branch}\ncommit: ${rev}\n`);
// 試験版の版の番号に、作った時刻を付ける（どの試験版を開いているか、画面で分かるように）
const jst = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
const stamp = `${jst.month}/${jst.day} ${jst.hour}:${jst.minute}`;   // 日本の時刻
const appJs = join(dest, 'js', 'app.js');
writeFileSync(appJs, readFileSync(appJs, 'utf8').replace(/(APP_VERSION = ')([^']+)(')/, `$1$2 試験${stamp}$3`));
rmSync(tmp, { recursive: true });
console.log(`試験版を作りました: ${dest}（${branch} @ ${rev}）`);
