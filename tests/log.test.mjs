// The problem log: what it records, what it never shows, and the report a user attaches to an issue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeReader, loadPlugin, PLUGIN_DIR } from './helpers.mjs';
import { createBookOrbit, md5hex } from './mock-bookorbit.mjs';

const CFG = { server: 'http://192.168.1.50:3000', user: 'quentin42', key: md5hex('secret'), device_id: 'd'.repeat(64), dest_dir: '/Books/BookOrbit' };
const SECRETS = { cfg: CFG, deviceId: 'd'.repeat(64) };
const leaks = (text) => [CFG.key, CFG.server, '192.168.1.50', CFG.device_id, 'quentin42'].filter((s) => text.includes(s));

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup(files = {}, status) {
  const reader = fakeReader({ bookorbit: createBookOrbit(), files, status });
  const { lib, registered, document } = loadPlugin(reader);
  return { reader, lib, registered, document };
}

test('log: redaction takes out the key, server, username and device ID', () => {
  const { lib } = setup();
  const text = lib.redact('GET http://192.168.1.50:3000/api as quentin42 (quentin420 stays) key ' + CFG.key + ' id ' + 'd'.repeat(64) + ' host 192.168.1.50', CFG, SECRETS.deviceId);
  assert.deepEqual(leaks(text.replace('quentin420', '')), []);
  assert.match(text, /<server>\/api as <user> \(quentin420 stays\) key <key> id <device-id> host <server>/);
  assert.equal(lib.redact('ab and ab', { user: 'ab' }), 'ab and ab', 'names under 3 letters are too common to swap');
  const twice = lib.redact(lib.redact('http://bo.local/x for server', { server: 'http://bo.local', user: 'server' }), { server: 'http://bo.local', user: 'server' });
  assert.equal(twice, '<server>/x for <user>', 'redacting again never rewrites a placeholder');
});

test('log: an error entry keeps the request and stack, never the secrets', async () => {
  const { lib, reader } = setup();
  const log = lib.createLog(reader.api, SECRETS);
  const err = Object.assign(new Error('BookOrbit returned HTTP 500 at ' + CFG.server + '.'), { status: 500, request: { method: 'POST', path: '/api/v1/koreader/plugin/annotations/exchange', status: 500, answer: '{"message":"boom for quentin42"}' } });
  log.add('ERROR', 'sync-highlights', err, { book: '/Books/1984.epub' });
  log.add('WARN', 'shelves', 'one list did not fit');
  const text = await log.text();
  assert.equal(reader.readText(lib.LOG_PATH), text, 'written to /.cp-orbit/logs');
  assert.match(text, /^--- \S+ ERROR sync-highlights \(cp-orbit \d+\.\d+\.\d+\)\nBookOrbit returned HTTP 500 at <server>\.\nrequest: POST \/api\/v1\/koreader\/plugin\/annotations\/exchange -> 500\nanswer: \{"message":"boom for <user>"\}\nbook: \/Books\/1984\.epub\nstack:\n {2}Error: /);
  assert.match(text, /--- \S+ WARN shelves \(cp-orbit [^)]+\)\none list did not fit\n$/);
  assert.deepEqual(leaks(text), []);
  assert.deepEqual(lib.logStats(text).count, 2);
  assert.equal(lib.logStats(text).lastMessage, 'one list did not fit');
});

test('log: keeps the newest 64KB, cut at an entry boundary', async () => {
  const { lib, reader } = setup();
  const log = lib.createLog(reader.api, SECRETS);
  for (let i = 0; i < 120; i++) log.add('WARN', 'test', 'entry ' + i + ' ' + 'x'.repeat(1000));
  const text = await log.text();
  assert.ok(text.length <= 64 * 1024);
  assert.ok(text.startsWith('--- '), 'starts with a whole entry');
  assert.match(text, /entry 119 /);
  assert.doesNotMatch(text, /entry 0 /);
  await log.clear();
  assert.equal(lib.logStats(reader.readText(lib.LOG_PATH)).count, 0);
});

test('log: the report describes the reader without its secrets', async () => {
  const { lib, reader } = setup(
    {
      '/.cp-orbit/config.json': JSON.stringify(CFG),
      [PLUGIN_DIR + '/device.json']: JSON.stringify({ browse: { lists: [{ title: 'All books' }, { title: 'Fiction', shelf: true }] } }),
      [PLUGIN_DIR + '/events.jsonl']: '{"e":"reader.session"}\n{"e":"reader.session"}\n',
    },
    { version: '2.0.0', firmwareFamily: 'crosspoint', device: 'picco', deviceId: 'd'.repeat(64), freeHeap: 123456, uptime: 99, serial: 'SN-PRIVATE' }
  );
  reader.settings.koServerUrl.value = CFG.server + '/api/v1/koreader';
  reader.settings.koMatchMethod.value = 1;
  const log = lib.createLog(reader.api, { cfg: null, deviceId: '' }); // secrets not known yet: the report reads the config
  log.add('ERROR', 'load', new Error('failed for ' + CFG.server));
  const report = await lib.buildReport(reader.api, log, { cfg: null, deviceId: 'd'.repeat(64) });
  assert.match(report, /Firmware: crosspoint 2\.0\.0, device picco, free memory 123456 bytes, up 99 s/);
  assert.match(report, /Connection saved: yes, download folder \/Books\/BookOrbit/);
  assert.match(report, /Reader progress sync: BookOrbit, type CrossPoint, matching Binary, when positions differ Ask every time, clipping sync on/);
  assert.match(report, /Catalog lists: 1 from BookOrbit/);
  assert.match(report, /Reading sessions waiting to be sent: 2/);
  assert.match(report, /ERROR load/);
  assert.deepEqual(leaks(report), []);
  assert.doesNotMatch(report, /SN-PRIVATE/);
  const url = new URL(lib.issueUrl({ version: '2.0.0', device: 'picco' }, 'failed for <server>'));
  assert.equal(url.origin + url.pathname, 'https://github.com/ngocmanh1609/bookorbit-sync-crosspoint-plugin/issues/new');
  assert.equal(url.searchParams.get('template'), 'bug_report.yml');
  assert.equal(url.searchParams.get('firmware'), '2.0.0');
  assert.equal(url.searchParams.get('title'), 'Problem: failed for <server>');
});

test('card: logs its own uncaught errors and ignores other scripts', async () => {
  const { lib, reader, registered, document } = setup();
  await registered[0](document.getElementById('c'), reader.api);
  const win = document.defaultView;
  const fire = (filename, message) => {
    const ev = new win.Event('error');
    ev.filename = filename;
    ev.error = new Error(message);
    win.dispatchEvent(ev);
  };
  fire('http://192.168.1.9/plugin?name=cp-orbit&file=plugin.js', 'ours broke');
  fire('http://192.168.1.9/plugin?name=other&file=plugin.js', 'theirs broke');
  const download = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Download log');
  download.dispatchEvent(new win.Event('click'));
  await waitFor(() => /ours broke/.test(reader.readText(lib.LOG_PATH) || ''));
  const text = reader.readText(lib.LOG_PATH);
  assert.match(text, /ERROR uncaught[^\n]*\nours broke/);
  assert.doesNotMatch(text, /theirs broke/);
});

test('card: mistakes in the form are shown, not logged', async () => {
  const { lib, reader, registered, document } = setup();
  const container = document.getElementById('c');
  await registered[0](container, reader.api);
  const click = (label) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label).dispatchEvent(new document.defaultView.Event('click'));
  click('Save');
  await waitFor(() => /Enter the BookOrbit server address/.test(container.textContent));
  click('Download log');
  await waitFor(() => /Log saved/.test(container.textContent));
  assert.equal(reader.sd.has(lib.LOG_PATH), false, 'nothing was logged');
});

test('card: a crash while drawing shows a way to report it, with the error logged', async () => {
  const { lib, reader, registered, document } = setup();
  const real = document.getElementById('c');
  // The card builds <select>s and the fallback panel does not: failing there crashes only the card.
  const doc = new Proxy(document, {
    get: (t, k) => (k === 'createElement' ? (tag) => (tag === 'select' ? (() => { throw new Error('select is broken'); })() : t.createElement(tag)) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]),
  });
  const container = { ownerDocument: doc, replaceChildren: (...kids) => real.replaceChildren(...kids) };
  registered[0](container, reader.api);
  assert.match(real.textContent, /The BookOrbit card could not load: select is broken/);
  const download = Array.from(real.querySelectorAll('button')).find((b) => b.textContent === 'Download log');
  download.dispatchEvent(new document.defaultView.Event('click'));
  await waitFor(() => reader.sd.has(lib.LOG_PATH));
  assert.match(reader.readText(lib.LOG_PATH), /ERROR render[^\n]*\nselect is broken\nstack:/);
});
