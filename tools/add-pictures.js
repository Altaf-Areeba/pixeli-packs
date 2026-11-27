// Turns images in an inbox folder into color-by-number pictures inside a picture pack.
// Usage: node tools/add-pictures.js <packsDir> [--inbox <dir>] [--pack <id>] [--keep]
//   <packsDir>  folder with index.json + pack files (this repo: packs/)
//   inbox       default <packsDir>/inbox. Put .png .jpg .jpeg .webp .svg files there.
//   file name   "red-fox.png"                       -> English name "Red Fox"
//               "red-fox__rotfuchs__renard-roux.png" -> EN / DE / FR names
//               add "@24" or "@48" for the grid size (default 32), e.g. "owl@24.png"
//   SVG files are drawn pixel-exact (crisp edges), best for clean flat art.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const packsDir = path.resolve(args[0] || 'packs');
const opt = k => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : null; };
const inbox = path.resolve(opt('--inbox') || path.join(packsDir, 'inbox'));
const now = new Date(), ym = now.toISOString().slice(0, 7);
const packId = opt('--pack') || 'pack-' + ym;
const keep = args.includes('--keep');
const convertSrc = [path.join(__dirname, '..', 'js', 'convert.js'), path.join(__dirname, 'convert.js')].find(f => fs.existsSync(f));
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  fr: ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre']
};

const title = s => s.replace(/[-_]+/g, ' ').trim().replace(/(^|\s)(\S)/g, (m, a, c) => a + c.toUpperCase());
const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

(async () => {
  if (!fs.existsSync(inbox)) { console.log('No inbox folder: ' + inbox); return; }
  const files = fs.readdirSync(inbox).filter(f => MIME[path.extname(f).toLowerCase()] || /\.json$/i.test(f)).sort();
  if (!files.length) { console.log('Inbox is empty, nothing to do.'); return; }

  const idxFile = path.join(packsDir, 'index.json');
  const index = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : { packs: [] };
  let entry = index.packs.find(p => p.id === packId);
  if (!entry) { entry = { id: packId, version: 0, file: packId + '.json' }; index.packs.unshift(entry); }
  const packFile = path.join(packsDir, entry.file);
  const m = /^pack-(\d{4})-(\d{2})$/.exec(packId);
  const pack = fs.existsSync(packFile) ? JSON.parse(fs.readFileSync(packFile, 'utf8'))
    : { id: packId, version: 0, names: m ? { en: MONTHS.en[+m[2] - 1] + ' ' + m[1], de: MONTHS.de[+m[2] - 1] + ' ' + m[1], fr: MONTHS.fr[+m[2] - 1] + ' ' + m[1] } : { en: title(packId) }, pictures: [] };
  const used = new Set();
  for (const e of index.packs) { const f = path.join(packsDir, e.file); if (fs.existsSync(f)) JSON.parse(fs.readFileSync(f, 'utf8')).pictures.forEach(p => used.add(p.id)); }
  pack.pictures.forEach(p => used.add(p.id));

  const browser = await chromium.launch(), page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: fs.readFileSync(convertSrc, 'utf8') });
  const added = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext === '.json') { // already converted on the owner's phone (app "Send to all players")
      try {
        const j = JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8'));
        const okSize = Number.isInteger(j.W) && Number.isInteger(j.H) && j.W >= 4 && j.H >= 4 && j.W <= 64 && j.H <= 64;
        const okPal = Array.isArray(j.palette) && j.palette.length >= 1 && j.palette.length <= 36 && j.palette.every(c => /^#[0-9a-f]{6}$/i.test(c));
        const okData = typeof j.data === 'string' && j.data.length === j.W * j.H && [...j.data].every(ch => parseInt(ch, 36) < j.palette.length);
        if (!okSize || !okPal || !okData) throw new Error('bad picture data');
        const names = {};
        for (const l of ['en', 'de', 'fr']) if (j.n && typeof j.n[l] === 'string' && j.n[l].trim()) names[l] = j.n[l].trim().slice(0, 30);
        if (!names.en) names.en = 'Picture';
        let id = slug(names.en) || 'picture'; const id0 = id; let k = 2; while (used.has(id)) id = id0 + '-' + k++;
        used.add(id);
        pack.pictures.push({ id, n: names, W: j.W, H: j.H, palette: j.palette.map(c => c.toLowerCase()), data: j.data });
        added.push(id + ' (' + j.W + 'x' + j.H + ', ' + j.palette.length + ' colors, from phone)');
        if (!keep) fs.unlinkSync(path.join(inbox, f));
      } catch (e) { console.log('SKIP ' + f + ': ' + e.message); }
      continue;
    }
    let base = path.basename(f, ext), size = 32;
    const sm = /@(\d{2})$/.exec(base); if (sm) { size = Math.max(12, Math.min(64, +sm[1])); base = base.slice(0, sm.index); }
    const [en, de, fr] = base.split('__');
    const names = { en: title(en) }; if (de) names.de = title(de); if (fr) names.fr = title(fr);
    let id = slug(en) || 'picture'; const id0 = id; let k = 2; while (used.has(id)) id = id0 + '-' + k++;
    let bytes = fs.readFileSync(path.join(inbox, f));
    if (ext === '.svg') { // pixel-exact: no anti-aliasing
      let t = bytes.toString('utf8');
      if (!/shape-rendering/.test(t)) t = t.replace(/<svg\b/, '<svg shape-rendering="crispEdges"');
      bytes = Buffer.from(t, 'utf8');
    }
    const url = 'data:' + MIME[ext] + ';base64,' + bytes.toString('base64');
    try {
      const pic = await page.evaluate(async ({ url, size, svg }) => {
        const img = new Image(); img.src = url; await img.decode();
        const w0 = img.naturalWidth || 100, h0 = img.naturalHeight || 100;
        let w, h;
        if (svg) { if (w0 >= h0) { w = size; h = Math.max(8, Math.round(size * h0 / w0)); } else { h = size; w = Math.max(8, Math.round(size * w0 / h0)); } }
        else { const s = Math.min(1, 256 / Math.max(w0, h0)); w = Math.max(1, Math.round(w0 * s)); h = Math.max(1, Math.round(h0 * s)); }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d'); x.imageSmoothingEnabled = !svg; x.drawImage(img, 0, 0, w, h);
        return PixelConvert.convert(x.getImageData(0, 0, w, h).data, w, h, svg ? { size, colors: 24, minCells: 1 } : { size, colors: 12 });
      }, { url, size, svg: ext === '.svg' });
      used.add(id);
      pack.pictures.push(Object.assign({ id, n: names }, pic));
      added.push(id + ' (' + pic.W + 'x' + pic.H + ', ' + pic.palette.length + ' colors)');
      if (!keep) fs.unlinkSync(path.join(inbox, f));
    } catch (e) { console.log('SKIP ' + f + ': ' + e.message); }
  }
  await browser.close();
  if (!added.length) return;
  pack.version = entry.version = (entry.version || 0) + 1;
  fs.writeFileSync(packFile, JSON.stringify(pack));
  fs.writeFileSync(idxFile, JSON.stringify(index, null, 1));
  console.log('Added ' + added.length + ' picture(s) to ' + entry.file + ' (version ' + pack.version + '):\n  ' + added.join('\n  '));
})();
