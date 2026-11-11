// Renders every request in device.json the way the firmware's template resolver does
// (docs/sd-plugins.md "Schema", plugin-events.md "Substitution variables") and sends it
// to the mock BookOrbit, so a typo in a URL, a JSON path or the event body fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAYLOAD } from './helpers.mjs';
import { createBookOrbit, checkPageStats, md5hex } from './mock-bookorbit.mjs';

const device = JSON.parse(readFileSync(PAYLOAD + 'device.json', 'utf8'));
const pluginJs = readFileSync(PAYLOAD + 'plugin.js', 'utf8');
const CFG = { server: 'http://bo.local:3000', user: 'reader', key: md5hex('secret'), device_id: 'a'.repeat(64) };

// Firmware urlEncodeQuery: everything except letters, digits and -_.~
const encodeQuery = (s) => Array.from(new TextEncoder().encode(String(s)), (b) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');

function render(template, vars) {
  return template.replace(/\{([a-zA-Z_][\w.]*)\}/g, (whole, name) => {
    if (name.startsWith('cfg.')) return CFG[name.slice(4)] ?? whole;
    if (name.endsWith('_enc')) return encodeQuery(vars[name.slice(0, -4)] ?? '');
    if (name === 'query') return encodeQuery(vars.query ?? '');
    return name in vars ? String(vars[name]) : whole;
  });
}
const renderHeaders = (h, vars) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k, render(v, vars)]));
// The firmware percent-encodes spaces, controls and non-ASCII bytes in a URL before sending.
const finishUrl = (u) => Array.from(new TextEncoder().encode(u), (b) => (b <= 0x20 || b >= 0x7f ? '%' + b.toString(16).toUpperCase() : String.fromCharCode(b))).join('');
const at = (obj, path) => (path === '' ? obj : path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

function get(bo, url, headers) {
  const r = bo.handle('GET', finishUrl(url), headers, '');
  assert.equal(r.status, 200, url + ' -> ' + r.status + ' ' + r.body);
  return JSON.parse(r.body);
}

test('only variables the firmware knows, and config keys the card writes', () => {
  const known = new Set(['page', 'limit', 'offset', 'query', 'query_raw', 'list_id', 'list_id_enc', 'id', 'id_enc', 'title', 'author', 'url', 'dest', 'md5']);
  const sessionVars = ['book', 'document', 'start_time', 'end_time', 'duration_seconds', 'start_progress_bp', 'end_progress_bp', 'progress_scale', 'ts', 'id'];
  const used = [...JSON.stringify(device).matchAll(/\{([a-zA-Z_][\w.]*)\}/g)].map((m) => m[1]);
  assert.ok(used.length > 20);
  for (const name of used) {
    if (name.startsWith('cfg.')) assert.match(pluginJs, new RegExp('\\b' + name.slice(4) + '\\b'), 'card never writes config key ' + name);
    else if (name.startsWith('event.')) assert.ok(sessionVars.includes(name.slice(6)), 'unknown reader.session variable ' + name);
    else assert.ok(known.has(name), 'unknown template variable {' + name + '}');
  }
  assert.equal(device.config.file, '/.cp-orbit/config.json');
});

test('every catalog list, the libraries index and search return items the manifest can read', () => {
  const bo = createBookOrbit();
  const vars = { page: 1, limit: device.browse.page_size, query: 'war & peace?' };
  const headers = renderHeaders(device.browse.headers, vars);
  assert.ok(device.browse.page_size >= 1 && device.browse.page_size <= 16);

  const index = get(bo, render(device.browse.lists_url, vars), renderHeaders(device.browse.lists_headers, vars));
  const libraries = at(index, device.browse.lists_items);
  assert.ok(libraries.length > 0);
  const urls = device.browse.lists.map((l) => render(l.url, vars));
  for (const lib of libraries) {
    assert.ok(at(lib, device.browse.lists_fields.title));
    urls.push(render(device.browse.url, { ...vars, list_id: at(lib, device.browse.lists_fields.id) }));
  }
  urls.push(render(device.browse.search.url, vars));
  for (const url of urls) {
    assert.match(url, /page=1&size=8/, 'pages with {page} and {limit}: ' + url);
    const page = get(bo, url, headers);
    for (const item of at(page, device.browse.items)) {
      assert.ok(at(item, device.browse.fields.title), 'title path');
      assert.ok(at(item, device.browse.fields.id), 'id path');
    }
  }
  assert.match(urls.at(-1), /q=war%20%26%20peace%3F/, '{query} is percent-encoded');
  const calls = bo.calls.filter((c) => c.path.endsWith('/catalog/books'));
  assert.ok(calls.some((c) => c.query.includes('libraryId=3')));
  assert.ok(calls.every((c) => c.query.includes('format=epub')), 'only formats the reader can open');
});

test('download: the detail hop yields a server path, the filename and sidecar render', () => {
  const bo = createBookOrbit();
  const item = bo.catalog.books[0];
  const vars = { id: item.id, title: item.title, author: item.authors[0] };
  const detail = get(bo, render(device.download.url, vars), renderHeaders(device.download.headers, vars));
  assert.match(at(detail, device.download.url_path), /^\/api\/v1\/koreader\/plugin\/catalog\/files\/\d+\/download$/);
  assert.equal(render(device.download.filename, vars), 'Alpha - Ann Author.epub');
  const sidecar = JSON.parse(render(device.download.sidecar.body, vars));
  assert.deepEqual(sidecar, { bookorbit_book_id: '11', source: 'bookorbit' });
  assert.equal(render(device.download.sidecar.path, { dest: '/Books/BookOrbit/Alpha - Ann Author.epub' }), '/Books/BookOrbit/Alpha - Ann Author.epub.meta.json');
});

test('reader.session becomes a valid page-stats upload, including the edge values', () => {
  const handler = device.events['reader.session'];
  assert.equal(handler.connect, true, 'sent at sleep too');
  assert.equal(handler.request.method, 'POST');
  for (const ev of [
    { document: 'f'.repeat(32), start_time: 1767225600, end_time: 1767226200, duration_seconds: 600, start_progress_bp: 120, end_progress_bp: 455 },
    { document: '0'.repeat(32), start_time: 1, end_time: 86401, duration_seconds: 86400, start_progress_bp: 0, end_progress_bp: 10000 },
  ]) {
    const vars = Object.fromEntries(Object.entries(ev).map(([k, v]) => ['event.' + k, v]));
    const body = render(handler.request.body, vars);
    const parsed = JSON.parse(body);
    checkPageStats(parsed);
    assert.equal(parsed.pluginVersion, 'cp-orbit/' + JSON.parse(readFileSync(PAYLOAD + 'manifest.json', 'utf8')).version);
    const [a, b] = parsed.books[0].events;
    assert.deepEqual([a.page, a.startTime, a.durationSeconds, b.page, b.startTime, b.durationSeconds], [ev.start_progress_bp, ev.start_time, ev.duration_seconds, ev.end_progress_bp, ev.end_time, 0]);
    const bo = createBookOrbit();
    const r = bo.handle('POST', render(handler.request.url, vars), renderHeaders(handler.request.headers, vars), body);
    assert.equal(r.status, 200, r.body);
  }
});
