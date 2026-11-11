#!/usr/bin/env node
// Records the real cp-orbit web card for the README: a stand-in reader (the firmware's own Plugins
// page, plugin-host.js and web.css) backed by the tests' mock BookOrbit, driven in headless Chrome.
// Writes docs/images/web-card.gif and docs/images/web-card.png. Needs Chrome, ffmpeg and gh.
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CACHE = ROOT + '.cache/crosspoint-web/';
const OUT = ROOT + 'docs/images/';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DELAY = 700; // ms per BookOrbit call, so progress messages are visible in the frames
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- firmware page shell
const ASSETS = {
  'PluginsPage.html': 'src/network/html/PluginsPage.html',
  'Header.html.inc': 'src/network/html/shared/Header.html.inc',
  'Footer.html.inc': 'src/network/html/shared/Footer.html.inc',
  'web.css': 'src/network/html/assets/web.css',
  'crosspoint-icon.svg': 'src/network/html/assets/crosspoint-icon.svg',
  'plugin-host.js': 'src/network/html/js/plugin-host.js',
};
mkdirSync(CACHE, { recursive: true });
for (const [name, path] of Object.entries(ASSETS)) {
  if (existsSync(CACHE + name) && !process.env.REFRESH) continue;
  const b64 = execFileSync('gh', ['api', `repos/crosspoint-reader/crosspoint-reader/contents/${path}?ref=develop`, '--jq', '.content'], { encoding: 'utf8' });
  writeFileSync(CACHE + name, Buffer.from(b64, 'base64'));
}

// ---------------------------------------------------------------- demo data (public domain)
const { createBookOrbit } = await import(pathToFileURL(ROOT + 'tests/mock-bookorbit.mjs').href);
const { encodeStoreRef, makeEpub } = await import(pathToFileURL(ROOT + 'tests/helpers.mjs').href);
const enc = new TextEncoder();
const bo = createBookOrbit({ user: 'reader', password: 'secret' });
bo.catalog.collections = [
  { id: '7', title: 'Classics', section: 'collections', count: 12 },
  { id: '8', title: 'Book club', section: 'collections', count: 3 },
  { id: '12', title: 'Wishlist', section: 'collections', count: 0 }, // hidden: no books
];
bo.catalog.scopes = [{ id: '9', title: 'Short reads', section: 'smart-scopes', count: 5 }];
const BOOK = '/Books/BookOrbit/Pride and Prejudice - Jane Austen.epub';
const P1 = 'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.';
const P2 = 'However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families.';
const epub = await makeEpub([{ body: `<p>${P1}</p><p>${P2}</p>` }, { body: '<p>Mr. Bennet was among the earliest of those who waited on Mr. Bingley.</p>' }]);
const partial = createHash('md5');
for (let i = -1; i <= 10; i++) {
  const off = i < 0 ? 0 : 1024 << (2 * i);
  if (off >= epub.length) break;
  partial.update(epub.subarray(off, off + 1024));
}
const hash = partial.digest('hex');
bo.addBook(hash, 11);
const webText = 'this truth is so well fixed in the minds of the surrounding families';
const at = P2.indexOf(webText);
bo.addWebHighlight(hash, { text: webText, pos0: `/body/DocFragment[1]/body/p[2]/text().${at}`, pos1: `/body/DocFragment[1]/body/p[2]/text().${at + webText.length}`, chapter: 'Chapter 1' });
const hashPath = (p) => { // libstdc++ 32-bit std::hash, as in plugin.js
  const b = enc.encode(p); const m = 0x5bd1e995; let len = b.length; let h = (0xc70f6907 ^ len) | 0; let i = 0;
  while (len >= 4) { let k = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24); k = Math.imul(k, m); k ^= k >>> 24; k = Math.imul(k, m); h = Math.imul(h, m) ^ k; i += 4; len -= 4; }
  if (len === 3) h ^= b[i + 2] << 16; if (len >= 2) h ^= b[i + 1] << 8; if (len >= 1) h = Math.imul(h ^ b[i], m);
  h ^= h >>> 13; h = Math.imul(h, m); h ^= h >>> 15; return h >>> 0;
};
const sd = new Map([
  [BOOK, epub],
  ['/plugins/cp-orbit/device.json', readFileSync(ROOT + 'cp-orbit.crosspoint-plugin/device.json')],
  ['/.crosspoint/recent.json', enc.encode(JSON.stringify({ books: [
    { path: BOOK, title: 'Pride and Prejudice', author: 'Jane Austen' },
    { path: '/Books/BookOrbit/Alice in Wonderland - Lewis Carroll.epub', title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' },
    { path: '/Books/BookOrbit/Moby-Dick - Herman Melville.epub', title: 'Moby-Dick', author: 'Herman Melville' },
  ] }))],
  [`/.crosspoint/clippings/epub_${hashPath(BOOK)}.bin`, encodeStoreRef({ title: 'Pride and Prejudice', author: 'Jane Austen', path: BOOK, records: [{ spine: 0, timestamp: 1767225600, startOffset: 0, endOffset: 44, chapter: 'Chapter 1', text: P1.slice(0, 44) }] })],
]);
const settings = {
  koServerUrl: { key: 'koServerUrl', type: 'string', value: '' },
  koUsername: { key: 'koUsername', type: 'string', value: '' },
  koServerType: { key: 'koServerType', type: 'enum', value: 0, options: ['CrossPoint', 'KOSync', 'Other'] },
  koMatchMethod: { key: 'koMatchMethod', type: 'enum', value: 0, options: ['Filename', 'Binary'] },
  koSyncBehavior: { key: 'koSyncBehavior', type: 'enum', value: 0, options: ['Ask every time', 'Smart'] },
  koSyncClippings: { key: 'koSyncClippings', type: 'toggle', value: 1 },
};

// ---------------------------------------------------------------- stand-in reader web server
const body = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const send = (status, data, type = 'application/json', extra = {}) => { res.writeHead(status, { 'Content-Type': type, ...extra }); res.end(data); };
  try {
    if (p === '/plugins') {
      const page = readFileSync(CACHE + 'PluginsPage.html', 'utf8')
        .replace('<!--#include file="shared/Header.html.inc" -->', readFileSync(CACHE + 'Header.html.inc', 'utf8'))
        .replace('<!--#include file="shared/Footer.html.inc" -->', readFileSync(CACHE + 'Footer.html.inc', 'utf8'));
      return send(200, page, 'text/html', { 'Set-Cookie': 'cpPlugins=1; Path=/' });
    }
    if (p === '/assets/web.css') return send(200, readFileSync(CACHE + 'web.css'), 'text/css');
    if (p === '/assets/crosspoint-icon.svg') return send(200, readFileSync(CACHE + 'crosspoint-icon.svg'), 'image/svg+xml');
    if (p === '/js/plugin-host.js') return send(200, readFileSync(CACHE + 'plugin-host.js'), 'text/javascript');
    if (p === '/js/jszip.min.js') return send(200, readFileSync(ROOT + 'node_modules/jszip/dist/jszip.min.js'), 'text/javascript');
    if (p === '/api/plugins') return send(200, JSON.stringify([{ name: 'cp-orbit', dir: '/plugins/cp-orbit', title: 'BookOrbit', mount: 'settings' }]));
    if (p === '/plugin') return send(200, readFileSync(ROOT + 'cp-orbit.crosspoint-plugin/' + u.searchParams.get('file').replace(/[\\/]/g, '')), 'text/javascript');
    if (p === '/download') { const f = u.searchParams.get('path'); return sd.has(f) ? send(200, Buffer.from(sd.get(f)), 'application/octet-stream') : send(404, 'Item not found', 'text/plain'); }
    if (p === '/api/status') return send(200, JSON.stringify({ version: '2.0.0', device: 'picco', deviceId: 'b'.repeat(64) }));
    if (p === '/api/settings' && req.method === 'GET') return send(200, JSON.stringify((u.searchParams.get('keys') || '').split(',').map((k) => settings[k]).filter(Boolean)));
    if (p === '/api/settings') { const upd = JSON.parse(await body(req)); for (const [k, v] of Object.entries(upd)) if (settings[k]) settings[k].value = v; return send(200, 'Applied', 'text/plain'); }
    if (p === '/api/relay') {
      const { method, url, headers, body: b } = JSON.parse(await body(req));
      await sleep(DELAY);
      const r = bo.handle(method, url, headers, b);
      if (/\/catalog\/books\/\d+$/.test(url) && r.status === 200) r.body = JSON.stringify({ ...JSON.parse(r.body), title: 'Pride and Prejudice' });
      return send(200, r.body, 'application/octet-stream', { 'X-Relay-Status': String(r.status), 'X-Relay-Headers': '[]' });
    }
    if (p === '/api/fetch') {
      const { url, dest, headers, method, body: b } = JSON.parse(await body(req));
      const r = bo.handle(method || 'GET', url, headers, b || '');
      sd.set(dest, enc.encode(r.body));
      return send(200, JSON.stringify({ status: r.status, bytes: r.body.length, complete: true }));
    }
    if (p === '/api/plugin-fs') {
      const raw = await body(req);
      const boundary = '--' + /boundary=(.+)$/.exec(req.headers['content-type'])[1];
      sd.set(u.searchParams.get('path'), new Uint8Array(raw.subarray(raw.indexOf('\r\n\r\n') + 4, raw.lastIndexOf('\r\n' + boundary))));
      return send(200, '{"ok":true}');
    }
    send(404, 'Not found', 'text/plain');
  } catch (e) {
    send(500, String(e.stack || e), 'text/plain');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${server.address().port}/plugins`;

// ---------------------------------------------------------------- drive the card in Chrome
const WORK = mkdtempSync(join(tmpdir(), 'cp-web-card-'));
const FRAMES = join(WORK, 'frames');
mkdirSync(FRAMES);
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(WORK, 'profile')}`, '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 100 && !wsUrl; i++) {
  await sleep(100);
  try {
    const port = readFileSync(join(WORK, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0];
    wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page').webSocketDebuggerUrl;
  } catch { /* Chrome still starting */ }
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
async function until(expr, ms = 15000) { const t = Date.now(); while (!(await js(expr))) { if (Date.now() - t > ms) throw new Error('timed out waiting for: ' + expr); await sleep(60); } }
const timeline = [];
async function frame(seconds) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = join(FRAMES, `f${String(timeline.length + 1).padStart(3, '0')}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  timeline.push([file, seconds]);
}

try {
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 760, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: PAGE });
  await until(`!!document.querySelector('#plugin-cp-orbit select option')`);
  await js(`(() => {
    const s = document.createElement('style');
    s.textContent = '.cp-demo-click{outline:3px solid #e67e22 !important;outline-offset:2px;box-shadow:0 0 0 6px rgba(230,126,34,.25)}';
    document.head.appendChild(s);
    window.card = document.getElementById('plugin-cp-orbit');
    window.btn = (t) => Array.from(card.querySelectorAll('button')).find((b) => b.textContent === t);
    window.msg = (i) => card.querySelectorAll('.cp-orbit-msg')[i].textContent;
    window.press = (t) => { const b = btn(t); b.classList.add('cp-demo-click'); setTimeout(() => b.classList.remove('cp-demo-click'), 700); b.click(); };
    window.show = (el) => { const r = el.getBoundingClientRect(); window.scrollBy(0, r.top - 90); };
    return true;
  })()`);
  await frame(1.4);
  const type = async (index, text, steps) => {
    for (let i = 1; i <= steps; i++) {
      await js(`card.querySelectorAll('input')[${index}].value = ${JSON.stringify(text.slice(0, Math.ceil((text.length * i) / steps)))}`);
      await frame(0.18);
    }
  };
  await type(0, 'http://192.168.1.50:3000', 4);
  await type(1, 'reader', 2);
  await type(2, 'secret', 2);
  await js(`press('Save')`); await sleep(120); await frame(0.9);
  await until(`/Saved\\./.test(msg(0))`); await frame(2.6);
  // Save also syncs the catalog lists; show that section's result.
  await js(`show(card.querySelectorAll('.cp-orbit-msg')[1].previousElementSibling.previousElementSibling)`); await frame(0.6);
  await until(`/In the reader's catalog/.test(msg(1))`); await frame(2.4);
  await js(`show(btn('Sync highlights').closest('.setting-row').previousElementSibling.previousElementSibling)`); await frame(0.9);
  await js(`press('Sync highlights')`); await sleep(150); await frame(0.7);
  await until(`/Applying|sent|added/.test(msg(2))`); await frame(0.9);
  await until(`/added to the reader/.test(msg(2))`); await frame(2.6);
  await js(`press('Show status & rating')`); await sleep(150); await frame(0.8);
  await until(`/press Save status/.test(msg(2))`); await frame(1.6);
  await js(`(() => { const s = card.querySelectorAll('select'); s[2].value = 'read'; s[3].value = '5'; return true; })()`); await frame(1.0);
  await js(`press('Save status & rating')`); await sleep(150); await frame(0.6);
  await until(`/saved to BookOrbit/.test(msg(2))`); await frame(3.2);

  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 760, deviceScaleFactor: 2, mobile: false });
  await js(`window.scrollTo(0, 0)`);
  const h = await js(`Math.ceil(document.querySelector('main').getBoundingClientRect().bottom + 24)`);
  const full = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 900, height: h, scale: 1 } });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(OUT + 'web-card.png', Buffer.from(full.data, 'base64'));
} finally {
  ws.close();
  chrome.kill();
  server.close();
}

const list = timeline.map(([f, s]) => `file '${f}'\nduration ${s}`).concat(`file '${timeline.at(-1)[0]}'`).join('\n') + '\n';
writeFileSync(join(WORK, 'frames.txt'), list);
const ff = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(WORK, 'frames.txt'), '-vf',
  'scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  '-loop', '0', OUT + 'web-card.gif'], { encoding: 'utf8' });
if (ff.status !== 0) throw new Error('ffmpeg: ' + ff.stderr);
rmSync(WORK, { recursive: true, force: true });
console.log('wrote docs/images/web-card.gif and docs/images/web-card.png');
