#!/usr/bin/env node
// Sets the cp-orbit version everywhere the tests check it, and creates the release notes stub.
//   node .claude/skills/release/scripts/bump-version.mjs 0.2.0
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const P = ROOT + 'cp-orbit.crosspoint-plugin/';
const next = (process.argv[2] || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('usage: bump-version.mjs <MAJOR.MINOR.PATCH>');
  process.exit(1);
}
const pv = 'cp-orbit/' + next;
if (pv.length > 20) throw new Error(`pluginVersion "${pv}" is over BookOrbit's 20-character limit`);

const edit = (file, from, to, what) => {
  const text = readFileSync(file, 'utf8');
  if (!from.test(text)) throw new Error(`${what} not found in ${file}`);
  writeFileSync(file, text.replace(from, to));
};
const manifest = JSON.parse(readFileSync(P + 'manifest.json', 'utf8'));
const prev = manifest.version;
edit(P + 'manifest.json', /"version": "[^"]+"/, `"version": "${next}"`, 'version');
edit(P + 'device.json', /\\"pluginVersion\\":\\"cp-orbit\/[^\\]+\\"/, `\\"pluginVersion\\":\\"${pv}\\"`, 'pluginVersion');
edit(P + 'plugin.js', /const VERSION = '[^']+';/, `const VERSION = '${next}';`, 'VERSION');

const notes = `${ROOT}docs/release-notes/${next}.md`;
if (!existsSync(notes)) {
  writeFileSync(notes, `**cp-orbit ${next}**, BookOrbit for CrossPoint.

> **Verified on the BOOX Picco (CrossPoint 2.0.0) only.** Other CrossPoint readers may work but are untested.

## What's new

- TODO

## Update

Use **Sync progress** on the reader, copy the new \`cp-orbit\` folder over the old one, then turn the reader off and on.
Settings are kept in \`/.cp-orbit/\`.
`);
  console.log('created', notes);
}
console.log(`version ${prev} -> ${next}`);
