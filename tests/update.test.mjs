// The update notice: the card asks the Plugin Hub catalog (what the Hub can install now) at most once a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeReader, loadPlugin } from './helpers.mjs';
import { createBookOrbit } from './mock-bookorbit.mjs';

const RELEASE = 'https://github.com/ngocmanh1609/bookorbit-sync-crosspoint-plugin/releases/tag/v9.9.9';
const catalog = (version, releaseUrl = RELEASE) =>
  JSON.stringify({ plugins: [{ name: 'bookorbit-sync', version: '99.0.0' }, { name: 'cp-orbit', version, release_url: releaseUrl }] });

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup(body, files = {}) {
  const probe = loadPlugin(fakeReader({ bookorbit: createBookOrbit() })).lib;
  const reader = fakeReader({ bookorbit: createBookOrbit(), files, web: body === undefined ? {} : { [probe.HUB_CATALOG]: body } });
  const { lib, registered, document } = loadPlugin(reader);
  const hubCalls = () => reader.relays.filter((r) => r.url === lib.HUB_CATALOG).length;
  return { reader, lib, registered, document, hubCalls };
}

test('update: versions compare as MAJOR.MINOR.PATCH numbers', () => {
  const { lib } = setup();
  assert.equal(lib.isNewer('0.10.0', '0.9.9'), true);
  assert.equal(lib.isNewer('1.0.0', '0.99.99'), true);
  assert.equal(lib.isNewer('0.3.0', '0.3.0'), false);
  assert.equal(lib.isNewer('0.2.9', '0.3.0'), false);
  assert.equal(lib.isNewer('', '0.3.0'), false);
  assert.equal(lib.isNewer('0.4.0-beta', '0.3.0'), false);
});

test('update: asks the Hub catalog at most once a day, unless asked to', async () => {
  const s = setup(catalog('9.9.9'));
  const day = 24 * 60 * 60 * 1000;
  const first = await s.lib.checkUpdate(s.reader.api, 1000, false);
  assert.deepEqual([first.version, first.releaseUrl], ['9.9.9', RELEASE]);
  assert.deepEqual(s.reader.readJson(s.lib.UPDATE_PATH), { checkedAt: 1000, version: '9.9.9', releaseUrl: RELEASE });
  await s.lib.checkUpdate(s.reader.api, 1000 + day - 1, false);
  assert.equal(s.hubCalls(), 1, 'cached for a day');
  await s.lib.checkUpdate(s.reader.api, 1000 + day - 1, true);
  assert.equal(s.hubCalls(), 2, 'Check for updates always asks');
  await s.lib.checkUpdate(s.reader.api, 1000 + 3 * day, false);
  assert.equal(s.hubCalls(), 3, 'asks again the next day');
});

test('update: a release link that is not on GitHub is dropped', async () => {
  const s = setup(catalog('9.9.9', 'javascript:alert(1)'));
  assert.equal((await s.lib.checkUpdate(s.reader.api, 1, true)).releaseUrl, '');
});

test('card: a newer version in the Hub shows how to update on the reader', async () => {
  const s = setup(catalog('9.9.9'));
  const container = s.document.getElementById('c');
  await s.registered[0](container, s.reader.api);
  const box = container.querySelector('.cp-orbit-update');
  assert.equal(box.style.display, '');
  assert.match(box.textContent, /cp-orbit 9\.9\.9 is available\..*Home → Plugins → Plugin Hub → BookOrbit → Update.*no restart is needed/);
  assert.equal(box.querySelector('a').getAttribute('href'), RELEASE);
  assert.ok(Array.from(box.querySelectorAll('button')).some((b) => b.textContent === 'Reload page'));
});

test('card: no banner on the newest version, and an unreachable Hub stays quiet until asked', async () => {
  const same = setup(catalog(setup().lib.VERSION));
  const c1 = same.document.getElementById('c');
  await same.registered[0](c1, same.reader.api);
  assert.equal(c1.querySelector('.cp-orbit-update').style.display, 'none');
  assert.match(c1.textContent, /You have the newest version/);

  const offline = setup(); // the catalog answers 404
  const c2 = offline.document.getElementById('c');
  await offline.registered[0](c2, offline.reader.api);
  assert.equal(c2.querySelector('.cp-orbit-update').style.display, 'none');
  assert.equal(offline.reader.sd.has(offline.lib.LOG_PATH), false, 'the automatic check logs nothing');
  Array.from(c2.querySelectorAll('button')).find((b) => b.textContent === 'Check for updates').dispatchEvent(new offline.document.defaultView.Event('click'));
  await waitFor(() => /Could not check for updates: Plugin Hub answered HTTP 404/.test(c2.textContent));
  await waitFor(() => /WARN update-check/.test(offline.reader.readText(offline.lib.LOG_PATH) || ''));
});
