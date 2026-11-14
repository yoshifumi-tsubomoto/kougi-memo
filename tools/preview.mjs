// GASに上げる前に、画面だけをブラウザで確認するための書き出し。
// 使い方: npm run preview → preview/index.html と preview/phone.html ができる
// （保存先は仮のもの。データはページを閉じると消える）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const boot = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
mkdirSync('preview', { recursive: true });
const pages = [
  ['src/Index.html', 'preview/index.html', { lectureId: '', appUrl: '', engine: 'none' }],
  ['src/Phone.html', 'preview/phone.html', { lectureId: 'preview', appUrl: '', engine: 'none' }],
];
for (const [src, out, b] of pages) {
  writeFileSync(out, readFileSync(src, 'utf8').replace('<?!= boot ?>', boot(b)));
  console.log('wrote', out);
}
