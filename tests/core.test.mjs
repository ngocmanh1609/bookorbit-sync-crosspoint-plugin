import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fakeReader, loadPlugin, makeEpub, encodeStoreRef, plain, PAYLOAD, PLUGIN_DIR } from './helpers.mjs';
import { createBookOrbit, md5hex } from './mock-bookorbit.mjs';

const { lib } = loadPlugin(fakeReader({ bookorbit: createBookOrbit() }));
const nodeMd5 = (b) => createHash('md5').update(b).digest('hex');

// ------------------------------------------------------------------ hashing

test('md5 matches the RFC 1321 test suite', () => {
  const vectors = {
    '': 'd41d8cd98f00b204e9800998ecf8427e',
    a: '0cc175b9c0f1b6a831c399e269772661',
    abc: '900150983cd24fb0d6963f7d28e17f72',
    'message digest': 'f96b697d7cb7938d525a2f31aaf161d0',
    abcdefghijklmnopqrstuvwxyz: 'c3fcd3d76192e4007dfb496cca67e13b',
    ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789: 'd174ab98d277d9f5a5611c2c9f419d9f',
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890': '57edf4a22be3c955ac49da2e2107b67a',
  };
  for (const [input, hex] of Object.entries(vectors)) assert.equal(lib.md5(input), hex, JSON.stringify(input));
  for (const n of [55, 56, 63, 64, 65, 1000]) {
    const b = randomBytes(n);
    assert.equal(lib.md5(new Uint8Array(b)), nodeMd5(b), 'length ' + n);
  }
  assert.equal(lib.md5('héllo ✓'), nodeMd5(Buffer.from('héllo ✓', 'utf8')));
});

test('partial MD5 samples 1 KiB at 0 and 1024*4^i like KOReader', () => {
  const reference = (b) => {
    const h = createHash('md5');
    for (let i = -1; i <= 10; i++) {
      const off = i < 0 ? 0 : 1024 << (2 * i);
      if (off >= b.length) break;
      h.update(b.subarray(off, off + 1024));
    }
    return h.digest('hex');
  };
  for (const n of [10, 1024, 1025, 5000, 70000, 3 * 1024 * 1024]) {
    const b = randomBytes(n);
    assert.equal(lib.partialMd5(new Uint8Array(b)), reference(b), 'size ' + n);
  }
});

test('clipping store path uses the reader\'s 32-bit std::hash', () => {
  // Value observed for this path on a CrossPoint reader (cross-checked against an independent implementation).
  assert.equal(lib.hashPath('/Books/Test/Book.epub'), 2361001545);
  assert.equal(lib.clippingStorePath('/Books/Test/Book.epub'), '/.crosspoint/clippings/epub_2361001545.bin');
  assert.ok(lib.hashPath('/Bücher/Ä.epub') >= 0);
});

// ----------------------------------------------------------- clipping store

const SAMPLE = {
  title: 'Nineteen Eighty-Four',
  author: 'George Orwell',
  path: '/Books/1984.epub',
  records: [
    { spine: 2, startPage: 3, endPage: 4, pageCount: 20, startWord: 5, endWord: 9, wordCount: 5, paragraph: 7, timestamp: 1767225600, layoutSig: 0xdeadbeef, startOffset: 120, endOffset: 145, revLo: 7, revHi: 1, pending: 0, id: 'abc123', chapter: 'Part One', text: 'It was a bright cold day' },
    { spine: 0, timestamp: 0, startOffset: 0xffffffff, endOffset: 0xffffffff, chapter: 'Ünïcode chapter', text: 'émoji 😀 text' },
  ],
};

test('store: parses the firmware format and writes it back byte for byte', () => {
  const bytes = encodeStoreRef(SAMPLE);
  const store = lib.parseStore(bytes);
  assert.equal(store.version, 4);
  assert.equal(store.title, SAMPLE.title);
  assert.equal(store.path, SAMPLE.path);
  assert.equal(store.records.length, 2);
  const r = store.records[0];
  for (const k of ['spine', 'startPage', 'endPage', 'pageCount', 'startWord', 'endWord', 'wordCount', 'paragraph', 'timestamp', 'layoutSig', 'startOffset', 'endOffset', 'revLo', 'revHi', 'pending', 'id', 'chapter', 'text']) {
    assert.equal(r[k], SAMPLE.records[0][k], k);
  }
  assert.equal(store.records[1].text, 'émoji 😀 text');
  assert.deepEqual(lib.buildStore(store), bytes);
});

test('store: reads versions 1 and 3 and upgrades them to version 4', () => {
  for (const version of [1, 3]) {
    const store = lib.parseStore(encodeStoreRef({ ...SAMPLE, version }));
    assert.equal(store.records[0].text, SAMPLE.records[0].text);
    assert.equal(store.records[0].startOffset, 0xffffffff, 'no offsets before version 4');
    const again = lib.parseStore(lib.buildStore(store));
    assert.equal(again.version, 4);
    assert.equal(again.records[1].chapter, SAMPLE.records[1].chapter);
  }
});

test('store: refuses unknown versions and damaged files instead of guessing', () => {
  const bytes = encodeStoreRef(SAMPLE);
  bytes[0] = 9;
  assert.throws(() => lib.parseStore(bytes), /version 9/);
  assert.throws(() => lib.parseStore(encodeStoreRef(SAMPLE).subarray(0, 60)), /truncated/);
});

test('store: long chapter titles and texts are cut at UTF-8 boundaries', () => {
  const store = lib.parseStore(encodeStoreRef({ ...SAMPLE, records: [] }));
  store.records.push({ ...SAMPLE.records[0], chapter: 'é'.repeat(40), textBytes: undefined, text: 'ß'.repeat(3000) });
  const back = lib.parseStore(lib.buildStore(store)).records[0];
  assert.equal(back.chapter, 'é'.repeat(23)); // 47 bytes max -> 23 two-byte characters
  assert.equal(back.text, 'ß'.repeat(2048)); // 4096 bytes max
});

// ------------------------------------------------------------- positions

const CH_BASIC = '\n  <p>Hello <b>big</b> world</p>\n  <p>Second   para&nbsp;here</p>\n';
const chapter = (body) => lib.parseChapter(`<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body>${body}</body></html>`);

test('xpointers: element steps, text() runs and collapsed whitespace match crengine', () => {
  const m = chapter(CH_BASIC);
  assert.equal(m.isXml, true, 'named entities are resolved before XML parsing');
  assert.equal(lib.visibleSlice(m, 9, 12), 'big');
  assert.equal(lib.xpointerFor(m, 0, 9, false), '/body/DocFragment[1]/body/p[1]/b/text().0');
  assert.equal(lib.xpointerFor(m, 0, 12, true), '/body/DocFragment[1]/body/p[1]/b/text().3');
  assert.equal(lib.visibleSlice(m, 13, 18), 'world');
  assert.equal(lib.xpointerFor(m, 0, 13, false), '/body/DocFragment[1]/body/p[1]/text()[2].1');
  assert.equal(lib.xpointerFor(m, 0, 18, true), '/body/DocFragment[1]/body/p[1]/text()[2].6');
  assert.equal(lib.visibleSlice(m, 30, 34), 'para');
  assert.equal(lib.xpointerFor(m, 4, 30, false), '/body/DocFragment[5]/body/p[2]/text().7', 'two extra spaces collapse');
  assert.equal(lib.xpointerFor(m, 4, 34, true), '/body/DocFragment[5]/body/p[2]/text().11');
});

test('xpointers resolve back to the same reader offsets', () => {
  const m = chapter(CH_BASIC);
  for (const [start, end] of [[9, 12], [13, 18], [30, 34], [21, 39]]) {
    const p0 = lib.parseXPointer(lib.xpointerFor(m, 0, start, false));
    const p1 = lib.parseXPointer(lib.xpointerFor(m, 0, end, true));
    assert.equal(lib.visibleAt(m, p0, false), start);
    assert.equal(lib.visibleAt(m, p1, true), end);
  }
  assert.equal(lib.visibleAt(m, lib.parseXPointer('/body/DocFragment[1]/body/p[9]/text().0'), false), null);
});

test('reader offsets skip <rp>, xpointer runs count it, emoji count as one character', () => {
  const ruby = chapter('<p>A<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>B</p>');
  assert.equal(ruby.text, 'A漢kanB');
  assert.equal(lib.xpointerFor(ruby, 1, 5, false), '/body/DocFragment[2]/body/p/text()[2].0');
  const emoji = chapter('<p>x😀y</p>');
  assert.equal(lib.visibleSlice(emoji, 2, 3), 'y');
  assert.equal(lib.xpointerFor(emoji, 0, 2, false), '/body/DocFragment[1]/body/p/text().2');
  const hidden = chapter('<style>p{}</style><p>visible</p><script>x()</script>');
  assert.equal(hidden.text, 'visible');
});

test('text search folds quotes and whitespace and needs a hint for repeated text', () => {
  const m = chapter('<p>the cat sat.</p><p>Then   the cat “ran”.</p>');
  assert.deepEqual(plain(lib.findText(m, 'the cat', null)), { ambiguous: true });
  const exact = lib.findText(m, 'Then the', null);
  assert.equal(lib.visibleSlice(m, exact.start, exact.end), 'Then   the', 'whitespace runs match one space');
  const near = lib.findText(m, 'the cat', 16);
  assert.equal(lib.visibleSlice(m, near.start, near.end), 'the cat');
  assert.ok(near.start > 13);
  const quoted = lib.findText(m, 'cat "ran"', null);
  assert.equal(lib.visibleSlice(m, quoted.start, quoted.end), 'cat “ran”');
  assert.equal(lib.findText(m, 'not here', null), null);
});

// ------------------------------------------------------- highlight exchange

const CFG = { server: 'http://bo.local:3000', user: 'reader', key: md5hex('secret'), device_id: 'a'.repeat(64) };
const BOOK = '/Books/1984.epub';
const CH0 = '<p>It was a bright cold day in April.</p><p>The clocks were striking thirteen.</p>';
const CH1 = '<p>Winston Smith, his chin nuzzled into his breast.</p>';

async function scenario({ records, bookorbit = createBookOrbit(), path = BOOK, register = true } = {}) {
  const epub = await makeEpub([{ body: CH0 }, { body: CH1 }]);
  const hash = lib.partialMd5(epub);
  if (register) bookorbit.addBook(hash);
  const files = { [path]: epub };
  const recs = records || [
    { spine: 0, timestamp: 1767225600, startOffset: 9, endOffset: 24, chapter: 'One', text: 'bright cold day' },
    { spine: 1, timestamp: 1767225700, startOffset: 0, endOffset: 13, chapter: 'Two', text: 'Winston Smith' },
  ];
  if (recs.length) files[lib.clippingStorePath(path)] = encodeStoreRef({ title: '1984', author: 'Orwell', path, records: recs });
  const reader = fakeReader({ bookorbit, files });
  const { lib: plugin } = loadPlugin(reader);
  const ctx = { api: reader.api, cfg: CFG, bo: plugin.boClient(reader.api, CFG), cap: 1024, now: () => new Date(2026, 10, 10, 12, 0, 0) };
  const sync = (p = path) => plugin.syncHighlights(ctx, { path: p, title: '1984', author: 'Orwell' }, () => {});
  const store = (p = path) => plugin.parseStore(reader.sd.get(plugin.clippingStorePath(p)));
  const exchanges = () => bookorbit.calls.filter((c) => c.path.endsWith('/annotations/exchange'));
  const acks = () => bookorbit.calls.filter((c) => c.path.endsWith('/exchange-ack'));
  return { bookorbit, reader, plugin, hash, sync, store, exchanges, acks };
}

test('sync: sends device highlights with real xpointers and pulls web highlights into the reader', async () => {
  const s = await scenario();
  const web = s.bookorbit.addWebHighlight(s.hash, { text: 'clocks were striking thirteen', pos0: '/body/DocFragment[1]/body/p[2]/text().4', pos1: '/body/DocFragment[1]/body/p[2]/text().33', chapter: 'One' });
  const r = await s.sync();
  assert.deepEqual([r.sent, r.added, r.failed, r.unresolved], [2, 1, 0, 0]);

  const first = s.exchanges()[0].body.books[0];
  assert.equal(first.sidecarState, 'new');
  assert.equal(first.keysComplete, true);
  assert.equal(first.keys.length, 2);
  const sent = Object.fromEntries(first.changes.map((c) => [c.text, c]));
  assert.equal(sent['bright cold day'].pos0, '/body/DocFragment[1]/body/p[1]/text().9');
  assert.equal(sent['bright cold day'].pos1, '/body/DocFragment[1]/body/p[1]/text().24');
  assert.equal(sent['Winston Smith'].pos0, '/body/DocFragment[2]/body/p/text().0');
  assert.equal(sent['Winston Smith'].pos1, '/body/DocFragment[2]/body/p/text().13');
  for (const c of first.changes) assert.ok(first.keys.some((k) => k.k === md5hex(c.datetime + '|' + c.pos0) && k.dt === c.datetime), 'key = md5(datetime|pos0)');

  const recs = s.store().records;
  assert.equal(recs.length, 3);
  const pulled = recs.find((x) => x.text === 'clocks were striking thirteen');
  assert.deepEqual([pulled.spine, pulled.startOffset, pulled.endOffset], [0, 38, 67]);
  const ack = s.acks()[0].body.books[0];
  assert.deepEqual(plain(ack.applied), [{ serverId: web.id, version: 1, status: 'applied', verified: true }]);
  assert.ok(s.reader.sd.has('/.cp-orbit/state/' + s.hash + '.json'));
  assert.ok(s.reader.sd.has('/.cp-orbit/backup/' + s.plugin.clippingStorePath(BOOK).split('/').pop()), 'backup before the first write');

  const again = await s.sync();
  assert.equal(s.plugin.describeSync(again), 'Already in sync.');
  const second = s.exchanges().at(-1).body.books[0];
  assert.deepEqual([second.sidecarState, second.changes.length, second.keys.length], ['known', 0, 3]);
  assert.equal(s.store().records.length, 3);
  assert.equal(s.bookorbit.live(s.hash).length, 3);
});

test('sync: a highlight deleted on the reader is deleted in BookOrbit, and the other way round', async () => {
  const s = await scenario();
  const web = s.bookorbit.addWebHighlight(s.hash, { text: 'clocks were striking thirteen', pos0: '/body/DocFragment[1]/body/p[2]/text().4', pos1: '/body/DocFragment[1]/body/p[2]/text().33' });
  await s.sync();

  const store = s.store();
  store.records = store.records.filter((r) => r.text !== 'Winston Smith');
  s.reader.sd.set(s.plugin.clippingStorePath(BOOK), s.plugin.buildStore(store));
  await s.sync();
  assert.deepEqual(s.bookorbit.live(s.hash).map((a) => a.text).sort(), ['bright cold day', 'clocks were striking thirteen']);

  s.bookorbit.deleteHighlight(s.hash, web.id);
  const r = await s.sync();
  assert.equal(r.deleted, 1);
  assert.deepEqual(plain(s.store().records.map((x) => x.text)), ['bright cold day']);
  assert.deepEqual(s.acks().at(-1).body.books[0].deleted, [{ serverId: web.id, status: 'applied' }]);
});

test('sync: a BookOrbit highlight that cannot be found in the book is acknowledged as failed, never guessed', async () => {
  const s = await scenario({ records: [] });
  const ghost = s.bookorbit.addWebHighlight(s.hash, { text: 'words that are not in this book', pos0: '/body/DocFragment[1]/body/p[7]/text().0', pos1: '/body/DocFragment[1]/body/p[7]/text().9' });
  const r = await s.sync();
  assert.equal(r.failed, 1);
  assert.equal(s.reader.sd.has(s.plugin.clippingStorePath(BOOK)), false, 'nothing written');
  assert.deepEqual(s.acks()[0].body.books[0].applied, [{ serverId: ghost.id, version: 1, status: 'failed' }]);
});

test('sync: a book BookOrbit does not know is reported and nothing is written', async () => {
  const s = await scenario({ register: false });
  const r = await s.sync();
  assert.equal(r.unmatched, true);
  assert.match(s.plugin.describeSync(r), /does not have this exact file/);
  assert.deepEqual(s.reader.writes, []);
});

test('sync: a copied book with no highlight file is exchanged as new and deletes nothing', async () => {
  const s = await scenario();
  await s.sync();
  const copy = '/Books/Copy of 1984.epub';
  s.reader.sd.set(copy, s.reader.sd.get(BOOK));
  const r = await s.sync(copy);
  const call = s.exchanges().at(-1).body.books[0];
  assert.equal(call.sidecarState, 'new');
  assert.equal(s.bookorbit.live(s.hash).length, 2, 'BookOrbit keeps every highlight');
  assert.equal(r.added, 2);
  assert.equal(s.store(copy).records.length, 2);
});

test('sync: re-offered highlights the reader already has are adopted, not duplicated', async () => {
  const s = await scenario();
  await s.sync();
  s.reader.sd.delete('/.cp-orbit/state/' + s.hash + '.json'); // lost sync state
  const r = await s.sync();
  assert.equal(r.added, 0);
  assert.equal(s.store().records.length, 2);
  assert.equal(s.bookorbit.live(s.hash).length, 2);
});

test('sync: never acknowledges what it could not write to the reader', async () => {
  const s = await scenario({ records: [] });
  s.bookorbit.addWebHighlight(s.hash, { text: 'clocks were striking thirteen', pos0: '/body/DocFragment[1]/body/p[2]/text().4', pos1: '/body/DocFragment[1]/body/p[2]/text().33' });
  s.reader.failWrites = (p) => p.startsWith('/.crosspoint/clippings/');
  await assert.rejects(s.sync(), /413/);
  assert.equal(s.acks().length, 0);
});

test('sync: many new highlights go out in batches of 50 with unique datetimes', async () => {
  const lines = Array.from({ length: 120 }, (_, i) => `Line number ${String(i).padStart(3, '0')} is here.`);
  const epubBody = lines.map((l) => `<p>${l}</p>`).join('');
  const bookorbit = createBookOrbit();
  const epub = await makeEpub([{ body: epubBody }]);
  const reader = fakeReader({ bookorbit, files: { [BOOK]: epub } });
  const { lib: plugin } = loadPlugin(reader);
  bookorbit.addBook(plugin.partialMd5(epub));
  let off = 0;
  const records = lines.map((l) => {
    const r = { spine: 0, timestamp: 0, startOffset: off, endOffset: off + l.length, text: l };
    off += l.length;
    return r;
  });
  reader.sd.set(plugin.clippingStorePath(BOOK), encodeStoreRef({ title: 'T', author: 'A', path: BOOK, records }));
  const ctx = { api: reader.api, cfg: CFG, bo: plugin.boClient(reader.api, CFG), cap: 1024, now: () => new Date(2026, 10, 10, 12, 0, 0) };
  const r = await plugin.syncHighlights(ctx, { path: BOOK }, () => {});
  assert.equal(r.sent, 120);
  const calls = bookorbit.calls.filter((c) => c.path.endsWith('/annotations/exchange')).map((c) => c.body.books[0]);
  assert.deepEqual(calls.map((b) => b.changes.length), [50, 50, 20]);
  assert.deepEqual(calls.map((b) => b.keys.length), [120, 0, 0]);
  const dts = calls.flatMap((b) => b.changes.map((c) => c.datetime));
  assert.equal(new Set(dts).size, 120);
});

// ------------------------------------------------------------ BookOrbit client

test('client: falls back to /api/fetch when an answer is over the relay cap', async () => {
  const bookorbit = createBookOrbit();
  bookorbit.catalog.books = Array.from({ length: 900 }, (_, i) => ({ id: i + 1, title: 'A long enough title number ' + i, authors: ['Someone With A Name'], formats: ['epub'] }));
  const reader = fakeReader({ bookorbit });
  const { lib: plugin } = loadPlugin(reader);
  const bo = plugin.boClient(reader.api, CFG);
  const page = await bo.get('/api/v1/koreader/plugin/catalog/books?page=1&size=20');
  assert.equal(page.items.length, 900);
  assert.equal(reader.sd.has('/.cp-orbit/tmp/response.json'), true);
  await assert.rejects(plugin.boClient(reader.api, { ...CFG, key: 'wrong' }).get('/api/v1/koreader/users/auth'), /refused the login/);
});

// ------------------------------------------------------------ reader settings

test('KOSync: points the reader\'s progress sync at BookOrbit with binary matching', async () => {
  const reader = fakeReader({ bookorbit: createBookOrbit() });
  const { lib: plugin } = loadPlugin(reader);
  const r = await plugin.applyKosync(CFG, 'secret', true, () => true);
  assert.deepEqual(plain(reader.settingsPosts), [
    { koServerUrl: 'http://bo.local:3000/api/v1/koreader', koUsername: 'reader', koPassword: 'secret', koServerType: 1, koMatchMethod: 1, koSyncBehavior: 0, koSyncClippings: 0 },
  ]);
  assert.deepEqual(plain(r.skipped), []);
  assert.equal(reader.settings.koSyncClippings.value, 0, 'clipping sync (reported as a toggle) is turned off, or Sync progress fails');
  await plugin.applyKosync(CFG, '', false, () => true);
  assert.equal('koPassword' in reader.settingsPosts[1], false, 'no password typed: the reader keeps its own');
  assert.equal(reader.settingsPosts[1].koSyncBehavior, 1);
});

test('KOSync: asks before replacing another sync server, and skips settings it cannot verify', async () => {
  const reader = fakeReader({ bookorbit: createBookOrbit() });
  reader.settings.koServerUrl.value = 'https://sync.koreader.rocks';
  const { lib: plugin } = loadPlugin(reader);
  assert.deepEqual(plain(await plugin.applyKosync(CFG, "secret", true, () => false)), { declined: true });
  assert.equal(reader.settingsPosts.length, 0);
  reader.settings.koServerType.options = ['A', 'B', 'C', 'D'];
  const r = await plugin.applyKosync(CFG, 'secret', true, () => true);
  assert.deepEqual(plain(r.skipped), ["koServerType"]);
  assert.equal('koServerType' in reader.settingsPosts[0], false);
});

// --------------------------------------------------------- shelves and updates

const DEVICE_JSON = readFileSync(PAYLOAD + 'device.json', 'utf8');

test('shelves: collections and SmartScopes become catalog lists within the 8KB manifest cap', async () => {
  const bookorbit = createBookOrbit();
  const reader = fakeReader({ bookorbit, files: { [PLUGIN_DIR + '/device.json']: DEVICE_JSON } });
  const { lib: plugin } = loadPlugin(reader);
  const r = await plugin.updateShelves(reader.api, plugin.boClient(reader.api, CFG));
  assert.equal(r.kept, 2);
  const lists = reader.readJson(PLUGIN_DIR + '/device.json').browse.lists;
  assert.deepEqual(lists.filter((l) => l.shelf).map((l) => l.title), ['Collection: Favourites', 'SmartScope: Short reads']);
  assert.match(lists.find((l) => l.shelf).url, /collectionId=7&.*page=\{page\}&size=\{limit\}/);
  assert.equal(lists.filter((l) => !l.shelf).length, 5, 'built-in lists kept');
  const many = plugin.shelfLists(Array.from({ length: 200 }, (_, i) => ({ id: String(i), title: 'Shelf ' + i })), []);
  const merged = plugin.mergeShelves(JSON.parse(DEVICE_JSON), many);
  assert.ok(new TextEncoder().encode(JSON.stringify(merged.device)).length <= 8000);
  assert.ok(merged.dropped > 0 && merged.kept > 0);
});

test('update: a fresh device.json gets the saved shelves back; settings survive in /.cp-orbit', async () => {
  const bookorbit = createBookOrbit();
  const reader = fakeReader({ bookorbit, files: { [PLUGIN_DIR + '/device.json']: DEVICE_JSON } });
  const { lib: plugin } = loadPlugin(reader);
  await plugin.updateShelves(reader.api, plugin.boClient(reader.api, CFG));
  reader.sd.set(PLUGIN_DIR + '/device.json', new TextEncoder().encode(DEVICE_JSON)); // the update replaced the folder
  assert.equal(await plugin.restoreShelves(reader.api), 2);
  assert.equal(reader.readJson(PLUGIN_DIR + '/device.json').browse.lists.filter((l) => l.shelf).length, 2);
  assert.equal(await plugin.restoreShelves(reader.api), 0, 'nothing to do when they are there');
});

// ----------------------------------------------------------------------- UI

async function waitFor(fn, ms = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('card: loads saved settings after an update, saves only to /.cp-orbit and sets up progress sync', async () => {
  const bookorbit = createBookOrbit();
  const reader = fakeReader({
    bookorbit,
    files: {
      [PLUGIN_DIR + '/device.json']: DEVICE_JSON,
      '/.cp-orbit/config.json': JSON.stringify({ server: 'http://bo.local:3000', user: 'reader', key: md5hex('old'), device_id: 'kept-id', dest_dir: '/Books/BO' }),
      '/.cp-orbit/shelves.json': JSON.stringify({ lists: [{ title: 'Collection: Favourites', url: '{cfg.server}/x?page={page}&size={limit}', shelf: true }] }),
      '/.crosspoint/recent.json': JSON.stringify({ books: [{ path: '/Books/1984.epub', title: '1984', author: 'Orwell' }, { path: '/Books/notes.txt', title: 'Notes' }] }),
    },
  });
  const { registered, document } = loadPlugin(reader);
  assert.equal(registered.length, 1, 'registers synchronously');
  const container = document.getElementById('c');
  await registered[0](container, reader.api);
  const inputs = container.querySelectorAll('input');
  assert.equal(inputs[0].value, 'http://bo.local:3000');
  assert.equal(inputs[1].value, 'reader');
  assert.equal(inputs[3].value, '/Books/BO');
  assert.match(container.textContent, /Shelves restored \(1\)/);
  assert.equal(container.querySelectorAll('select')[1].querySelectorAll('option').length, 2, 'EPUBs only, plus "another book"');

  inputs[2].value = 'secret';
  const save = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save');
  save.dispatchEvent(new document.defaultView.Event('click'));
  await waitFor(() => /Saved\./.test(container.textContent) || /refused|Enter/.test(container.textContent));
  assert.match(container.textContent, /Saved\. Reader progress sync now uses BookOrbit/);
  const cfg = reader.readJson('/.cp-orbit/config.json');
  assert.deepEqual(cfg, { server: 'http://bo.local:3000', user: 'reader', key: md5hex('secret'), device_id: 'kept-id', dest_dir: '/Books/BO' });
  assert.equal(JSON.stringify(cfg).includes('secret'), false, 'only the md5 is stored');
  assert.equal(reader.settingsPosts[0].koServerUrl, 'http://bo.local:3000/api/v1/koreader');
  for (const p of reader.writes) assert.ok(p.startsWith('/.cp-orbit/') || p === PLUGIN_DIR + '/device.json', 'unexpected write ' + p);

  const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
  assert.ok(labels.includes('Show status & rating') && labels.includes('Save status & rating'));
  const saveStatus = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save status & rating');
  saveStatus.dispatchEvent(new document.defaultView.Event('click'));
  await waitFor(() => /Press Show status & rating/.test(container.textContent));
  assert.equal(bookorbit.calls.some((c) => c.method === 'PUT'), false, 'nothing is sent before the status was shown');
});
