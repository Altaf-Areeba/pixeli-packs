/* Image -> color-by-number pixel picture. Works in the browser (app "My photo" button)
   and in Node/Playwright (tools/add-pictures.js for picture packs).
   Input: RGBA pixels of any size. Output: { W, H, palette: ['#rrggbb'], data: 'base36 index per cell' } */
(function (root) {
  function convert(rgba, w, h, opts) {
    opts = opts || {};
    const S = opts.size || 32, K = Math.min(opts.colors || 12, 36);
    let W, H;
    if (w >= h) { W = S; H = Math.max(8, Math.round(S * h / w)); } else { H = S; W = Math.max(8, Math.round(S * w / h)); }
    // 1) average every block of source pixels into one cell (transparent -> white)
    const cells = [];
    for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
      const x0 = Math.floor(cx * w / W), x1 = Math.max(x0 + 1, Math.floor((cx + 1) * w / W));
      const y0 = Math.floor(cy * h / H), y1 = Math.max(y0 + 1, Math.floor((cy + 1) * h / H));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4, a = rgba[i + 3] / 255;
        r += rgba[i] * a + 255 * (1 - a); g += rgba[i + 1] * a + 255 * (1 - a); b += rgba[i + 2] * a + 255 * (1 - a); n++;
      }
      cells.push([r / n, g / n, b / n]);
    }
    // 2) k-means colours (deterministic farthest-point start, so the same image gives the same picture)
    const d2 = (p, q) => { const dr = p[0] - q[0], dg = p[1] - q[1], db = p[2] - q[2]; return 0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db; };
    let cent = [cells[0].slice()];
    while (cent.length < K) {
      let best = -1, bi = 0;
      cells.forEach((c, i) => { const m = Math.min(...cent.map(z => d2(c, z))); if (m > best) { best = m; bi = i; } });
      if (best < 60) break;                       // image has fewer real colours than K
      cent.push(cells[bi].slice());
    }
    let lab = new Array(cells.length).fill(0);
    for (let it = 0; it < 12; it++) {
      lab = cells.map(c => { let bi = 0, bd = Infinity; cent.forEach((z, k) => { const d = d2(c, z); if (d < bd) { bd = d; bi = k; } }); return bi; });
      const sum = cent.map(() => [0, 0, 0, 0]);
      cells.forEach((c, i) => { const s = sum[lab[i]]; s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; s[3]++; });
      cent = cent.map((z, k) => sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : z);
    }
    // 3) merge tiny colours (less than 1% of cells, min 3) into their nearest colour
    const minCells = opts.minCells != null ? opts.minCells : Math.max(3, Math.round(cells.length * 0.01));
    let changed = true;
    while (changed) {
      changed = false;
      const cnt = cent.map(() => 0); lab.forEach(l => cnt[l]++);
      const live = cnt.map((n, k) => n > 0 ? k : -1).filter(k => k >= 0);
      if (live.length <= 2) break;
      const small = live.filter(k => cnt[k] < minCells).sort((a, b) => cnt[a] - cnt[b])[0];
      if (small == null) break;
      let to = -1, bd = Infinity;
      live.forEach(k => { if (k !== small) { const d = d2(cent[small], cent[k]); if (d < bd) { bd = d; to = k; } } });
      lab = lab.map(l => l === small ? to : l); changed = true;
    }
    // 4) number colours from most to least used ("1" = biggest area)
    const cnt = cent.map(() => 0); lab.forEach(l => cnt[l]++);
    const order = cent.map((_, k) => k).filter(k => cnt[k] > 0).sort((a, b) => cnt[b] - cnt[a]);
    const hex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
    const palette = order.map(k => hex(cent[k]));
    const data = lab.map(l => order.indexOf(l).toString(36)).join('');
    return { W, H, palette, data };
  }

  // Browser helper: File/Blob -> { rgba, w, h } (max 256 px, enough for any grid)
  function loadFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const m = 256, k = Math.min(1, m / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve({ rgba: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }
  // centre square crop
  function cropSquare(src) {
    const s = Math.min(src.w, src.h), x0 = Math.floor((src.w - s) / 2), y0 = Math.floor((src.h - s) / 2), out = new Uint8ClampedArray(s * s * 4);
    for (let y = 0; y < s; y++) out.set(src.rgba.subarray(((y + y0) * src.w + x0) * 4, ((y + y0) * src.w + x0 + s) * 4), y * s * 4);
    return { rgba: out, w: s, h: s };
  }
  // "plain background": the colour touching the most border cells becomes white
  function plainBackground(pic) {
    const { W, H } = pic, cnt = {};
    const add = i => { const k = pic.data[i]; cnt[k] = (cnt[k] || 0) + 1; };
    for (let x = 0; x < W; x++) { add(x); add((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { add(y * W); add(y * W + W - 1); }
    const bg = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    const palette = pic.palette.slice(); palette[parseInt(bg, 36)] = '#ffffff';
    return Object.assign({}, pic, { palette });
  }
  async function fromFile(file, opts) { const s = await loadFile(file); return convert(s.rgba, s.w, s.h, opts); }

  root.PixelConvert = { convert, fromFile, loadFile, cropSquare, plainBackground };
})(typeof window !== 'undefined' ? window : globalThis);
