#!/usr/bin/env node
// Illustrated (not captured) CrossPoint screens of the cp-orbit on-reader flow, framed as a BOOX Picco.
// Layout follows the firmware's default Lyra theme (src/components/themes/lyra/LyraTheme.h) and the
// English strings in lib/I18n/translations/english.yaml. Books and quotes are public domain.
// Writes docs/images/picco-showcase.png and docs/images/picco-walkthrough.gif. Needs Chrome and ffmpeg.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = ROOT + 'docs/images/';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WORK = mkdtempSync(join(tmpdir(), 'cp-illustrate-'));
const SCREENS = join(WORK, 'screens') + '/';
mkdirSync(SCREENS);

const chromeShot = (htmlFile, out, width, height, scale = 2) => {
  const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`, `--screenshot=${out}`,
    `--user-data-dir=${join(WORK, 'profile')}`, pathToFileURL(htmlFile).href], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(out)) throw new Error('Chrome failed: ' + r.stderr);
};

// ---------------------------------------------------------------- the screens
// Keep these truthful: list titles from device.json, shelf names as plugin.js writes them, firmware strings.
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{width:480px;height:800px;background:#fff;color:#111;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;overflow:hidden;position:relative}
.band{position:absolute;top:10px;left:18px;right:18px;height:20px;display:flex;justify-content:space-between;align-items:center;font-size:14px;color:#222}
.batt{display:flex;align-items:center;gap:6px}
.batt i{display:inline-block;width:22px;height:12px;border:2px solid #222;border-radius:2px;position:relative}
.batt i::before{content:"";position:absolute;inset:1px;width:72%;background:#222}
.batt i::after{content:"";position:absolute;right:-5px;top:2px;width:3px;height:4px;background:#222}
header{position:absolute;top:30px;left:0;right:0;height:64px;border-bottom:3px solid #111;display:flex;align-items:center;gap:10px;padding:0 18px}
header svg{width:28px;height:28px;flex:none}
header h1{font-size:26px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
main{position:absolute;top:110px;left:0;right:0;bottom:40px;overflow:hidden}
.list{padding:0 20px;display:flex;flex-direction:column}
.row{min-height:40px;padding:0 8px;border-radius:6px;display:flex;flex-direction:column;justify-content:center}
.row.sub{min-height:60px}
.row.sel{background:#d9d9d9}
.row .t{font-size:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .s{font-size:15px;color:#555;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .s2{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.row.nav .t{font-weight:700}
.row.icon{flex-direction:row;align-items:center;justify-content:flex-start;gap:12px}
.row.icon svg{width:24px;height:24px;flex:none}
.hints{position:absolute;left:0;right:0;bottom:0;height:40px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:4px 12px 6px}
.hints span{border:2px solid #111;border-radius:6px;font-size:15px;display:flex;align-items:center;justify-content:center;background:#fff}
.center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:0 40px;text-align:center}
.center b{font-size:22px}
.center .muted{font-size:16px;color:#555}
.bar{width:300px;height:14px;border:2px solid #111;border-radius:8px;overflow:hidden}
.bar i{display:block;height:100%;background:#111}
.page{position:absolute;top:34px;left:30px;right:30px;bottom:56px;font-family:Georgia,"Times New Roman",serif;font-size:21px;line-height:1.5;text-align:justify;hyphens:auto}
.page h2{font-size:24px;text-align:center;margin:18px 0 22px;font-weight:700;letter-spacing:.5px}
.page p{text-indent:1.4em}
.page p.first{text-indent:0}
mark{background:#cfcfcf;color:inherit;padding:1px 0}
.status{position:absolute;left:30px;right:30px;bottom:18px;display:flex;justify-content:space-between;font-size:14px;color:#333}
.status::before{content:"";position:absolute;left:0;right:0;top:-10px;height:3px;background:#ddd}
.status::after{content:"";position:absolute;left:0;width:9%;top:-10px;height:3px;background:#111}
.label{padding:0 28px;font-size:20px;font-weight:700;margin-top:14px}
.detail{padding:0 36px;font-size:16px;color:#333;margin-top:4px}
.toast{position:absolute;left:50px;right:50px;top:330px;border:3px solid #111;border-radius:10px;background:#fff;padding:22px 18px;text-align:center;font-size:20px;font-weight:700;box-shadow:0 0 0 6px #fff}
`;
const back = `<svg viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`;
const down = `<svg viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>`;
const up = `<svg viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7 9l5-5 5 5M5 20h14"/></svg>`;
const chrome = (title, body, hints = ['« Back', 'Select', 'Up', 'Down']) => `
  <div class="band"><span class="batt"><i></i>82%</span><span>21:47</span></div>
  <header>${back}<h1>${title}</h1></header>
  <main>${body}</main>
  <div class="hints">${hints.map((h) => `<span>${h}</span>`).join('')}</div>`;
const rows = (items, sel = 0) => `<div class="list">${items.map((it, i) => {
  const [t, s, cls = ''] = Array.isArray(it) ? it : [it];
  return `<div class="row${s ? ' sub' : ''}${i === sel ? ' sel' : ''} ${cls}"><div class="t">${t}</div>${s ? `<div class="s${cls.includes('wrap') ? ' s2' : ''}">${s}</div>` : ''}</div>`;
}).join('')}</div>`;

const P1 = 'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.';
const P2 = 'However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.';
const P3 = '“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?”';
const P4 = 'Mr. Bennet replied that he had not.';
const readingPage = (extra = '') => `
  <div class="page"><h2>Chapter 1</h2>
    <p class="first"><mark>${P1}</mark></p><p>${P2}</p><p>${P3}</p><p>${P4}</p>
    <p>“But it is,” returned she; “for Mrs. Long has just been here, and she told me all about it.”</p>
    <p>Mr. Bennet made no answer.</p>
    <p>“Do you not want to know who has taken it?” cried his wife impatiently.</p></div>
  <div class="status"><span>Chapter 1</span><span>3 / 312 · 1%</span></div>${extra}`;

const screens = {
  '1-plugins': chrome('Plugins', rows([
    ['BookOrbit', 'Browse and download your BookOrbit library. Set up on the reader’s Plugins web page.', 'wrap'],
    ['Plugin Hub', 'Download, discover, and update plugins'],
  ], 0)),
  '2-bookorbit': chrome('BookOrbit', rows([
    'Continue reading', 'Recently added', 'Not started', 'Finished', 'All books',
    'Fiction', 'Non-fiction', 'Collection · Classics', 'Collection · Book club', 'SmartScope · Short reads',
  ], 0)),
  '3-continue': chrome('Continue reading', rows([
    ['Pride and Prejudice', 'Jane Austen'], ['Moby-Dick; or, The Whale', 'Herman Melville'],
    ['Jane Eyre', 'Charlotte Brontë'], ['Frankenstein', 'Mary Shelley'], ['Middlemarch', 'George Eliot'],
    ['Great Expectations', 'Charles Dickens'], ['Dracula', 'Bram Stoker'], ['Next Page', '', 'nav'],
  ], 0), ['« Back', 'Select', 'Search', 'Down']),
  '4-search': chrome('Search: austen', rows([
    ['Pride and Prejudice', 'Jane Austen'], ['Sense and Sensibility', 'Jane Austen'], ['Emma', 'Jane Austen'],
    ['Persuasion', 'Jane Austen'], ['Mansfield Park', 'Jane Austen'], ['Northanger Abbey', 'Jane Austen'],
  ], 2)),
  '5-download': chrome('BookOrbit', `<div class="center"><b>Downloading...</b><div>Emma</div><div class="bar"><i style="width:64%"></i></div><div class="muted">Saving to /Books/BookOrbit</div></div>`),
  '6-reading': readingPage(),
  '7-progress': chrome('CrossPoint Sync', `
    <div class="label" style="margin-top:6px">Progress found!</div>
    <div class="label">Remote:</div><div class="detail">Chapter 12</div><div class="detail">Page 5, 34.27% overall</div><div class="detail">&nbsp;&nbsp;From: Kobo Libra 2</div>
    <div class="label" style="margin-top:22px">Local:</div><div class="detail">Chapter 9</div><div class="detail">Page 2/14, 26.80% overall</div>
    <div class="list" style="margin-top:22px">
      <div class="row icon sel">${down}<div class="t">Apply remote progress</div></div>
      <div class="row icon">${up}<div class="t">Upload local progress</div></div>
    </div>`),
  '8-session': readingPage(`<div class="toast">BookOrbit: reading session sent</div>`),
};

for (const [name, body] of Object.entries(screens)) {
  writeFileSync(SCREENS + name + '.html', `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>${body}</body>`);
  chromeShot(SCREENS + name + '.html', SCREENS + name + '.png', 480, 800);
}
// Black screen for the e-ink refresh flash between GIF steps.
writeFileSync(SCREENS + '0-flash.html', '<!doctype html><body style="margin:0;width:480px;height:800px;background:#111"></body>');
chromeShot(SCREENS + '0-flash.html', SCREENS + '0-flash.png', 480, 800);

// ---------------------------------------------------------------- frames and showcase
const frame = (outDir, specs, note) => {
  const r = spawnSync('node', [ROOT + 'scripts/frame-screenshots.mjs', outDir, ...specs], { encoding: 'utf8', env: { ...process.env, NOTE: note } });
  if (r.status !== 0) throw new Error('frame-screenshots: ' + r.stderr);
};
const FRAMED = join(WORK, 'framed') + '/';
frame(FRAMED, ['0-flash', ...Object.keys(screens)].map((n) => SCREENS + n + '.png'), '');
const SHOW = join(WORK, 'showcase') + '/';
frame(SHOW, [
  `${SCREENS}2-bookorbit.png=Lists, libraries & shelves`,
  `${SCREENS}3-continue.png=Browse & download`,
  `${SCREENS}6-reading.png=Highlights on the page`,
  `${SCREENS}7-progress.png=Progress sync`,
], 'Illustrated screens');
mkdirSync(OUT, { recursive: true });
const ffmpeg = (args) => {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr);
};
ffmpeg(['-i', SHOW + 'picco-showcase.png', '-vf', 'scale=2000:-1:flags=lanczos', OUT + 'picco-showcase.png']);

// ---------------------------------------------------------------- walkthrough GIF
const steps = [
  ['1-plugins', 'Home → Plugins → BookOrbit', 2.2],
  ['2-bookorbit', 'Your lists, libraries and shelves', 2.4],
  ['3-continue', 'Pick up where you left off', 2.2],
  ['4-search', 'Search your whole library', 2.2],
  ['5-download', 'Download straight to the reader', 1.8],
  ['6-reading', 'BookOrbit highlights, on the page', 2.8],
  ['7-progress', 'Sync progress: you choose which wins', 3.0],
  ['8-session', 'Reading sessions sent at sleep', 2.6],
];
const GIF = join(WORK, 'gif') + '/';
mkdirSync(GIF);
const card = (img, caption) => `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;width:560px;height:712px;display:flex;flex-direction:column;align-items:center;
    background:linear-gradient(160deg,#f7f5ef 0%,#e8e4d9 100%);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;position:relative}
  img{width:400px;margin-top:22px} .cap{margin-top:6px;font-size:22px;font-weight:600;color:#2b2d31}
  .note{position:absolute;right:16px;bottom:10px;font-size:12px;color:#8a867c}</style>
  <img src="${pathToFileURL(img).href}"><div class="cap">${caption}</div><div class="note">Illustration</div>`;
const list = [];
let n = 0;
const shot = (img, caption, seconds) => {
  const page = `${GIF}p${++n}.html`;
  const png = `${GIF}f${String(n).padStart(3, '0')}.png`;
  writeFileSync(page, card(img, caption));
  chromeShot(page, png, 560, 712, 1);
  list.push(`file '${png}'\nduration ${seconds}`);
};
steps.forEach(([name, caption, sec], i) => {
  if (i > 0) shot(FRAMED + 'picco-0-flash.png', caption, 0.12);
  shot(FRAMED + `picco-${name}.png`, caption, sec);
});
list.push(`file '${GIF}f${String(n).padStart(3, '0')}.png'`);
writeFileSync(GIF + 'list.txt', list.join('\n') + '\n');
ffmpeg(['-f', 'concat', '-safe', '0', '-i', GIF + 'list.txt', '-vf',
  'split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  '-loop', '0', OUT + 'picco-walkthrough.gif']);
rmSync(WORK, { recursive: true, force: true });
console.log('wrote docs/images/picco-showcase.png and docs/images/picco-walkthrough.gif');
