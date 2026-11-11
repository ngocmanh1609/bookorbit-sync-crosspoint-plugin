// Test harness: runs plugin.js the way the reader's Plugins page does, against an
// in-memory SD card, the reader's web endpoints and a mock BookOrbit.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import JSZip from 'jszip';
import { DOMParser, parseHTML } from 'linkedom';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PAYLOAD = ROOT + 'cp-orbit.crosspoint-plugin/';
export const PLUGIN_DIR = '/plugins/cp-orbit';
const CODE = readFileSync(PAYLOAD + 'plugin.js', 'utf8');
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A reader with an SD card, its web API (as plugin-host.js exposes it) and a BookOrbit behind the relay. */
export function fakeReader({ bookorbit, files = {}, settings, status } = {}) {
  const sd = new Map(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? enc.encode(v) : v]));
  const writes = [];
  const settingsPosts = [];
  const relays = [];
  const reader = {
    sd,
    writes,
    settingsPosts,
    relays,
    failWrites: null,
    settings: settings || {
      koServerUrl: { key: 'koServerUrl', type: 'string', value: '' },
      koUsername: { key: 'koUsername', type: 'string', value: '' },
      koServerType: { key: 'koServerType', type: 'enum', value: 0, options: ['CrossPoint', 'KOSync', 'Other'] },
      koMatchMethod: { key: 'koMatchMethod', type: 'enum', value: 0, options: ['Filename', 'Binary'] },
      koSyncBehavior: { key: 'koSyncBehavior', type: 'enum', value: 0, options: ['Ask every time', 'Smart'] },
      // Off/On enums come back as toggles without options (CrossPointWebServer::handleGetSettings).
      koSyncClippings: { key: 'koSyncClippings', type: 'toggle', value: 1 },
    },
    status: status || { device: 'picco', deviceId: 'a'.repeat(64) },
    readText: (p) => (sd.has(p) ? dec.decode(sd.get(p)) : null),
    readJson: (p) => (sd.has(p) ? JSON.parse(dec.decode(sd.get(p))) : null),
  };

  const response = (status, body, type = 'application/json') => {
    const bytes = typeof body === 'string' ? enc.encode(body) : body;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([['content-type', type]]),
      json: async () => JSON.parse(dec.decode(bytes)),
      text: async () => dec.decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };

  reader.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://crosspoint.local');
    if (u.pathname === '/download') {
      const p = u.searchParams.get('path');
      if (p.split('/').pop().startsWith('.')) return response(403, 'Cannot access system files', 'text/plain');
      return sd.has(p) ? response(200, sd.get(p), 'application/octet-stream') : response(404, 'Item not found', 'text/plain');
    }
    if (u.pathname === '/api/status') return response(200, JSON.stringify(reader.status));
    if (u.pathname === '/api/settings' && (init.method || 'GET') === 'GET') {
      const keys = (u.searchParams.get('keys') || '').split(',');
      return response(200, JSON.stringify(keys.map((k) => reader.settings[k]).filter(Boolean)));
    }
    if (u.pathname === '/api/settings' && init.method === 'POST') {
      const update = JSON.parse(init.body);
      settingsPosts.push(update);
      for (const [k, v] of Object.entries(update)) if (reader.settings[k]) reader.settings[k].value = v;
      return response(200, 'Applied ' + Object.keys(update).length + ' setting(s)', 'text/plain');
    }
    return response(404, 'Not found', 'text/plain');
  };

  reader.api = {
    name: 'cp-orbit',
    dir: PLUGIN_DIR,
    async relay(method, url, headers, body) {
      relays.push({ method, url, headers, body });
      const r = bookorbit.handle(method, url, headers, body);
      if (r.body.length > 64 * 1024) {
        const err = new Error('/api/relay 502: relay failed; large bodies need /api/fetch');
        err.status = 502;
        throw err;
      }
      return { status: r.status, headers: [], body: r.body };
    },
    async writeFile(path, b64) {
      if (reader.failWrites && reader.failWrites(path)) {
        const err = new Error('/api/plugin-fs 413: too large');
        err.status = 413;
        throw err;
      }
      const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
      writes.push(path);
      sd.set(path, bytes);
      return { ok: true, bytes: bytes.length };
    },
    async fetchToSd(url, dest, headers, options) {
      const method = (options && options.method) || 'GET';
      const body = (options && options.body) || '';
      if (body.length > 4096) {
        const err = new Error('/api/fetch 400: body over 4KB');
        err.status = 400;
        throw err;
      }
      const r = bookorbit.handle(method, url, headers, body);
      sd.set(dest, enc.encode(r.body));
      return { status: r.status, bytes: r.body.length, complete: true };
    },
  };
  return reader;
}

/** Loads plugin.js in a fresh context; returns its exported helpers and the registered render fn. */
export function loadPlugin(reader) {
  const hook = {};
  const registered = [];
  const { document, window } = parseHTML('<!DOCTYPE html><html><head></head><body><div id="c"></div></body></html>');
  shimFormControls(document);
  window.confirm = () => (reader && reader.confirm ? reader.confirm() : true);
  const context = vm.createContext({
    __CP_ORBIT_TEST__: hook,
    CrossPoint: { registerPlugin: (fn) => registered.push(fn) },
    // Share typed arrays with this realm so JSZip (loaded here) accepts the plugin's bytes.
    Uint8Array,
    Int32Array,
    ArrayBuffer,
    DataView,
    TextEncoder,
    TextDecoder,
    DOMParser,
    URL,
    JSZip,
    btoa,
    atob,
    crypto: webcrypto,
    console,
    document,
    window,
    fetch: (...args) => reader.fetch(...args),
  });
  vm.runInContext(CODE, context, { filename: 'plugin.js' });
  return { lib: hook.lib, registered, document };
}

/** linkedom has no checkbox `checked` or select `value`; browsers do. Test-only shims. */
function shimFormControls(document) {
  const inputProto = Object.getPrototypeOf(document.createElement('input'));
  if (!('checked' in inputProto)) {
    Object.defineProperty(inputProto, 'checked', {
      get() { return this.hasAttribute('checked'); },
      set(v) { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); },
    });
  }
  const selectProto = Object.getPrototypeOf(document.createElement('select'));
  if (!('value' in selectProto) || document.createElement('select').value === undefined) {
    const options = (s) => Array.from(s.querySelectorAll('option'));
    const selected = (s) => options(s).find((o) => o.hasAttribute('selected')) || options(s)[0] || null;
    Object.defineProperty(selectProto, 'value', {
      get() { const o = selected(this); return o ? o.getAttribute('value') ?? o.textContent : ''; },
      set(v) { for (const o of options(this)) { if ((o.getAttribute('value') ?? o.textContent) === String(v)) o.setAttribute('selected', ''); else o.removeAttribute('selected'); } },
    });
    Object.defineProperty(selectProto, 'options', { get() { return options(this); } });
    Object.defineProperty(selectProto, 'selectedOptions', { get() { const o = selected(this); return o ? [o] : []; } });
  }
}

/** JSON copy, for comparing objects made inside the plugin's sandbox. */
export const plain = (x) => JSON.parse(JSON.stringify(x));

/** Builds an EPUB from chapter bodies: [{ id, body }] with optional raw `xhtml`. */
export async function makeEpub(chapters, { title = 'Test Book', author = 'Tess Writer' } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const items = chapters.map((c, i) => `<item id="c${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const refs = chapters.map((c, i) => `<itemref idref="c${i}"/>`).join('');
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator></metadata><manifest>${items}</manifest><spine>${refs}</spine></package>`);
  chapters.forEach((c, i) => {
    zip.file(`OEBPS/text/ch${i}.xhtml`, c.xhtml || `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch ${i}</title></head><body>${c.body}</body></html>`);
  });
  return zip.generateAsync({ type: 'uint8array' });
}

/** Independent encoder of the firmware's clipping store, field by field from src/ClippingStore.cpp. */
export function encodeStoreRef({ version = 4, title, author, path, records }) {
  const out = [];
  const u8 = (v) => out.push(v & 255);
  const u16 = (v) => out.push(v & 255, (v >>> 8) & 255);
  const u32 = (v) => out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  const bytes = (b) => out.push(...b);
  const str = (s) => {
    const b = enc.encode(s);
    u32(b.length);
    bytes(b);
  };
  const fixed = (s, n) => {
    const b = enc.encode(s);
    for (let i = 0; i < n; i++) out.push(i < b.length ? b[i] : 0);
  };
  u8(version);
  u16(records.length);
  str(title);
  str(author);
  str(path);
  for (const r of records) {
    u16(r.spine); u16(r.startPage ?? 0); u16(r.endPage ?? 0); u16(r.pageCount ?? 1);
    u16(r.startWord ?? 0); u16(r.endWord ?? 0); u16(r.wordCount ?? 0); u16(r.paragraph ?? 0xffff);
    u32(r.timestamp ?? 0);
    if (version >= 3) u32(r.layoutSig ?? 0);
    if (version >= 4) {
      u32(r.startOffset ?? 0xffffffff); u32(r.endOffset ?? 0xffffffff);
      u32(r.revLo ?? 0); u32(r.revHi ?? 0); u8(r.pending ?? 1); fixed(r.id ?? '', 65);
    }
    fixed(r.chapter ?? '', 48);
    const text = enc.encode(r.text);
    if (version === 1) u32(text.length);
    else u16(text.length);
    bytes(text);
  }
  return Uint8Array.from(out);
}
