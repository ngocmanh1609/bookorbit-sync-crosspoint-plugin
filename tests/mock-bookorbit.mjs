// In-process mock of the BookOrbit KOReader plugin API, built from the server source
// (koreader-plugin.dto.ts, koreader-exchange.dto.ts, annotation-sync.service.ts).
// It validates request shapes like the server's DTOs and models the annotation
// exchange closely enough to test the plugin's orchestration.
import { createHash } from 'node:crypto';

const MD5_HEX = /^[0-9a-f]{32}$/i;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
export const md5hex = (s) => createHash('md5').update(s).digest('hex');
const isInt = (v, min, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;

function check(cond, msg) {
  if (!cond) {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  }
}

function checkDevice(body) {
  check(DEVICE_ID.test(body.deviceId || ''), 'deviceId must match ' + DEVICE_ID);
  check(typeof body.deviceModel === 'string' && body.deviceModel.length <= 100, 'deviceModel');
  check(typeof body.pluginVersion === 'string' && body.pluginVersion.length <= 20, 'pluginVersion must be <= 20 chars');
  check(body.deviceTime === undefined || DATETIME.test(body.deviceTime), 'deviceTime');
}

export function checkPageStats(body) {
  checkDevice(body);
  check(Array.isArray(body.books) && body.books.length >= 1 && body.books.length <= 50, 'books 1..50');
  for (const b of body.books) {
    check(MD5_HEX.test(b.hash || ''), 'hash md5');
    check(Array.isArray(b.events) && b.events.length >= 1, 'events');
    for (const e of b.events) {
      check(isInt(e.page, 0), 'page int >= 0');
      check(isInt(e.startTime, 1), 'startTime int >= 1');
      check(isInt(e.durationSeconds, 0, 86400), 'durationSeconds 0..86400');
      check(isInt(e.totalPages, 1), 'totalPages int >= 1');
    }
  }
}

function checkAnnotation(a) {
  check(DATETIME.test(a.datetime || ''), 'annotation datetime');
  check(['lighten', 'underscore', 'strikeout', 'invert'].includes(a.drawer), 'drawer');
  check(a.text === undefined || (typeof a.text === 'string' && a.text.length <= 10000), 'text');
  check(a.chapter === undefined || (typeof a.chapter === 'string' && a.chapter.length <= 500), 'chapter');
  check(['xpointer', 'pdf'].includes(a.posFormat), 'posFormat');
  check(typeof a.pos0 === 'string' && a.pos0.length <= 4000, 'pos0');
  check(a.pos1 === undefined || (typeof a.pos1 === 'string' && a.pos1.length <= 4000), 'pos1');
}

export function createBookOrbit({ user = 'reader', password = 'secret' } = {}) {
  const key = md5hex(password);
  const books = new Map(); // hash -> { bookId, annotations: Map<id, ann>, states: Map<deviceId, Map<id, state>> }
  const calls = [];
  let nextId = 1;
  const catalog = {
    books: [
      { id: 11, title: 'Alpha', authors: ['Ann Author'], formats: ['epub'] },
      { id: 12, title: 'Beta', authors: [], formats: ['epub', 'pdf'] },
    ],
    libraries: [{ id: '3', title: 'Fiction', section: 'libraries', booksHref: '/api/v1/koreader/plugin/catalog/books?libraryId=3&sort=title' }],
    collections: [{ id: '7', title: 'Favourites', section: 'collections' }],
    scopes: [{ id: '9', title: 'Short reads', section: 'smart-scopes' }],
  };

  const bo = {
    calls,
    catalog,
    books,
    addBook(hash, bookId = 100 + books.size) {
      books.set(hash, { bookId, annotations: new Map(), states: new Map() });
      return bookId;
    },
    /** A highlight made in the web reader; the server mints its device datetime. */
    addWebHighlight(hash, { text, pos0, pos1, chapter = null, datetime = '2026-11-01 10:00:00' }) {
      const ann = { id: nextId++, version: 1, datetime, text, pos0, pos1, chapter, deleted: false, origin: 'web' };
      books.get(hash).annotations.set(ann.id, ann);
      return ann;
    },
    deleteHighlight(hash, id) {
      const ann = books.get(hash).annotations.get(id);
      ann.deleted = true;
      ann.version++;
    },
    live(hash) {
      return [...books.get(hash).annotations.values()].filter((a) => !a.deleted);
    },
  };

  const deviceStates = (book, deviceId) => {
    if (!book.states.has(deviceId)) book.states.set(deviceId, new Map());
    return book.states.get(deviceId);
  };

  function exchange(body) {
    checkDevice(body);
    check(Array.isArray(body.books) && body.books.length >= 1 && body.books.length <= 20, 'books 1..20');
    const total = body.books.reduce((n, b) => n + b.changes.length, 0);
    check(total <= 50, 'Too many annotation changes in one request (max 50)');
    const results = [];
    const unmatched = [];
    for (const b of body.books) {
      check(MD5_HEX.test(b.hash), 'hash');
      check(Array.isArray(b.keys) && b.keys.length <= 5000, 'keys');
      for (const k of b.keys) check(MD5_HEX.test(k.k) && DATETIME.test(k.dt), 'key entry');
      check(typeof b.keysComplete === 'boolean', 'keysComplete');
      check(b.sidecarState === undefined || ['known', 'new'].includes(b.sidecarState), 'sidecarState');
      b.changes.forEach(checkAnnotation);
      const book = books.get(b.hash);
      if (!book) {
        unmatched.push(b.hash);
        continue;
      }
      const states = deviceStates(book, body.deviceId);
      const lostCopy = b.sidecarState === 'new';
      if (lostCopy) for (const st of states.values()) st.appliedVersion = 0;
      for (const c of b.changes) {
        const existing = [...book.annotations.values()].find((a) => !a.deleted && a.datetime === c.datetime);
        if (existing) {
          existing.pos0 = c.pos0; // a known datetime with a new position is a move
          existing.pos1 = c.pos1;
          states.set(existing.id, { key: md5hex(c.datetime + '|' + c.pos0), appliedVersion: existing.version });
          continue;
        }
        const ann = { id: nextId++, version: 1, datetime: c.datetime, text: c.text, pos0: c.pos0, pos1: c.pos1, chapter: c.chapter || null, deleted: false, origin: 'device' };
        book.annotations.set(ann.id, ann);
        states.set(ann.id, { key: md5hex(c.datetime + '|' + c.pos0), appliedVersion: ann.version });
      }
      if (b.keysComplete && !lostCopy) {
        const present = new Set(b.keys.map((k) => k.k));
        const dts = new Set(b.keys.map((k) => k.dt));
        for (const [id, st] of states) {
          const ann = book.annotations.get(id);
          if (!ann || ann.deleted || st.appliedVersion === 0 || present.has(st.key) || dts.has(ann.datetime)) continue;
          ann.deleted = true;
          ann.version++;
          st.deleteAcked = true;
        }
      }
      const add = [];
      const edit = [];
      const del = [];
      for (const ann of book.annotations.values()) {
        const st = states.get(ann.id);
        if (ann.deleted) {
          if (st && !st.deleteAcked) del.push({ serverId: ann.id, key: st.key, datetime: ann.datetime });
          continue;
        }
        if (!st || st.appliedVersion === 0) {
          add.push({ serverId: ann.id, version: ann.version, datetime: ann.datetime, datetimeUpdated: null, drawer: 'lighten', color: 'yellow', text: ann.text, note: null, chapter: ann.chapter, posFormat: 'xpointer', pos0: ann.pos0, pos1: ann.pos1, pageno: null });
        } else if (st.appliedVersion < ann.version) {
          edit.push({ serverId: ann.id, version: ann.version, key: st.key, datetime: ann.datetime, datetimeUpdated: '2026-11-02 09:00:00', drawer: 'lighten', color: 'yellow', text: ann.text, note: null, chapter: ann.chapter });
        }
      }
      results.push({ hash: b.hash, bookId: book.bookId, applied: { upserted: b.changes.length }, toApply: { add: add.slice(0, 100), edit, delete: del }, more: add.length > 100, skippedNoPosition: 0 });
    }
    return { results, unmatched, positionIncompatible: [] };
  }

  function exchangeAck(body) {
    checkDevice(body);
    for (const b of body.books) {
      check(Array.isArray(b.applied) && b.applied.length <= 200 && Array.isArray(b.deleted) && b.deleted.length <= 200, 'ack arrays');
      const book = books.get(b.hash);
      const states = deviceStates(book, body.deviceId);
      for (const e of b.applied) {
        check(isInt(e.serverId, 1) && isInt(e.version, 1) && ['applied', 'failed'].includes(e.status), 'ack entry');
        const ann = book.annotations.get(e.serverId);
        if (!ann || e.version !== ann.version || e.status === 'failed') continue;
        states.set(ann.id, { key: md5hex(ann.datetime + '|' + (e.pos0 || ann.pos0)), appliedVersion: e.verified === false ? 0 : e.version });
      }
      for (const e of b.deleted) {
        const st = states.get(e.serverId);
        if (st && e.status === 'applied') st.deleteAcked = true;
      }
    }
    return { results: body.books.map((b) => ({ hash: b.hash, acked: b.applied.length + b.deleted.length })), unmatched: [], positionIncompatible: [] };
  }

  function catalogBooks(q) {
    check(isInt(Number(q.get('page') || 1), 1), 'page');
    check(isInt(Number(q.get('size') || 20), 1, 100), 'size 1..100');
    if (q.has('sort')) check(['title', 'author', 'published', 'recently_added', 'recently_updated', 'recently_read', 'series'].includes(q.get('sort')), 'sort');
    if (q.has('order')) check(['asc', 'desc'].includes(q.get('order')), 'order');
    if (q.has('readStatus')) check(['unread', 'reading', 'finished'].includes(q.get('readStatus')), 'readStatus');
    for (const id of ['libraryId', 'collectionId', 'smartScopeId']) if (q.has(id)) check(/^\d+$/.test(q.get(id)), id + ' must be numeric, got ' + q.get(id));
    if (q.has('format')) check(q.get('format').length <= 16, 'format');
    return { items: catalog.books, total: catalog.books.length, page: 1, size: 20, hasNext: false, hasPrevious: false, nextUrl: null, previousUrl: null };
  }

  /** Handles one request; returns { status, body } with a JSON string body. */
  function handle(method, url, headers, rawBody) {
    const u = new URL(url);
    const path = u.pathname;
    calls.push({ method, path, query: u.search, headers, body: rawBody ? JSON.parse(rawBody) : undefined });
    const authed = headers['x-auth-user'] === user && headers['x-auth-key'] === key;
    if (!path.startsWith('/api/v1/koreader/')) return { status: 404, body: '{"message":"Not Found"}' };
    if (!authed) return { status: 401, body: '{"message":"Unauthorized"}' };
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    try {
      const route = method + ' ' + path.replace('/api/v1/koreader', '');
      let out;
      if (route === 'GET /users/auth') out = { authorized: 'OK', username: user };
      else if (route === 'GET /plugin/version') out = { pluginVersion: '1.7.0', serverVersion: '0.9.0', capabilities: [] };
      else if (route === 'POST /plugin/page-stats') {
        checkPageStats(body);
        out = { results: body.books.map((b) => ({ hash: b.hash, accepted: b.events.length, duplicates: 0 })), unmatched: [] };
      } else if (route === 'POST /plugin/annotations/exchange') out = exchange(body);
      else if (route === 'POST /plugin/annotations/exchange-ack') out = exchangeAck(body);
      else if (route === 'POST /plugin/match-check') {
        checkDevice(body);
        out = { matches: body.hashes.filter((h) => books.has(h)).map((h) => ({ hash: h, bookId: books.get(h).bookId, bookFileId: 1 })), libraryVersion: 1 };
      } else if (route === 'GET /plugin/catalog/books') out = catalogBooks(u.searchParams);
      else if (route === 'GET /plugin/catalog/sections/libraries') out = { section: 'libraries', items: catalog.libraries };
      else if (route === 'GET /plugin/catalog/sections/collections') out = { section: 'collections', items: catalog.collections };
      else if (route === 'GET /plugin/catalog/sections/smart-scopes') out = { section: 'smart-scopes', items: catalog.scopes };
      else if (/^GET \/plugin\/catalog\/books\/\d+$/.test(route)) {
        const id = Number(path.split('/').pop());
        out = { id, title: 'Book ' + id, readStatus: 'reading', rating: 4, files: [{ id: 500 + id, format: 'epub', role: 'primary', downloadUrl: '/api/v1/koreader/plugin/catalog/files/' + (500 + id) + '/download', devicePath: 'Book.epub' }] };
      } else if (/^PUT \/plugin\/catalog\/books\/\d+\/read-status$/.test(route)) {
        check(['unread', 'want_to_read', 'reading', 'on_hold', 'read', 'abandoned'].includes(body.status), 'status');
        out = { readStatus: body.status };
      } else if (/^PUT \/plugin\/catalog\/books\/\d+\/rating$/.test(route)) {
        check(body.rating === null || isInt(body.rating, 0, 5), 'rating');
        out = { rating: body.rating };
      } else return { status: 404, body: '{"message":"Not Found"}' };
      return { status: 200, body: JSON.stringify(out) };
    } catch (e) {
      if (e.status === 400) return { status: 400, body: JSON.stringify({ message: e.message }) };
      throw e;
    }
  }

  bo.handle = handle;
  return bo;
}
