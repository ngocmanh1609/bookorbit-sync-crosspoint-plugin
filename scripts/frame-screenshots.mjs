#!/usr/bin/env node
// Puts CrossPoint screenshots (the 480x800 BMPs from Power + Down, or PNGs) into a
// pocket e-reader frame for the README, plus a side-by-side showcase image.
// Needs Google Chrome installed (macOS path below, or set CHROME=/path/to/chrome).
//
//   node scripts/frame-screenshots.mjs <out-dir> <shot.bmp>[=Caption] ...
//   node scripts/frame-screenshots.mjs docs/images/device placeholder=Catalog placeholder=Sync
//
// "placeholder" renders an empty, clearly marked screen to preview the frame.
// NOTE="text" adds a small note to the showcase corner.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [outDir, ...specs] = process.argv.slice(2);
if (!outDir || !specs.length) {
  console.error('usage: node scripts/frame-screenshots.mjs <out-dir> <shot.bmp>[=Caption] ...');
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error('Google Chrome not found; set CHROME=/path/to/chrome');
  process.exit(1);
}

const shots = specs.map((spec, i) => {
  const [file, caption = ''] = spec.split('=');
  if (file !== 'placeholder' && !existsSync(file)) throw new Error('not found: ' + file);
  const name = file === 'placeholder' ? `placeholder-${i + 1}` : basename(file, extname(file));
  return { src: file === 'placeholder' ? null : pathToFileURL(resolve(file)).href, caption, name };
});

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Screen 480x800 CSS px, the Picco's portrait resolution, inside a slim graphite body.
const CSS = `
  *{box-sizing:border-box} body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .device{position:relative;width:536px;height:872px;border-radius:46px;padding:36px 28px;
    background:linear-gradient(155deg,#3a3d42 0%,#232528 55%,#1b1c1f 100%);
    box-shadow:0 30px 60px -18px rgba(0,0,0,.45),0 12px 24px -12px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.14),inset 0 -1px 0 rgba(0,0,0,.5)}
  .device::after{content:"";position:absolute;inset:8px;border-radius:39px;border:1px solid rgba(255,255,255,.05);pointer-events:none}
  .screen{position:relative;width:480px;height:800px;border-radius:6px;overflow:hidden;background:#efede6;
    box-shadow:inset 0 0 0 1px rgba(0,0,0,.35),inset 0 2px 6px rgba(0,0,0,.25)}
  .screen img{display:block;width:480px;height:800px;object-fit:contain;mix-blend-mode:multiply;filter:contrast(.94)}
  .screen::after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 30% 0%,rgba(255,255,255,.18),transparent 60%);pointer-events:none}
  .placeholder{position:absolute;inset:24px;border:3px dashed #9a978e;border-radius:10px;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:12px;color:#77746c;text-align:center;font-size:26px;line-height:1.3}
  .placeholder small{font-size:18px}
  .caption{margin-top:26px;text-align:center;font-size:24px;font-weight:600;color:#2b2d31}
  .stage{position:relative;display:inline-flex;gap:56px;padding:56px 64px 40px;align-items:flex-start;border-radius:36px;
    background:linear-gradient(160deg,#f7f5ef 0%,#e8e4d9 100%)}
  .note{position:absolute;right:28px;bottom:16px;font-size:15px;color:#8a867c;letter-spacing:.3px}
  .solo{padding:40px 44px 52px;display:inline-block}`;

// Captions only appear on the showcase, whose light card keeps them readable in dark mode too.
const deviceHtml = (s, withCaption) => `
  <div><div class="device"><div class="screen">${
    s.src ? `<img src="${s.src}" alt="">` : `<div class="placeholder">Your Picco screenshot<small>(placeholder)</small></div>`
  }</div></div>${withCaption && s.caption ? `<div class="caption">${esc(s.caption)}</div>` : ''}</div>`;

function render(html, width, height, out) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-frame-'));
  const page = join(dir, 'page.html');
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${CSS}</style>${html}`);
  const r = spawnSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--default-background-color=00000000', '--force-device-scale-factor=2',
    `--window-size=${width},${height}`, `--screenshot=${out}`, `--user-data-dir=${join(dir, 'profile')}`,
    pathToFileURL(page).href,
  ], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(out)) throw new Error('Chrome failed: ' + (r.stderr || r.status));
}

mkdirSync(outDir, { recursive: true });
const captionH = shots.some((s) => s.caption) ? 60 : 0;
for (const s of shots) {
  const out = resolve(outDir, `picco-${s.name}.png`);
  render(`<div class="solo">${deviceHtml(s, false)}</div>`, 536 + 88, 872 + 92, out);
  console.log(out);
}
if (shots.length > 1) {
  const out = resolve(outDir, 'picco-showcase.png');
  // NOTE="Illustrated screens" labels the showcase, e.g. when the screens are mock-ups rather than captures.
  const note = process.env.NOTE ? `<div class="note">${esc(process.env.NOTE)}</div>` : '';
  render(`<div class="stage">${shots.map((s) => deviceHtml(s, true)).join('')}${note}</div>`, shots.length * 536 + (shots.length - 1) * 56 + 128, 872 + 96 + captionH, out);
  console.log(out);
}
