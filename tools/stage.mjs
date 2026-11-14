// 試験版を作る：指定したブランチの docs/ を、docs/preview/ に写す
// 使い方（main で実行）: node tools/stage.mjs <ブランチ名>
//   → https://yoshifumi-tsubomoto.github.io/kougi-memo/preview/ で公開前に試せる
//   試験版は本番と別の保存場所（IndexedDB: kougi-memo-preview）を使い、サービスワーカーも登録しない
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync, writeFileSync } from 'node:fs';
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
rmSync(tmp, { recursive: true });
console.log(`試験版を作りました: ${dest}（${branch} @ ${rev}）`);
