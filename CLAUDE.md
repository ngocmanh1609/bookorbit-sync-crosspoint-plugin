# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cp-orbit` is a CrossPoint e-reader SD-card plugin that brings BookOrbit's KOReader-plugin features to CrossPoint. It
is verified on the BOOX Picco (CrossPoint 2.0.0) only. The installable payload is `cp-orbit.crosspoint-plugin/`, and
everything else is development tooling. There is no build step and there are no runtime dependencies: `plugin.js`
ships as written.

## Commands

```bash
npm ci                     # dev deps only: jszip, linkedom
npm test                   # node --test tests/*.test.mjs (34 tests, no network)
node --test tests/core.test.mjs                                   # one file
node --test --test-name-pattern="sync:" tests/core.test.mjs       # tests whose name matches
sh scripts/package.sh      # -> dist/cp-orbit-<version>.zip containing one cp-orbit/ folder
node scripts/frame-screenshots.mjs <out-dir> <shot.bmp>[=Caption] ...   # README device frames (needs Chrome)
```

CI (`.github/workflows/tests.yml`) runs `npm test` on Node 22. Pushing a tag `v<version>` runs `release.yml`, which
tests, checks the tag against `manifest.json`, builds the zip and publishes the GitHub Release. Plugin Hub lists the
plugin from that Release; the repo also needs the GitHub topic `crosspoint-plugin`.

## Project skills (`.claude/skills/`)

| Skill | Use it for | Script |
|---|---|---|
| `release` | Shipping a version | `scripts/bump-version.mjs` updates all three version spots and creates the release-notes stub. The skill covers the CI-gated tag and the GitHub auth quirks. |
| `deploy-to-picco` | Putting this checkout on the reader over Wi-Fi | `scripts/deploy.sh <reader-ip> [files]` (`DRY_RUN=1` prints the requests). The skill says when a restart is needed. |
| `readme-media` | Regenerating `docs/images/` | `scripts/web-card.mjs` (real web-card recording) and `scripts/illustrate.mjs` (illustrated Picco screens and GIF). Both need Chrome, ffmpeg and `gh`. |

## Architecture

The plugin has two halves, because CrossPoint plugins cannot run code on the reader:

- **`device.json`**: declarative, and executed by the firmware.
  - **Catalog:** lists, `lists_url` for libraries, search, and download through `url_path: files.0.downloadUrl`, plus
    a `.meta.json` sidecar.
  - **Events:** the `reader.session` event is posted to BookOrbit's `/api/v1/koreader/plugin/page-stats`.
  - **Template variables:** only `{cfg.*}`, `{event.*}`, `{page}`, `{limit}`, `{query}`, `{id_enc}` and friends.
    `tests/render.test.mjs` fails on unknown variables.
  - **Raw insertion:** values are inserted raw into the JSON body, so config values must never contain quotes.
- **`plugin.js`**: the "web card" on the reader's Plugins page, a single IIFE.
  - **Loading:** the firmware's `plugin-host.js` loads it, and it must call `CrossPoint.registerPlugin(render)`
    synchronously.
  - **API it gets:** `api.relay` (outbound HTTP, 64KB answer cap), `api.writeFile` (SD writes, up to 256KB, creates
    parent folders), `api.fetchToSd`, and `api.dir`.
  - **Same-origin endpoints it uses:** `/download?path=`, `/api/settings`, `/api/status?plugin=cp-orbit`.
  - **Fallback:** `boClient` switches to `fetchToSd` when a relay answer is over the cap. That only works for
    request bodies of 4KB or less.

BookOrbit auth is header-only: `x-auth-user` plus `x-auth-key`, the MD5 of the KOReader-sync password. There is no
token flow, so `device.json` has no `token`/`auth` block.

**User data lives in `/.cp-orbit/` on the SD card**, never in the plugin folder, so replacing the folder on update
keeps it:
- `config.json`: `server`, `user`, `key`, `device_id`, `dest_dir`. `device.json` points `config.file` at this
  absolute path.
- `shelves.json`: the last synced catalog lists.
  - **What `syncShelves` writes:** it runs on every card load and after Save, and writes libraries,
    `Collection · …` and `SmartScope · …` lists into `device.json`, marked `"shelf": true`. It hides
    collections and SmartScopes with `count === 0`.
  - **Why it drops `lists_url`:** the firmware shows fetched lists after the manifest's own, and allows only one
    level of lists, so nested "Collections → collection" is impossible. Dropping it keeps libraries first. The
    shipped file keeps `lists_url` as the fallback.
  - **No server:** `restoreShelves` re-applies `shelves.json` when BookOrbit is unreachable after an update.
  - **Writes:** it rewrites `device.json` only when the lists change.
- `state/<partialMd5>.json`: highlight sync state.
- `backup/`: copies of the reader's highlight file.

**Progress sync is the firmware's own KOSync, not plugin code.** Save on the card calls `POST /api/settings`
(`applyKosync`) with these values:

| Setting | Value |
|---|---|
| `koServerUrl` | `<server>/api/v1/koreader` |
| `koServerType` | KOSync (1) |
| `koMatchMethod` | Binary (1) |
| `koSyncBehavior` | Ask (0) or Smart (1) |
| `koSyncClippings` | Off (0) |

Enum values are firmware indices. Off/On settings come back from `GET /api/settings` as `type: "toggle"` with no
`options` array. An earlier bug skipped them because of that, which left clipping sync on and made Sync progress fail.

**Two-way highlights** (`syncHighlights`) are the complex part. They tie together three formats from upstream
sources:

1. **The reader's clipping store:** `/.crosspoint/clippings/epub_<hash>.bin`.
   - **Format:** version 4, little-endian, 156 fixed bytes plus the text per record (firmware `src/ClippingStore.cpp`).
     `parseStore` and `buildStore` are a byte-exact codec.
   - **File name:** `<hash>` is libstdc++'s 32-bit `std::hash` of the book path (MurmurHash2, seed `0xc70f6907`). It
     is checked against a known value (`/Books/Test/Book.epub` → `2361001545`).
2. **Two position systems from one DOM walk** (`chapterModel`):
   - **Reader offsets** are code points of all text inside `<body>` except `head/style/script/title/rp` (firmware
     `ChapterHtmlSlimParser::characterData`).
   - **KOReader xpointers** use crengine text runs per parent, where repeated ASCII whitespace collapses. They mirror
     BookOrbit's `position-converter/chapter-text-index.ts`.
   - **Spine numbering:** DocFragment index = spine index + 1, counting every itemref.
3. **BookOrbit's annotation exchange:**
   - **Requests:** the first request sends all keys, `k = md5(datetime|pos0)`, plus up to 50 changes per request.
   - **Applying:** remote changes are written to the `.bin` **before** the `exchange-ack`. A failed placement is acked
     as `status: failed`, never placed by guessing.
   - **Distrusting saved state:** state is ignored when the book path changed or the store is missing. The exchange
     then sends `sidecarState: 'new'`, so BookOrbit deletes nothing.
   - **Datetimes:** they come from the record timestamp, stay unique per book, and are persisted in state.
   - **Re-offered adds:** they are adopted by overlap and text, not duplicated.

Book identity everywhere is KOReader's **partial MD5**: 1 KiB at 0 and at 1024·4^i.

## Hard constraints (tests enforce most of them)

- **Folder name:** the plugin ID and SD folder name are `cp-orbit`. The firmware only delivers events to folders
  named 23 bytes or less, so the release zip's top folder is `cp-orbit/`, not `cp-orbit.crosspoint-plugin/`.
- **Version:** it lives in three places that must match:
  - `manifest.json` `version`;
  - `device.json` `pluginVersion` `cp-orbit/<ver>`, 20 characters or less (BookOrbit's DTO);
  - `plugin.js` `VERSION`.

  Each release also needs `docs/release-notes/<ver>.md`.
- **Size limits:** `device.json` stays at 8000 bytes or less, which leaves room for shelves, and the payload
  `README.md` at 16KB or less. `manifest.json` `files` must list exactly the payload files.
- **Book formats:** the catalog filters `format=epub`, because the reader opens only EPUB/TXT/MD/XTC and
  `download.filename` is fixed to `.epub`.
- **Test DOM:** tests run `plugin.js` in `node:vm` with linkedom (`tests/helpers.mjs`). linkedom lacks
  `checkbox.checked` and `select.value`, so the harness shims them. Don't work around this in `plugin.js`.
  Objects coming out of the sandbox need `plain()` before `deepStrictEqual`.
- **Mock server:** `tests/mock-bookorbit.mjs` models BookOrbit's DTO validation and exchange rules. Keep it aligned
  with the server source when behaviour changes.
- **README images:** the on-reader images (`picco-*.png/gif`) are **illustrations**, labelled as such. The web-card
  GIF/PNG are real recordings against a demo server. Don't present illustrations as device captures.

## Upstream sources of truth

To check firmware or server behaviour, read the source with `gh api` instead of guessing.

**CrossPoint firmware** (`crosspoint-reader/crosspoint-reader`, branch `develop`):
- `docs/sd-plugins.md` and `docs/plugin-events.md`
- `docs/webserver-endpoints.md`
- `src/activities/plugins/PluginCatalogActivity.cpp`
- `src/util/PluginEvents.cpp`
- `src/ClippingStore.cpp`
- `src/SettingsList.cpp` (the `ko*` keys)
- `src/network/CrossPointWebServer.cpp`
- `src/network/html/js/plugin-host.js`
- `lib/KOReaderSync/`

**BookOrbit** (`bookorbit/bookorbit`):
- `server/src/modules/koreader/`: DTOs, `koreader-catalog.service.ts`, `koreader-annotation-exchange.service.ts`
- `server/src/modules/annotation/annotation-sync.service.ts`
- `server/src/modules/position-converter/`
- `packages/types/src/koreader.ts`

**Plugin Hub rules:** `crosspoint-reader/crosspoint-plugin-hub` `PLUGIN_HUB_CONTRACT.md`.
