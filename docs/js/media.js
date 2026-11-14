// 写真の下ごしらえ（PCとスマホの両方で使う）

/** 長辺 max px の JPEG に縮小する */
export function resizeImage(file, max = 1600, quality = 0.82) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? res(b) : rej(new Error('画像を変換できません'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('この形式の画像は読み込めません（iPhone の HEIC は、JPEG で書き出してください）')); };
    img.src = url;
  });
}

/** 写真の中に記録された「撮影した時刻」（EXIF）を読む。なければ null */
export async function exifTime(file) {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return null;   // JPEG ではない
    let o = 2;
    while (o + 10 < v.byteLength) {
      const marker = v.getUint16(o), len = v.getUint16(o + 2);
      if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966) {   // "Exif"
        const t = o + 10;
        const le = v.getUint16(t) === 0x4949;
        const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
        const ifd = (start) => {
          const out = {}; const n = u16(start);
          for (let i = 0; i < n; i++) { const e = start + 2 + i * 12; out[u16(e)] = { count: u32(e + 4), off: e + 8 }; }
          return out;
        };
        const str = (ent) => { const p = ent.count > 4 ? t + u32(ent.off) : ent.off; let s = ''; for (let i = 0; i < ent.count - 1; i++) s += String.fromCharCode(v.getUint8(p + i)); return s; };
        const ifd0 = ifd(t + u32(t + 4));
        let s = null;
        if (ifd0[0x8769]) { const ex = ifd(t + u32(ifd0[0x8769].off)); if (ex[0x9003]) s = str(ex[0x9003]); }   // DateTimeOriginal
        if (!s && ifd0[0x0132]) s = str(ifd0[0x0132]);                                                          // DateTime
        const m = s && s.match(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
        return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
      }
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      o += 2 + len;
    }
  } catch { /* 読めなければ時刻なし */ }
  return null;
}

/** <script> を必要になったときに読み込む */
const loaded = {};
export function loadScript(src) {
  if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('部品を読み込めません：' + src));
    document.head.appendChild(s);
  });
  return loaded[src];
}
