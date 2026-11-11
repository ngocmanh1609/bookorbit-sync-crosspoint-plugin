/*
 * cp-orbit: BookOrbit for CrossPoint. Web card for the reader's Plugins page.
 * MIT License. Written from the CrossPoint firmware and BookOrbit server sources.
 *
 * The on-device parts (catalog, downloads, reading sessions) live in device.json.
 * This card does what needs code: setup, the reader's KOReader-sync settings,
 * shelves, two-way highlights and book status/rating.
 */
(function () {
  'use strict';

  const VERSION = '0.1.0';
  const PLUGIN_VERSION = 'cp-orbit/' + VERSION;
  const DEVICE_MODEL = 'CrossPoint';
  // User data lives outside the plugin folder so replacing the folder on update keeps it.
  const DATA_DIR = '/.cp-orbit';
  const CONFIG_PATH = DATA_DIR + '/config.json';
  const SHELVES_PATH = DATA_DIR + '/shelves.json';
  const TMP_PATH = DATA_DIR + '/tmp/response.json';
  const RECENT_PATH = '/.crosspoint/recent.json';
  const CLIP_DIR = '/.crosspoint/clippings';
  const KO = '/api/v1/koreader';
  const CATALOG = KO + '/plugin/catalog';
  const DEFAULT_DEST = '/Books/BookOrbit';
  const MANIFEST_MAX = 8000; // firmware reads at most 8KB of device.json
  const FETCH_BODY_MAX = 4000; // /api/fetch request bodies are capped at 4KB
  const NO_OFFSET = 0xffffffff;
  const TEXT_MAX = 4096; // CLIPPING_TEXT_MAX
  const CHANGES_PER_REQUEST = 50; // BookOrbit MAX_CHANGES_PER_REQUEST
  const KEYS_MAX = 5000;
  const PULL_ROUNDS_MAX = 20;

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const utf8 = (s) => enc.encode(s);

  // ---------------------------------------------------------------- hashing

  const MD5_K = new Int32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
  const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

  /** RFC 1321 MD5 of a string (as UTF-8) or bytes, as lowercase hex. */
  function md5(input) {
    const bytes = typeof input === 'string' ? utf8(input) : input;
    const len = bytes.length;
    const total = Math.ceil((len + 9) / 64) * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, (len * 8) >>> 0, true);
    dv.setUint32(total - 4, Math.floor((len * 8) / 4294967296), true);
    let a0 = 0x67452301;
    let b0 = 0xefcdab89 | 0;
    let c0 = 0x98badcfe | 0;
    let d0 = 0x10325476;
    const M = new Int32Array(16);
    for (let off = 0; off < total; off += 64) {
      for (let j = 0; j < 16; j++) M[j] = dv.getInt32(off + j * 4, true);
      let A = a0;
      let B = b0;
      let C = c0;
      let D = d0;
      for (let i = 0; i < 64; i++) {
        let F;
        let g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) & 15;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) & 15;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) & 15;
        }
        F = (F + A + MD5_K[i] + M[g]) | 0;
        A = D;
        D = C;
        C = B;
        const s = MD5_S[(i >> 4) * 4 + (i & 3)];
        B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }
    let hex = '';
    for (const w of [a0, b0, c0, d0]) {
      for (let k = 0; k < 4; k++) hex += ((w >>> (8 * k)) & 255).toString(16).padStart(2, '0');
    }
    return hex;
  }

  /** KOReader's partial MD5 (the book id BookOrbit and KOSync use): 1 KiB at 0 and at 1024*4^i. */
  function partialMd5(bytes) {
    const parts = [];
    for (let i = -1; i <= 10; i++) {
      const off = i < 0 ? 0 : 1024 * Math.pow(4, i);
      if (off >= bytes.length) break;
      parts.push(bytes.subarray(off, off + 1024));
    }
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
    return md5(joined);
  }

  /** std::hash<std::string> on the reader's 32-bit libstdc++ (MurmurHash2, seed 0xc70f6907). */
  function hashPath(path) {
    const b = utf8(path);
    const m = 0x5bd1e995;
    let len = b.length;
    let h = (0xc70f6907 ^ len) | 0;
    let i = 0;
    while (len >= 4) {
      let k = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
      k = Math.imul(k, m);
      k ^= k >>> 24;
      k = Math.imul(k, m);
      h = Math.imul(h, m) ^ k;
      i += 4;
      len -= 4;
    }
    if (len === 3) h ^= b[i + 2] << 16;
    if (len >= 2) h ^= b[i + 1] << 8;
    if (len >= 1) h = Math.imul(h ^ b[i], m);
    h ^= h >>> 13;
    h = Math.imul(h, m);
    h ^= h >>> 15;
    return h >>> 0;
  }

  const clippingStorePath = (bookPath) => CLIP_DIR + '/epub_' + hashPath(bookPath) + '.bin';

  // ------------------------------------------------------ clipping store file

  /** Truncate UTF-8 bytes to at most `max`, never inside a character. */
  function cutUtf8(bytes, max) {
    if (bytes.length <= max) return bytes;
    let end = max;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end);
  }

  /** Reads /.crosspoint/clippings/epub_<hash>.bin (firmware src/ClippingStore.cpp, versions 1-4). */
  function parseStore(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 0;
    const need = (n) => {
      if (p + n > bytes.length) throw new Error('The reader\'s highlight file is truncated.');
    };
    const u8 = () => {
      need(1);
      return dv.getUint8(p++);
    };
    const u16 = () => {
      need(2);
      const v = dv.getUint16(p, true);
      p += 2;
      return v;
    };
    const u32 = () => {
      need(4);
      const v = dv.getUint32(p, true);
      p += 4;
      return v;
    };
    const raw = (n) => {
      need(n);
      const v = bytes.slice(p, p + n);
      p += n;
      return v;
    };
    const cstr = (n) => {
      const b = raw(n);
      const z = b.indexOf(0);
      return dec.decode(z < 0 ? b : b.subarray(0, z));
    };
    const str = () => dec.decode(raw(u32()));
    const version = u8();
    if (version < 1 || version > 4) throw new Error('Unknown highlight file version ' + version + '; leaving it untouched.');
    const count = u16();
    const store = { version, title: str(), author: str(), path: str(), records: [] };
    for (let i = 0; i < count; i++) {
      const r = {
        spine: u16(),
        startPage: u16(),
        endPage: u16(),
        pageCount: u16(),
        startWord: u16(),
        endWord: u16(),
        wordCount: u16(),
        paragraph: u16(),
        timestamp: u32(),
        layoutSig: 0,
        startOffset: NO_OFFSET,
        endOffset: NO_OFFSET,
        revLo: 0,
        revHi: 0,
        pending: 1,
        id: '',
      };
      if (version >= 3) r.layoutSig = u32();
      if (version >= 4) {
        r.startOffset = u32();
        r.endOffset = u32();
        r.revLo = u32();
        r.revHi = u32();
        r.pending = u8();
        r.id = cstr(65);
      }
      r.chapter = cstr(48);
      if (version === 1) {
        const full = raw(u32());
        r.textBytes = full.slice(0, TEXT_MAX);
      } else {
        const textLen = u16();
        if (textLen > TEXT_MAX) throw new Error('The reader\'s highlight file looks damaged; leaving it untouched.');
        r.textBytes = raw(textLen);
      }
      r.text = dec.decode(r.textBytes);
      store.records.push(r);
    }
    return store;
  }

  /** Writes the store in the firmware's current format (version 4). */
  function buildStore(store) {
    const t = utf8(store.title || '');
    const a = utf8(store.author || '');
    const pth = utf8(store.path || '');
    const recs = store.records.map((r) => ({
      r,
      text: cutUtf8(r.textBytes || utf8(r.text || ''), TEXT_MAX),
      id: cutUtf8(utf8(r.id || ''), 64),
      ch: cutUtf8(utf8(r.chapter || ''), 47),
    }));
    let size = 3 + 12 + t.length + a.length + pth.length;
    for (const x of recs) size += 156 + x.text.length;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let p = 0;
    const u8 = (v) => {
      dv.setUint8(p, v);
      p += 1;
    };
    const u16 = (v) => {
      dv.setUint16(p, v, true);
      p += 2;
    };
    const u32 = (v) => {
      dv.setUint32(p, v >>> 0, true);
      p += 4;
    };
    const put = (b, width) => {
      out.set(b, p);
      p += width === undefined ? b.length : width; // fixed-width fields stay zero-padded
    };
    u8(4);
    u16(recs.length);
    u32(t.length);
    put(t);
    u32(a.length);
    put(a);
    u32(pth.length);
    put(pth);
    for (const { r, text, id, ch } of recs) {
      for (const v of [r.spine, r.startPage, r.endPage, r.pageCount, r.startWord, r.endWord, r.wordCount, r.paragraph]) u16(v);
      for (const v of [r.timestamp, r.layoutSig, r.startOffset, r.endOffset, r.revLo, r.revHi]) u32(v);
      u8(r.pending ? 1 : 0);
      put(id, 65);
      put(ch, 48);
      u16(text.length);
      put(text);
    }
    return out;
  }

  const localKey = (r) => [r.spine, r.startOffset, r.endOffset, r.timestamp, r.startPage, r.startWord].join(':');

  // ------------------------------------------------------------- EPUB chapters

  // Firmware VisibleTextUtils: text in these elements is not counted in highlight offsets.
  const NON_VISIBLE = new Set(['head', 'style', 'script', 'title', 'rp']);
  const ASCII_SPACE = /^[ \t\r\n]$/;
  const lname = (el) => (el.localName || el.nodeName || '').toLowerCase();

  function cpCount(s) {
    let n = 0;
    for (const _ of s) n++; // eslint-disable-line no-unused-vars
    return n;
  }

  /** UTF-16 index just after `cps` code points of `s`. */
  function utf16At(s, cps) {
    let i = 0;
    for (let n = 0; n < cps && i < s.length; n++) {
      const c = s.charCodeAt(i);
      const d = s.charCodeAt(i + 1);
      i += c >= 0xd800 && c < 0xdc00 && d >= 0xdc00 && d < 0xe000 ? 2 : 1;
    }
    return i;
  }

  const entityCache = new Map();
  /** Resolve named HTML entities before XML parsing, as BookOrbit and crengine do. */
  function decodeNamedEntities(markup) {
    return markup.replace(/<!\[CDATA\[[\s\S]*?\]\]>|&[a-zA-Z][a-zA-Z0-9]*;/g, (ref) => {
      if (ref.startsWith('<') || ref.length > 34) return ref;
      if (!entityCache.has(ref)) {
        let text = ref;
        try {
          const doc = new DOMParser().parseFromString('<!DOCTYPE html><html><body>' + ref + '</body></html>', 'text/html');
          text = doc.body.textContent;
        } catch (e) {
          text = ref;
        }
        entityCache.set(ref, text === ref || !text || /[<>&"']/.test(text) ? null : text);
      }
      return entityCache.get(ref) || ref;
    });
  }

  function parseChapter(xhtml) {
    let doc = null;
    let isXml = true;
    try {
      doc = new DOMParser().parseFromString(decodeNamedEntities(xhtml), 'application/xhtml+xml');
    } catch (e) {
      doc = null;
    }
    if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) {
      doc = new DOMParser().parseFromString(xhtml, 'text/html');
      isXml = false;
    }
    return chapterModel(doc, isXml);
  }

  /**
   * One walk builds both position systems of a chapter:
   * - the reader's highlight offsets: code points of all text inside <body>, except
   *   non-visible elements (firmware ChapterHtmlSlimParser::characterData);
   * - crengine xpointer runs: text-node runs per parent whose offsets collapse ASCII
   *   whitespace (BookOrbit chapter-text-index.ts, which mirrors KOReader).
   */
  function chapterModel(doc, isXml) {
    const root = doc.documentElement;
    const body = (root && Array.from(root.childNodes).find((n) => n.nodeType === 1 && lname(n) === 'body')) || root;
    const model = { root, isXml, runsByParent: new Map(), info: new Map(), visible: [], text: '', cps: 0 };
    const textParts = [];
    let vis = 0;
    const addVisible = (node) => {
      const n = cpCount(node.data);
      model.visible.push({ node, start: vis, end: vis + n });
      textParts.push(node.data);
      vis += n;
    };
    const addRun = (parts, parent, hidden) => {
      const run = { parts: [], parent, engine: [], rawEnd: 0, index: 0, count: 0 };
      const whitespaceOnly = parts.every((n) => /^[ \t\r\n]*$/.test(n.data));
      let raw = 0;
      let lastSpace = false;
      for (const node of parts) {
        model.info.set(node, { run, rawStart: raw, visStart: hidden ? -1 : vis });
        for (const ch of node.data) {
          const space = ASCII_SPACE.test(ch);
          if (!whitespaceOnly && (!space || !lastSpace)) run.engine.push(raw);
          lastSpace = space;
          raw += ch.length;
        }
        run.parts.push({ node, len: node.data.length });
        if (!hidden) addVisible(node);
      }
      run.rawEnd = raw;
      if (run.engine.length) {
        const list = model.runsByParent.get(parent) || [];
        list.push(run);
        model.runsByParent.set(parent, list);
      }
    };
    const walk = (el, hidden) => {
      const kids = el.childNodes;
      let i = 0;
      while (i < kids.length) {
        const node = kids[i];
        if (node.nodeType === 3) {
          const parts = [];
          while (i < kids.length && kids[i].nodeType === 3) parts.push(kids[i++]);
          addRun(parts, el, hidden);
          continue;
        }
        if (node.nodeType === 4 && !hidden) addVisible(node); // CDATA: the reader counts it, xpointers skip it
        if (node.nodeType === 1) walk(node, hidden || NON_VISIBLE.has(lname(node)));
        i++;
      }
    };
    if (body) walk(body, false);
    for (const list of model.runsByParent.values()) {
      list.forEach((run, i) => {
        run.index = i + 1;
        run.count = list.length;
      });
    }
    model.text = textParts.join('');
    model.cps = vis;
    model.utf16 = new Int32Array(vis + 1);
    let u = 0;
    let c = 0;
    for (const ch of model.text) {
      model.utf16[c++] = u;
      u += ch.length;
    }
    model.utf16[c] = u;
    return model;
  }

  const visibleSlice = (model, start, end) => model.text.slice(model.utf16[start], model.utf16[end]);

  /** The visible text node holding offset `off` (for an exclusive end, the node it closes). */
  function pointAt(model, off, isEnd) {
    const v = model.visible;
    let lo = 0;
    let hi = v.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (isEnd ? v[mid].end < off : v[mid].end <= off) lo = mid + 1;
      else hi = mid;
    }
    while (lo < v.length && v[lo].start === v[lo].end) lo++;
    const hit = v[lo];
    if (!hit || (isEnd ? hit.start >= off : hit.start > off)) return null;
    return hit;
  }

  function elementPath(model, el) {
    const segs = [];
    let cur = el;
    while (cur && cur !== model.root) {
      const parent = cur.parentNode;
      if (cur.nodeType !== 1 || !parent) return null;
      const name = lname(cur);
      const same = Array.from(parent.childNodes).filter((n) => n.nodeType === 1 && lname(n) === name);
      const written = model.isXml ? cur.nodeName : cur.localName;
      segs.unshift(same.length > 1 ? written + '[' + (same.indexOf(cur) + 1) + ']' : written);
      cur = parent;
    }
    return cur === model.root ? segs.join('/') : null;
  }

  /** KOReader xpointer for a reader offset in spine item `spine` (0-based). */
  function xpointerFor(model, spine, off, isEnd) {
    const hit = pointAt(model, off, isEnd);
    const info = hit && model.info.get(hit.node);
    if (!info || !info.run.engine.length) return null;
    const target = info.rawStart + utf16At(hit.node.data, off - hit.start);
    const eng = info.run.engine;
    let lo = 0;
    let hi = eng.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (eng[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const path = elementPath(model, info.run.parent);
    if (path === null) return null;
    const step = info.run.count > 1 ? 'text()[' + info.run.index + ']' : 'text()';
    return '/body/DocFragment[' + (spine + 1) + ']/' + path + '/' + step + '.' + lo;
  }

  function parseXPointer(raw) {
    const m = /^\/body(?:\[1\])?\/DocFragment(?:\[(\d+)\])?(.*)$/.exec(String(raw || '').trim());
    if (!m) return null;
    let rest = m[2] || '';
    let offset = null;
    const om = /\.(\d+)$/.exec(rest);
    if (om) {
      offset = Number(om[1]);
      rest = rest.slice(0, -om[0].length);
    }
    const steps = [];
    let textIndex = null;
    for (const seg of rest.split('/')) {
      if (!seg) continue;
      const tm = /^text\(\)(?:\[(\d+)\])?$/.exec(seg);
      if (tm) {
        textIndex = tm[1] ? Number(tm[1]) : 1;
        continue;
      }
      if (textIndex !== null) return null;
      const sm = /^([A-Za-z][\w:-]*)(?:\[(\d+)\])?$/.exec(seg);
      if (!sm) return null;
      steps.push({ name: sm[1].toLowerCase(), index: sm[2] ? Number(sm[2]) : 1 });
    }
    if (offset !== null && textIndex === null) textIndex = 1;
    return { spine: (m[1] ? Number(m[1]) : 1) - 1, steps, textIndex, offset };
  }

  function firstRunWithin(model, el) {
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const info = model.info.get(node);
        if (info && info.run.engine.length) return info.run;
      } else if (node.nodeType === 1) {
        const run = firstRunWithin(model, node);
        if (run) return run;
      }
    }
    return null;
  }

  /** Reader offset for a parsed xpointer, or null when it does not resolve. */
  function visibleAt(model, xp, isEnd) {
    let el = model.root;
    for (const s of xp.steps) {
      el = Array.from(el.childNodes).filter((n) => n.nodeType === 1 && lname(n) === s.name)[s.index - 1];
      if (!el) return null;
    }
    const runs = model.runsByParent.get(el) || [];
    const run = (xp.textIndex !== null && runs[xp.textIndex - 1]) || firstRunWithin(model, el);
    if (!run) return null;
    const engOff = xp.offset === null ? (isEnd ? run.engine.length : 0) : xp.offset;
    if (engOff > run.engine.length) return null;
    let raw = engOff < run.engine.length ? run.engine[engOff] : run.rawEnd;
    for (let i = 0; i < run.parts.length; i++) {
      const part = run.parts[i];
      if (raw < part.len || i === run.parts.length - 1) {
        const info = model.info.get(part.node);
        return info.visStart < 0 ? null : info.visStart + cpCount(part.node.data.slice(0, raw));
      }
      raw -= part.len;
    }
    return null;
  }

  const FOLD = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"', '–': '-', '—': '-', '­': '' };
  const foldChar = (c) => (FOLD[c] !== undefined ? FOLD[c] : c).toLowerCase();

  function normText(s, fold) {
    let out = '';
    let space = true;
    for (const ch of String(s || '').normalize('NFD')) {
      if (/\s/.test(ch)) {
        if (!space) out += ' ';
        space = true;
      } else {
        out += fold ? foldChar(ch) : ch;
        space = false;
      }
    }
    return out.trim();
  }

  const sameText = (a, b) => normText(a, false) === normText(b, false) || normText(a, true) === normText(b, true);

  function searchIndex(model, fold) {
    const key = fold ? 'searchFolded' : 'search';
    if (model[key]) return model[key];
    let text = '';
    const map = [];
    let cp = 0;
    let space = true;
    for (const ch of model.text) {
      if (/\s/.test(ch)) {
        if (!space) {
          text += ' ';
          map.push(cp);
        }
        space = true;
      } else {
        for (const d of ch.normalize('NFD')) {
          const c = fold ? foldChar(d) : d;
          for (let k = 0; k < c.length; k++) {
            text += c[k];
            map.push(cp);
          }
        }
        space = false;
      }
      cp++;
    }
    return (model[key] = { text, map });
  }

  /** Finds `text` in the chapter; with several matches, the one nearest `hint` (or ambiguous). */
  function findText(model, text, hint) {
    for (const fold of [false, true]) {
      const needle = normText(text, fold);
      if (!needle) return null;
      const idx = searchIndex(model, fold);
      const hits = [];
      for (let at = idx.text.indexOf(needle); at >= 0 && hits.length < 64; at = idx.text.indexOf(needle, at + 1)) hits.push(at);
      if (!hits.length) continue;
      if (hits.length > 1 && (hint === null || hint === undefined)) return { ambiguous: true };
      let best = hits[0];
      for (const h of hits) if (Math.abs(idx.map[h] - hint) < Math.abs(idx.map[best] - hint)) best = h;
      return { start: idx.map[best], end: idx.map[best + needle.length - 1] + 1 };
    }
    return null;
  }

  function resolveHref(dir, href) {
    let path = String(href).split('#')[0];
    try {
      path = decodeURIComponent(path);
    } catch (e) {
      /* keep as written */
    }
    const out = [];
    for (const seg of (dir + path).split('/')) {
      if (seg === '..') out.pop();
      else if (seg && seg !== '.') out.push(seg);
    }
    return out.join('/');
  }

  function elementsByName(node, name, out) {
    out = out || [];
    for (const child of node.childNodes || []) {
      if (child.nodeType !== 1) continue;
      if (lname(child).split(':').pop() === name) out.push(child);
      elementsByName(child, name, out);
    }
    return out;
  }

  let jszipLoading = null;
  function loadJSZip() {
    if (typeof JSZip !== 'undefined') return Promise.resolve(JSZip); // eslint-disable-line no-undef
    if (!jszipLoading) {
      jszipLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/js/jszip.min.js';
        s.onload = () => (typeof JSZip !== 'undefined' ? resolve(JSZip) : reject(new Error('JSZip did not load.'))); // eslint-disable-line no-undef
        s.onerror = () => {
          jszipLoading = null;
          reject(new Error('Could not load /js/jszip.min.js from the reader.'));
        };
        document.head.appendChild(s);
      });
    }
    return jszipLoading;
  }

  async function openEpub(bytes) {
    const Zip = await loadJSZip();
    const zip = await Zip.loadAsync(bytes);
    const file = (path) => zip.file(path) || Object.values(zip.files).find((f) => f.name.toLowerCase() === path.toLowerCase()) || null;
    const readText = async (path) => {
      const f = file(path);
      if (!f) throw new Error('The EPUB is missing ' + path + '.');
      return f.async('string');
    };
    const xml = (text) => new DOMParser().parseFromString(text, 'application/xml');
    const rootfile = elementsByName(xml(await readText('META-INF/container.xml')), 'rootfile')[0];
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath) throw new Error('The EPUB has no package file.');
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const opf = xml(await readText(opfPath));
    const hrefs = new Map(elementsByName(opf, 'item').map((it) => [it.getAttribute('id'), it.getAttribute('href')]));
    // Every itemref counts, linear or not: the reader and KOReader number the spine the same way.
    const spine = elementsByName(opf, 'itemref')
      .map((ref) => hrefs.get(ref.getAttribute('idref')))
      .filter((href) => href !== null && href !== undefined)
      .map((href) => resolveHref(opfDir, href));
    const textOf = (el) => (el ? el.textContent.trim() : '');
    const meta = { title: textOf(elementsByName(opf, 'title')[0]), author: textOf(elementsByName(opf, 'creator')[0]) };
    const cache = new Map();
    const chapter = (i) => {
      if (!cache.has(i)) cache.set(i, readText(spine[i]).then(parseChapter));
      return cache.get(i);
    };
    return { spine, meta, chapter };
  }

  // ------------------------------------------------------------- device files

  async function readBytes(path) {
    const r = await fetch('/download?path=' + encodeURIComponent(path));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('Could not read ' + path + ' from the reader (HTTP ' + r.status + ').');
    return new Uint8Array(await r.arrayBuffer());
  }

  async function readJson(path) {
    const bytes = await readBytes(path);
    if (!bytes) return null;
    try {
      return JSON.parse(dec.decode(bytes));
    } catch (e) {
      return null;
    }
  }

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  const writeBytes = (api, path, bytes) => api.writeFile(path, toBase64(bytes));
  const writeJson = (api, path, obj) => writeBytes(api, path, utf8(JSON.stringify(obj)));

  const pad = (n) => String(n).padStart(2, '0');
  /** KOReader-style device-local datetime. */
  function deviceDatetime(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function parseDatetime(dt) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(dt || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  }

  function normalizeServer(input) {
    let s = String(input || '').trim().replace(/\/+$/, '');
    if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
    s = s.replace(/\/api\/v1\/koreader$/i, '').replace(/\/api\/v1$/i, '');
    try {
      const url = new URL(s);
      return url.protocol === 'http:' || url.protocol === 'https:' ? s : '';
    } catch (e) {
      return '';
    }
  }

  // ---------------------------------------------------------------- BookOrbit

  function boError(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
  }

  /** BookOrbit's KOReader plugin API through the reader's relay (header auth, no tokens). */
  function boClient(api, cfg) {
    const headers = (json) =>
      Object.assign({ 'x-auth-user': cfg.user, 'x-auth-key': cfg.key, accept: 'application/json' }, json ? { 'Content-Type': 'application/json' } : {});

    // The relay caps answers at 64KB; /api/fetch streams any size to the SD card instead.
    async function viaSd(method, url, hdrs, payload) {
      let result;
      try {
        result = await api.fetchToSd(url, TMP_PATH, hdrs, method === 'GET' ? undefined : { method, body: payload });
      } catch (e) {
        if (e.result && typeof e.result.status === 'number') return { status: e.result.status, body: e.result.body || '' };
        throw e;
      }
      const bytes = await readBytes(TMP_PATH);
      return { status: result.status || 200, headers: [], body: bytes ? dec.decode(bytes) : '' };
    }

    async function call(method, path, data) {
      const url = cfg.server + path;
      const payload = data === undefined ? '' : JSON.stringify(data);
      const hdrs = headers(data !== undefined);
      let res;
      try {
        res = await api.relay(method, url, hdrs, payload);
      } catch (e) {
        if (e.status !== 502) throw boError('The reader could not contact BookOrbit: ' + e.message, 0);
        if (method !== 'GET' && utf8(payload).length > FETCH_BODY_MAX) {
          const err = boError('BookOrbit\'s answer was too large for the reader to relay.', 502);
          err.tooLarge = true;
          throw err;
        }
        res = await viaSd(method, url, hdrs, payload);
      }
      let json = null;
      try {
        json = res.body ? JSON.parse(res.body) : null;
      } catch (e) {
        json = null;
      }
      const status = res.status;
      if (status <= 0) throw boError('The reader could not reach BookOrbit at ' + cfg.server + '.', status);
      if (status >= 300 && status < 400) {
        const loc = (res.headers || []).find(([k]) => String(k).toLowerCase() === 'location');
        throw boError('BookOrbit redirected the request' + (loc ? ' to ' + loc[1] : '') + '. Use that address as the server URL.', status);
      }
      if (status === 401 || status === 403) throw boError('BookOrbit refused the login (HTTP ' + status + '). Check the KOReader sync username and password, and that sync is enabled for it.', status);
      if (status === 404 && path.startsWith(KO + '/users')) throw boError('No BookOrbit KOReader API at ' + cfg.server + '. Check the server URL.', status);
      if (status < 200 || status >= 300) throw boError('BookOrbit returned HTTP ' + status + (json && json.message ? ': ' + json.message : '') + '.', status);
      return json;
    }

    return {
      get: (path) => call('GET', path),
      post: (path, data) => call('POST', path, data),
      put: (path, data) => call('PUT', path, data),
    };
  }

  const deviceFields = (cfg, now) => ({ deviceId: cfg.device_id, deviceModel: DEVICE_MODEL, pluginVersion: PLUGIN_VERSION, deviceTime: deviceDatetime(now) });

  async function testConnection(bo) {
    const auth = await bo.get(KO + '/users/auth');
    let version = null;
    try {
      version = await bo.get(KO + '/plugin/version');
    } catch (e) {
      version = null;
    }
    return { username: (auth && auth.username) || '', serverVersion: (version && version.serverVersion) || '' };
  }

  // ------------------------------------------------------------ reader settings

  async function getSettings(keys) {
    const r = await fetch('/api/settings?keys=' + keys.join(','));
    if (!r.ok) return null;
    const list = await r.json();
    const map = {};
    for (const item of Array.isArray(list) ? list : []) map[item.key] = item;
    return map;
  }

  /**
   * Points the reader's own KOReader sync (progress) at BookOrbit through POST /api/settings.
   * Enum values are firmware indices, which are persisted append-only (src/SettingsList.cpp):
   * koServerType KOSync=1, koMatchMethod Binary=1, koSyncBehavior Ask=0/Smart=1, koSyncClippings Off=0.
   */
  async function applyKosync(cfg, password, ask, confirmFn) {
    const target = cfg.server + KO;
    const current = await getSettings(['koServerUrl', 'koUsername', 'koServerType', 'koMatchMethod', 'koSyncBehavior', 'koSyncClippings']);
    if (!current || !current.koServerUrl) throw new Error('This firmware does not offer KOReader sync settings to plugins.');
    const existing = String(current.koServerUrl.value || '').replace(/\/+$/, '');
    if (existing && existing !== target && !confirmFn('The reader\'s progress sync points at ' + existing + '. Replace it with BookOrbit?')) {
      return { declined: true };
    }
    const update = { koServerUrl: target, koUsername: cfg.user };
    if (password) update.koPassword = password; // the firmware keeps it in its own protected store
    const enums = { koServerType: [1, 3], koMatchMethod: [1, 2], koSyncBehavior: [ask ? 0 : 1, 2], koSyncClippings: [0, 2] };
    const skipped = [];
    // The firmware reports Off/On enums as type "toggle" with no options list (handleGetSettings).
    const choices = (item) => (!item ? 0 : item.type === 'toggle' ? 2 : Array.isArray(item.options) ? item.options.length : 0);
    for (const [key, [value, optionCount]] of Object.entries(enums)) {
      if (choices(current[key]) === optionCount) update[key] = value;
      else skipped.push(key);
    }
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) });
    if (!r.ok) throw new Error('The reader refused the sync settings (HTTP ' + r.status + ').');
    return { update, skipped, passwordKept: !password };
  }

  // ---------------------------------------------------------------- shelves

  function shelfLists(collections, scopes) {
    const url = (param, id) => '{cfg.server}' + CATALOG + '/books?' + param + '=' + encodeURIComponent(id) + '&sort=title&format=epub&page={page}&size={limit}';
    return [
      ...collections.map((c) => ({ title: 'Collection: ' + c.title, url: url('collectionId', c.id), shelf: true })),
      ...scopes.map((s) => ({ title: 'SmartScope: ' + s.title, url: url('smartScopeId', s.id), shelf: true })),
    ];
  }

  /** Replaces the shelf lists in device.json, keeping the built-in lists and the 8KB cap. */
  function mergeShelves(device, shelves) {
    const base = ((device.browse && device.browse.lists) || []).filter((l) => !l.shelf);
    const build = (lists) => Object.assign({}, device, { browse: Object.assign({}, device.browse, { lists }) });
    const kept = [];
    for (const s of shelves) {
      if (utf8(JSON.stringify(build(base.concat(kept, [s])))).length > MANIFEST_MAX) break;
      kept.push(s);
    }
    return { device: build(base.concat(kept)), kept: kept.length, dropped: shelves.length - kept.length };
  }

  async function updateShelves(api, bo) {
    const [collections, scopes] = await Promise.all([bo.get(CATALOG + '/sections/collections'), bo.get(CATALOG + '/sections/smart-scopes')]);
    const lists = shelfLists((collections && collections.items) || [], (scopes && scopes.items) || []);
    const device = await readJson(api.dir + '/device.json');
    if (!device || !device.browse) throw new Error('Could not read the plugin\'s device.json.');
    const merged = mergeShelves(device, lists);
    await writeJson(api, api.dir + '/device.json', merged.device);
    await writeJson(api, SHELVES_PATH, { lists: lists.slice(0, merged.kept) });
    return merged;
  }

  /** After an update replaced device.json, puts the saved shelves back. */
  async function restoreShelves(api) {
    const saved = await readJson(SHELVES_PATH);
    if (!saved || !Array.isArray(saved.lists) || !saved.lists.length) return 0;
    const device = await readJson(api.dir + '/device.json');
    if (!device || !device.browse || (device.browse.lists || []).some((l) => l.shelf)) return 0;
    const merged = mergeShelves(device, saved.lists);
    await writeJson(api, api.dir + '/device.json', merged.device);
    return merged.kept;
  }

  // -------------------------------------------------------------- highlights

  async function recordPositions(epub, r) {
    if (r.spine >= epub.spine.length) return null;
    const model = await epub.chapter(r.spine);
    let start = r.startOffset;
    let end = r.endOffset;
    if (start === NO_OFFSET || end === NO_OFFSET || end <= start || end > model.cps) {
      const hit = findText(model, r.text, null);
      if (!hit || hit.ambiguous) return null;
      start = hit.start;
      end = hit.end;
    }
    const pos0 = xpointerFor(model, r.spine, start, false);
    const pos1 = xpointerFor(model, r.spine, end, true);
    return pos0 && pos1 ? { pos0, pos1 } : null;
  }

  /** Places a BookOrbit highlight in the book, verified against its text; null when it cannot be. */
  async function placeRemote(epub, entry) {
    const p0 = parseXPointer(entry.pos0);
    if (!p0 || p0.spine < 0 || p0.spine >= epub.spine.length) return null;
    const p1 = entry.pos1 ? parseXPointer(entry.pos1) : null;
    const model = await epub.chapter(p0.spine);
    const start = visibleAt(model, p0, false);
    const end = p1 && p1.spine === p0.spine ? visibleAt(model, p1, true) : null;
    const text = entry.text || '';
    if (start !== null && end !== null && end > start && sameText(visibleSlice(model, start, end), text)) return { spine: p0.spine, start, end };
    if (!text.trim()) return null;
    const hit = findText(model, text, start);
    return hit && !hit.ambiguous ? { spine: p0.spine, start: hit.start, end: hit.end } : null;
  }

  function newRecord(placed, entry) {
    const date = parseDatetime(entry.datetime);
    const textBytes = cutUtf8(utf8(entry.text || ''), TEXT_MAX);
    return {
      spine: placed.spine,
      startPage: 0,
      endPage: 0,
      pageCount: 1,
      startWord: 0,
      endWord: 0,
      wordCount: Math.min(0xffff, String(entry.text || '').split(/\s+/).filter(Boolean).length),
      paragraph: 0xffff,
      timestamp: date ? Math.floor(date.getTime() / 1000) : 0,
      layoutSig: 0,
      startOffset: placed.start,
      endOffset: placed.end,
      revLo: 0,
      revHi: 0,
      pending: 0,
      id: '',
      chapter: entry.chapter || '',
      textBytes,
      text: dec.decode(textBytes),
    };
  }

  /** Local highlights BookOrbit has not seen yet, plus the full key list for the exchange. */
  async function planUpload(store, state, epub, now) {
    const used = new Set(Object.values(state.items).map((it) => it.dt));
    const keys = [];
    const changes = [];
    const fresh = {};
    const unresolved = [];
    for (const r of store.records) {
      const lk = localKey(r);
      const known = state.items[lk];
      if (known) {
        keys.push({ k: known.k, dt: known.dt });
        continue;
      }
      const pos = await recordPositions(epub, r);
      if (!pos) {
        unresolved.push(r);
        continue;
      }
      let date = r.timestamp > 0 ? new Date(r.timestamp * 1000) : now;
      let dt = deviceDatetime(date);
      while (used.has(dt)) {
        date = new Date(date.getTime() + 1000); // identity is datetime + position: keep datetimes unique
        dt = deviceDatetime(date);
      }
      used.add(dt);
      const k = md5(dt + '|' + pos.pos0);
      fresh[lk] = { dt, k, pos0: pos.pos0, pos1: pos.pos1 };
      keys.push({ k, dt });
      const change = { datetime: dt, drawer: 'lighten', text: r.text.slice(0, 10000), posFormat: 'xpointer', pos0: pos.pos0, pos1: pos.pos1 };
      if (r.chapter) change.chapter = r.chapter.slice(0, 500);
      changes.push(change);
    }
    return { keys, changes, fresh, unresolved };
  }

  const overlaps = (r, p) => r.spine === p.spine && r.startOffset !== NO_OFFSET && r.startOffset < p.end && p.start < r.endOffset;

  /** Applies BookOrbit's add/edit/delete list to the store; returns what to acknowledge. */
  async function applyRemote(store, state, epub, toApply, cap) {
    const applied = [];
    const deleted = [];
    const counts = { added: 0, updated: 0, deleted: 0, failed: 0, full: 0 };
    let changed = false;
    const byKey = new Map(Object.entries(state.items).map(([lk, it]) => [it.k, lk]));
    const indexOf = (lk) => store.records.findIndex((r) => localKey(r) === lk);

    for (const d of toApply.delete || []) {
      const lk = byKey.get(d.key) || Object.keys(state.items).find((x) => d.datetime && state.items[x].dt === d.datetime);
      if (lk) {
        const i = indexOf(lk);
        if (i >= 0) {
          store.records.splice(i, 1);
          changed = true;
          counts.deleted++;
        }
        delete state.items[lk];
      }
      deleted.push({ serverId: d.serverId, status: 'applied' }); // gone either way
    }

    for (const e of toApply.edit || []) {
      const lk = byKey.get(e.key);
      const i = lk ? indexOf(lk) : -1;
      if (i < 0) {
        applied.push({ serverId: e.serverId, version: e.version, status: 'failed' });
        counts.failed++;
        continue;
      }
      const rec = store.records[i];
      const item = state.items[lk];
      if (e.pos0) {
        const placed = await placeRemote(epub, e);
        if (!placed) {
          applied.push({ serverId: e.serverId, version: e.version, status: 'failed' });
          counts.failed++;
          continue;
        }
        rec.spine = placed.spine;
        rec.startOffset = placed.start;
        rec.endOffset = placed.end;
      }
      if (typeof e.text === 'string' && e.text !== rec.text) {
        rec.textBytes = cutUtf8(utf8(e.text), TEXT_MAX);
        rec.text = dec.decode(rec.textBytes);
      }
      if (typeof e.chapter === 'string') rec.chapter = e.chapter;
      const dt = e.datetime || item.dt;
      const pos0 = e.pos0 || item.pos0;
      delete state.items[lk];
      state.items[localKey(rec)] = { dt, k: md5(dt + '|' + pos0), pos0, pos1: e.pos0 ? e.pos1 || null : item.pos1, sid: e.serverId };
      applied.push({ serverId: e.serverId, version: e.version, status: 'applied', verified: true });
      changed = true;
      counts.updated++;
    }

    for (const a of toApply.add || []) {
      const placed = a.posFormat === 'xpointer' ? await placeRemote(epub, a) : null;
      if (!placed) {
        applied.push({ serverId: a.serverId, version: a.version, status: 'failed' });
        counts.failed++;
        continue;
      }
      // A re-offered highlight the reader already has (lost sync state) is adopted, not duplicated.
      let rec = store.records.find((r) => overlaps(r, placed) && sameText(r.text, a.text || ''));
      if (!rec) {
        if (store.records.length >= cap) {
          applied.push({ serverId: a.serverId, version: a.version, status: 'failed' });
          counts.full++;
          continue;
        }
        rec = newRecord(placed, a);
        store.records.push(rec);
        changed = true;
        counts.added++;
      }
      state.items[localKey(rec)] = { dt: a.datetime, k: md5(a.datetime + '|' + a.pos0), pos0: a.pos0, pos1: a.pos1 || null, sid: a.serverId };
      applied.push({ serverId: a.serverId, version: a.version, status: 'applied', verified: true });
    }
    return { applied, deleted, changed, counts };
  }

  const hasPending = (t) => !!t && ((t.add && t.add.length) || (t.edit && t.edit.length) || (t.delete && t.delete.length));

  /**
   * Two-way highlight sync for one book through BookOrbit's KOReader annotation exchange:
   * send every local key (so deletions are seen) plus new highlights, apply what comes back
   * to the reader's highlight file, then acknowledge only what was really written.
   */
  async function syncHighlights(ctx, book, log) {
    const { api, cfg, bo } = ctx;
    const now = () => (ctx.now ? ctx.now() : new Date());
    log('Reading the book…');
    const bytes = await readBytes(book.path);
    if (!bytes) throw new Error('Book not found on the SD card: ' + book.path);
    const hash = partialMd5(bytes);
    const epub = await openEpub(bytes);
    const storePath = clippingStorePath(book.path);
    const storeBytes = await readBytes(storePath);
    const store = storeBytes ? parseStore(storeBytes) : { version: 4, title: book.title || epub.meta.title, author: book.author || epub.meta.author, path: book.path, records: [] };
    const statePath = DATA_DIR + '/state/' + hash + '.json';
    const prior = await readJson(statePath);
    // A copied/moved book or a missing highlight file must not read as "everything was deleted":
    // such a copy is exchanged as new, so BookOrbit deletes nothing and offers everything again.
    const saved = prior && prior.items && prior.path === book.path && (storeBytes || !Object.keys(prior.items).length) ? prior : null;
    const state = saved || { v: 1, path: book.path, items: {} };
    const present = new Set(store.records.map(localKey));

    log('Comparing highlights…');
    const plan = await planUpload(store, state, epub, now());
    const keysComplete = plan.keys.length <= KEYS_MAX;
    const minimal = () => Object.assign(deviceFields(cfg, now()), { books: [{ hash, keys: [], keysComplete: false, changes: [] }] });
    const exchange = async (body) => {
      try {
        return await bo.post(KO + '/plugin/annotations/exchange', body);
      } catch (e) {
        if (!e.tooLarge) throw e;
        return bo.post(KO + '/plugin/annotations/exchange', minimal()); // the first call was applied; fetch its answer
      }
    };

    let response = null;
    let cursor = 0;
    let first = true;
    do {
      const chunk = plan.changes.slice(cursor, cursor + CHANGES_PER_REQUEST);
      cursor += chunk.length;
      const entry = { hash, keys: first && keysComplete ? plan.keys : [], keysComplete: first && keysComplete, changes: chunk };
      if (first) entry.sidecarState = saved ? 'known' : 'new';
      const body = await exchange(Object.assign(deviceFields(cfg, now()), { books: [entry] }));
      if (((body && body.unmatched) || []).includes(hash)) return { unmatched: true };
      if (((body && body.positionIncompatible) || []).includes(hash)) return { incompatible: true };
      response = body && body.results ? body.results[0] : null;
      first = false;
    } while (cursor < plan.changes.length);

    if (keysComplete) {
      for (const lk of Object.keys(state.items)) if (!present.has(lk)) delete state.items[lk]; // BookOrbit was told they are gone
    }
    Object.assign(state.items, plan.fresh);
    await writeJson(api, statePath, state);

    const summary = { sent: plan.changes.length, added: 0, updated: 0, deleted: 0, failed: 0, full: 0, unresolved: plan.unresolved.length, more: false };
    let backedUp = false;
    for (let round = 0; response && hasPending(response.toApply); round++) {
      if (round >= PULL_ROUNDS_MAX) {
        summary.more = true;
        break;
      }
      log('Applying changes from BookOrbit…');
      const result = await applyRemote(store, state, epub, response.toApply, ctx.cap || 256);
      if (result.changed) {
        if (storeBytes && !backedUp) {
          await writeBytes(api, DATA_DIR + '/backup/' + storePath.split('/').pop(), storeBytes);
          backedUp = true;
        }
        await writeBytes(api, storePath, buildStore(store)); // written before the ack, never after
      }
      await writeJson(api, statePath, state);
      await bo.post(KO + '/plugin/annotations/exchange-ack', Object.assign(deviceFields(cfg, now()), { books: [{ hash, applied: result.applied, deleted: result.deleted }] }));
      for (const k of ['added', 'updated', 'deleted', 'failed', 'full']) summary[k] += result.counts[k];
      if (!response.more) break;
      const body = await exchange(minimal());
      response = body && body.results ? body.results[0] : null;
    }
    return summary;
  }

  function describeSync(r) {
    if (r.unmatched) return 'BookOrbit does not have this exact file. Download the book from BookOrbit and try again.';
    if (r.incompatible) return 'This copy differs from BookOrbit\'s file, so positions cannot be matched. Download it from BookOrbit again.';
    const parts = [];
    if (r.sent) parts.push(r.sent + ' sent to BookOrbit');
    if (r.added) parts.push(r.added + ' added to the reader');
    if (r.updated) parts.push(r.updated + ' updated');
    if (r.deleted) parts.push(r.deleted + ' deleted on the reader');
    let text = parts.length ? parts.join(', ') + '.' : 'Already in sync.';
    if (r.failed) text += ' ' + r.failed + ' from BookOrbit could not be placed in this book.';
    if (r.full) text += ' ' + r.full + ' skipped: the reader\'s highlight limit for this book is reached.';
    if (r.unresolved) text += ' ' + r.unresolved + ' on the reader could not be located in the book and were not sent.';
    if (r.more) text += ' More changes are waiting; run it again.';
    return text;
  }

  // ------------------------------------------------------------ status/rating

  async function bookIdFor(ctx, path, getBytes) {
    const meta = await readJson(path + '.meta.json');
    if (meta && /^\d+$/.test(String(meta.bookorbit_book_id || ''))) return Number(meta.bookorbit_book_id);
    const hash = partialMd5(await getBytes());
    const r = await ctx.bo.post(KO + '/plugin/match-check', Object.assign(deviceFields(ctx.cfg, new Date()), { hashes: [hash] }));
    const match = ((r && r.matches) || []).find((x) => x.hash === hash);
    return match ? match.bookId : null;
  }

  const STATUSES = [
    ['unread', 'Unread'],
    ['want_to_read', 'Want to read'],
    ['reading', 'Reading'],
    ['on_hold', 'On hold'],
    ['read', 'Read'],
    ['abandoned', 'Abandoned'],
  ];

  // --------------------------------------------------------------------- UI

  function render(container, api) {
    const doc = container.ownerDocument || document;
    const el = (tag, attrs, ...kids) => {
      const node = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) {
        if (k === 'class') node.className = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, '');
        else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
      }
      for (const kid of kids.flat()) if (kid !== null && kid !== undefined) node.append(typeof kid === 'string' ? doc.createTextNode(kid) : kid);
      return node;
    };
    const row = (label, control) => el('div', { class: 'setting-row' }, el('span', { class: 'setting-name' }, label), el('span', { class: 'setting-control' }, control));
    const say = (node, text, kind) => {
      node.textContent = text;
      node.style.color = kind === 'error' ? '#c0392b' : kind === 'ok' ? '#1e8449' : '';
    };
    const confirmFn = (q) => (typeof window !== 'undefined' && window.confirm ? window.confirm(q) : true);

    const f = {
      // type=text so the reader's stylesheet sizes it like the other fields; inputmode keeps the URL keyboard.
      server: el('input', { type: 'text', inputmode: 'url', spellcheck: 'false', placeholder: 'http://192.168.1.50:3000', autocomplete: 'off' }),
      user: el('input', { type: 'text', autocomplete: 'username' }),
      password: el('input', { type: 'password', autocomplete: 'current-password' }),
      dest: el('input', { type: 'text', placeholder: DEFAULT_DEST }),
      progress: el('input', { type: 'checkbox', checked: true }),
      ask: el('select', {}, el('option', { value: 'ask' }, 'Ask me'), el('option', { value: 'smart' }, 'Use the furthest automatically')),
    };
    const setupMsg = el('p', { class: 'cp-orbit-msg' });
    const shelfMsg = el('p', { class: 'cp-orbit-msg' });
    const bookMsg = el('p', { class: 'cp-orbit-msg' });
    const bookSelect = el('select', {});
    const otherPath = el('input', { type: 'text', placeholder: '/Books/Author/Title.epub', style: 'display:none' });
    const statusSelect = el('select', {}, el('option', { value: '' }, '—'), STATUSES.map(([v, label]) => el('option', { value: v }, label)));
    const ratingSelect = el('select', {}, el('option', { value: '' }, 'No rating'), [1, 2, 3, 4, 5].map((n) => el('option', { value: String(n) }, '★'.repeat(n))));
    const statusBox = el('div', { style: 'display:none' }, row('Status', statusSelect), row('Rating', ratingSelect));
    const buttons = [];
    const button = (label, fn) => {
      const b = el('button', { class: 'btn-small', type: 'button' }, label);
      b.addEventListener('click', async () => {
        buttons.forEach((x) => (x.disabled = true));
        try {
          await fn();
        } finally {
          buttons.forEach((x) => (x.disabled = false));
        }
      });
      buttons.push(b);
      return b;
    };

    let cfg = null;
    let cap = 256;
    let current = { path: null, bytes: null, bookId: null };

    const formConfig = () => {
      const server = normalizeServer(f.server.value);
      const user = f.user.value.trim();
      const password = f.password.value;
      if (!server) throw new Error('Enter the BookOrbit server address, for example http://192.168.1.50:3000.');
      if (!user) throw new Error('Enter your BookOrbit KOReader sync username.');
      if (!password && !(cfg && cfg.key)) throw new Error('Enter your KOReader sync password.');
      const dest = f.dest.value.trim().replace(/\/+$/, '');
      if (dest && (!dest.startsWith('/') || dest.includes('..'))) throw new Error('The download folder must be an absolute path like /Books/BookOrbit.');
      return {
        cfg: { server, user, key: password ? md5(password) : cfg.key, device_id: (cfg && cfg.device_id) || '', dest_dir: dest || DEFAULT_DEST },
        password,
      };
    };

    const requireConfig = () => {
      if (!cfg || !cfg.server || !cfg.key) throw new Error('Save your BookOrbit connection first.');
      return cfg;
    };

    async function deviceId() {
      try {
        const st = await (await fetch('/api/status?plugin=cp-orbit')).json();
        if (st && st.device) cap = /^picco$/i.test(st.device) ? 1024 : 256; // ESP32-S3 boards keep 1024 per book
        if (st && /^[A-Za-z0-9_-]{1,100}$/.test(st.deviceId || '')) return st.deviceId;
      } catch (e) {
        /* fall through */
      }
      const rnd = new Uint8Array(12);
      crypto.getRandomValues(rnd);
      return 'cp-orbit-' + Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    async function onTest() {
      try {
        const { cfg: next } = formConfig();
        say(setupMsg, 'Connecting…');
        const r = await testConnection(boClient(api, next));
        say(setupMsg, 'Connected' + (r.username ? ' as ' + r.username : '') + (r.serverVersion ? ' (BookOrbit ' + r.serverVersion + ')' : '') + '.', 'ok');
      } catch (e) {
        say(setupMsg, e.message, 'error');
      }
    }

    async function onSave() {
      try {
        const { cfg: next, password } = formConfig();
        say(setupMsg, 'Checking the login…');
        await testConnection(boClient(api, next));
        next.device_id = next.device_id || (await deviceId());
        await writeJson(api, CONFIG_PATH, next);
        cfg = next;
        f.password.value = '';
        f.password.placeholder = 'Saved (leave empty to keep)';
        let text = 'Saved.';
        if (f.progress.checked) {
          const k = await applyKosync(next, password, f.ask.value === 'ask', confirmFn);
          if (k.declined) text += ' The reader\'s progress sync was left unchanged.';
          else {
            text += ' Reader progress sync now uses BookOrbit (binary matching, ' + (f.ask.value === 'ask' ? 'asks when positions differ' : 'furthest position wins') + ', clipping sync off).';
            if (k.passwordKept) text += ' Enter the password again to update it on the reader too.';
            if (k.skipped.length) text += ' Not set on this firmware: ' + k.skipped.join(', ') + '.';
          }
        }
        say(setupMsg, text, 'ok');
      } catch (e) {
        say(setupMsg, e.message, 'error');
      }
    }

    async function onShelves() {
      try {
        const c = requireConfig();
        say(shelfMsg, 'Loading collections and SmartScopes…');
        const r = await updateShelves(api, boClient(api, c));
        say(shelfMsg, r.kept + ' shelves added to Home → Plugins → BookOrbit.' + (r.dropped ? ' ' + r.dropped + ' did not fit in the reader\'s list limit.' : ''), 'ok');
      } catch (e) {
        say(shelfMsg, e.message, 'error');
      }
    }

    const selectedBook = () => {
      const path = bookSelect.value === '__other' ? otherPath.value.trim() : bookSelect.value;
      if (!path) throw new Error('Choose a book.');
      const opt = bookSelect.selectedOptions && bookSelect.selectedOptions[0];
      return { path, title: (opt && opt.dataset && opt.dataset.title) || '', author: (opt && opt.dataset && opt.dataset.author) || '' };
    };

    const bookBytes = async (path) => {
      if (current.path !== path || !current.bytes) {
        const bytes = await readBytes(path);
        if (!bytes) throw new Error('Book not found on the SD card: ' + path);
        current = { path, bytes, bookId: null };
      }
      return current.bytes;
    };

    async function onSyncBook() {
      try {
        const c = requireConfig();
        const book = selectedBook();
        const r = await syncHighlights({ api, cfg: c, bo: boClient(api, c), cap }, book, (t) => say(bookMsg, t));
        say(bookMsg, describeSync(r), r.unmatched || r.incompatible ? 'error' : 'ok');
      } catch (e) {
        say(bookMsg, e.message, 'error');
      }
    }

    async function onSyncAll() {
      try {
        const c = requireConfig();
        const books = Array.from(bookSelect.options).filter((o) => o.value && o.value !== '__other');
        const lines = [];
        for (const [i, o] of books.entries()) {
          const book = { path: o.value, title: o.dataset.title || '', author: o.dataset.author || '' };
          try {
            const r = await syncHighlights({ api, cfg: c, bo: boClient(api, c), cap }, book, (t) => say(bookMsg, '(' + (i + 1) + '/' + books.length + ') ' + (book.title || book.path) + ': ' + t));
            lines.push((book.title || book.path) + ': ' + describeSync(r));
          } catch (e) {
            if (e.status === 401 || e.status === 403) throw e;
            lines.push((book.title || book.path) + ': ' + e.message);
          }
        }
        say(bookMsg, lines.join('\n') || 'No recent books.', 'ok');
        bookMsg.style.whiteSpace = 'pre-line';
      } catch (e) {
        say(bookMsg, e.message, 'error');
      }
    }

    async function onLoadStatus() {
      try {
        const c = requireConfig();
        const bo = boClient(api, c);
        const { path } = selectedBook();
        say(bookMsg, 'Looking the book up in BookOrbit…');
        const id = await bookIdFor({ bo, cfg: c }, path, () => bookBytes(path));
        if (!id) throw new Error('BookOrbit does not have this exact file.');
        const detail = await bo.get(CATALOG + '/books/' + id);
        current.path = path;
        current.bookId = id;
        statusSelect.value = (detail && detail.readStatus) || '';
        ratingSelect.value = detail && detail.rating ? String(detail.rating) : '';
        statusBox.style.display = '';
        say(bookMsg, (detail && detail.title ? detail.title + ': ' : '') + 'change the status or rating, then press Save status & rating.', 'ok');
      } catch (e) {
        say(bookMsg, e.message, 'error');
      }
    }

    async function onSaveStatus() {
      try {
        const c = requireConfig();
        const { path } = selectedBook();
        if (current.path !== path || !current.bookId) throw new Error('Press Show status & rating for this book first.');
        const bo = boClient(api, c);
        if (statusSelect.value) await bo.put(CATALOG + '/books/' + current.bookId + '/read-status', { status: statusSelect.value });
        await bo.put(CATALOG + '/books/' + current.bookId + '/rating', { rating: ratingSelect.value ? Number(ratingSelect.value) : null });
        say(bookMsg, 'Status and rating saved to BookOrbit.', 'ok');
      } catch (e) {
        say(bookMsg, e.message, 'error');
      }
    }

    bookSelect.addEventListener('change', () => {
      otherPath.style.display = bookSelect.value === '__other' ? '' : 'none';
      statusBox.style.display = 'none';
    });

    container.replaceChildren(
      el('h2', {}, 'BookOrbit ', el('small', { style: 'font-weight:normal;opacity:.7' }, 'v' + VERSION)),
      el('h3', {}, 'Connection'),
      row('Server', f.server),
      row('KOReader sync username', f.user),
      row('KOReader sync password', f.password),
      row('Download folder', f.dest),
      row('Use BookOrbit for reading progress', f.progress),
      row('When positions differ', f.ask),
      el('div', { class: 'setting-row' }, button('Test connection', onTest), ' ', button('Save', onSave)),
      setupMsg,
      el('h3', {}, 'Shelves'),
      el('p', {}, 'Adds your BookOrbit collections and SmartScopes to the on-device catalog (your libraries are listed there already).'),
      el('div', { class: 'setting-row' }, button('Update shelves', onShelves)),
      shelfMsg,
      el('h3', {}, 'Highlights, status and rating'),
      row('Book', el('span', {}, bookSelect, otherPath)),
      el('div', { class: 'setting-row' }, button('Sync highlights', onSyncBook), ' ', button('Sync all recent books', onSyncAll), ' ', button('Show status & rating', onLoadStatus)),
      statusBox,
      el('div', { class: 'setting-row' }, button('Save status & rating', onSaveStatus)),
      bookMsg
    );

    return (async () => {
      try {
        cfg = await readJson(CONFIG_PATH);
        if (cfg) {
          f.server.value = cfg.server || '';
          f.user.value = cfg.user || '';
          f.dest.value = cfg.dest_dir || '';
          if (cfg.key) f.password.placeholder = 'Saved (leave empty to keep)';
        }
        const restored = await restoreShelves(api);
        if (restored) say(shelfMsg, 'Shelves restored (' + restored + ').', 'ok');
        const recent = await readJson(RECENT_PATH);
        const books = ((recent && recent.books) || []).filter((b) => /\.epub$/i.test(b.path || ''));
        bookSelect.replaceChildren(
          ...books.map((b) => {
            const o = el('option', { value: b.path }, (b.title || b.path) + (b.author ? ' — ' + b.author : ''));
            o.dataset.title = b.title || '';
            o.dataset.author = b.author || '';
            return o;
          }),
          el('option', { value: '__other' }, 'Another book (type its path)')
        );
        if (!books.length) {
          bookSelect.value = '__other';
          otherPath.style.display = '';
        }
        if (cfg) await deviceId();
      } catch (e) {
        say(setupMsg, e.message, 'error');
      }
    })();
  }

  const lib = {
    VERSION,
    PLUGIN_VERSION,
    md5,
    partialMd5,
    hashPath,
    clippingStorePath,
    parseStore,
    buildStore,
    localKey,
    decodeNamedEntities,
    parseChapter,
    xpointerFor,
    parseXPointer,
    visibleAt,
    visibleSlice,
    findText,
    openEpub,
    planUpload,
    applyRemote,
    syncHighlights,
    describeSync,
    boClient,
    applyKosync,
    shelfLists,
    mergeShelves,
    updateShelves,
    restoreShelves,
    normalizeServer,
    deviceDatetime,
    render,
  };
  if (typeof globalThis !== 'undefined' && globalThis.__CP_ORBIT_TEST__) globalThis.__CP_ORBIT_TEST__.lib = lib;
  if (typeof CrossPoint !== 'undefined') CrossPoint.registerPlugin(render); // eslint-disable-line no-undef
})();
