// The payload contract: firmware limits (folder name, manifest size, README size) and
// the Plugin Hub rules (PLUGIN_HUB_CONTRACT.md), plus the release zip layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { ROOT, PAYLOAD } from './helpers.mjs';

const manifest = JSON.parse(readFileSync(PAYLOAD + 'manifest.json', 'utf8'));
const device = JSON.parse(readFileSync(PAYLOAD + 'device.json', 'utf8'));
const bytes = (s) => Buffer.byteLength(s, 'utf8');
// src/util/FirmwareIdentity.h on CrossPoint 2.0.0
const FIRMWARE_CAPABILITIES = ['catalog.lists', 'catalog.notices', 'catalog.bundle_install', 'catalog.version_tracking', 'catalog.compatibility', 'catalog.item_details', 'catalog.encoded_item_fields', 'catalog.list_index_mapping', 'catalog.list_requirements', 'catalog.server_paths'];

test('one payload folder named after a short, safe plugin id', () => {
  const payloads = readdirSync(ROOT).filter((d) => d.endsWith('.crosspoint-plugin'));
  assert.deepEqual(payloads, ['cp-orbit.crosspoint-plugin']);
  assert.equal(manifest.name, 'cp-orbit');
  assert.match(manifest.name, /^[a-z0-9-]+$/);
  assert.ok(bytes(manifest.name) <= 23, 'events need a folder name of 23 bytes or fewer');
  assert.ok(bytes('/.crosspoint/plugins/' + manifest.name) <= 63, 'and a full path of 63 bytes or fewer');
  assert.equal(manifest.mount, 'settings');
});

test('versions agree everywhere', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const js = readFileSync(PAYLOAD + 'plugin.js', 'utf8');
  assert.equal(/const VERSION = '([^']+)'/.exec(js)[1], manifest.version);
  const pv = /"pluginVersion\\":\\"([^\\]+)\\"/.exec(JSON.stringify(device))[1];
  assert.equal(pv, 'cp-orbit/' + manifest.version);
  assert.ok(pv.length <= 20, 'BookOrbit caps pluginVersion at 20 characters');
});

test('declared files are safe, present and complete; no user config ships', () => {
  const onDisk = readdirSync(PAYLOAD).filter((f) => statSync(PAYLOAD + f).isFile()).sort();
  assert.deepEqual([...manifest.files].sort(), onDisk);
  for (const f of manifest.files) assert.ok(!f.startsWith('/') && !f.includes('..') && !f.includes('\\'), f);
  assert.ok(manifest.files.includes('manifest.json') && manifest.files.includes('device.json') && manifest.files.includes('plugin.js'));
  assert.ok(!manifest.files.includes('config.json'));
});

test('firmware size limits and settings outside the plugin folder', () => {
  assert.ok(bytes(readFileSync(PAYLOAD + 'device.json', 'utf8')) <= 8000, 'device.json is read up to 8KB (shelves need headroom)');
  assert.ok(bytes(readFileSync(PAYLOAD + 'README.md', 'utf8')) <= 16 * 1024, 'the on-device README is shown up to 16KB');
  assert.ok(device.config.file.startsWith('/') && !device.config.file.startsWith('/plugins/') && !device.config.file.includes('..'));
  for (const cap of manifest.compatibility.requires) assert.ok(FIRMWARE_CAPABILITIES.includes(cap), cap);
  assert.deepEqual(manifest.compatibility.firmware_family, ['crosspoint']);
});

test('release zip holds exactly cp-orbit/<declared files>', async () => {
  const out = mkdtempSync(join(tmpdir(), 'cp-orbit-'));
  const r = spawnSync('sh', [join(ROOT, 'scripts/package.sh'), 'v' + manifest.version], { env: { ...process.env, OUT_DIR: out }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const zip = await JSZip.loadAsync(readFileSync(join(out, `cp-orbit-${manifest.version}.zip`)));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  assert.deepEqual(names, manifest.files.map((f) => 'cp-orbit/' + f).sort());
  const bad = spawnSync('sh', [join(ROOT, 'scripts/package.sh'), '9.9.9'], { env: { ...process.env, OUT_DIR: out }, encoding: 'utf8' });
  assert.notEqual(bad.status, 0, 'refuses a tag that does not match the manifest');
});
