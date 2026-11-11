---
name: readme-media
description: Regenerate the README's images for cp-orbit. That covers the real web-card recording (web-card.gif/png), the illustrated BOOX Picco screens and walkthrough GIF (picco-showcase.png, picco-walkthrough.gif), and framing real reader screenshots in the same Picco frame. Use this whenever the web card's UI or wording changes, the catalog lists or on-reader flow change, the user asks for screenshots, a GIF, demo images, device mockups or "make the README look nicer", or brings BMP screenshots from the reader.
---

# README media for cp-orbit

Everything renders with Google Chrome in headless mode, and GIFs are built with `ffmpeg`. The web card's page shell
comes from the CrossPoint firmware; it's fetched with `gh` once and cached in `.cache/crosspoint-web/` (git-ignored).
Outputs go to `docs/images/`, which the README already references.

There are two kinds of image, and they must stay honest:

- **Real recordings:** the plugin's actual web card, captured in Chrome through the firmware's own Plugins page and
  `plugin-host.js`, against a demo server with public-domain books. Captions say "recorded against a demo library".
- **Illustrations:** on-reader screens drawn in CrossPoint 2.0's Lyra layout with the firmware's English strings.
  They are labelled "Illustrated screens" / "Illustration" inside the images and in the README captions. Never
  present them as device captures. When the user has real screenshots, prefer those (section 3).

## 1. Web card recording (after any `plugin.js` UI change)

```bash
node .claude/skills/readme-media/scripts/web-card.mjs
```

The script starts a stand-in reader with the mock BookOrbit from `tests/`, then drives the card the way a user would:
Save (which also syncs the catalog lists), Sync highlights, then show and save status and rating. It writes:

- `docs/images/web-card.gif`: about 760 px wide, around 300 KB.
- `docs/images/web-card.png`: the full card, 2× resolution.

Then look at the PNG (Read it) to catch layout regressions. That's how the narrow Server field was found. If a button
label or message text changes, update the `until(...)` checks and `press('…')` labels in the script, or the run times
out.

## 2. Illustrated Picco screens (after catalog or on-reader flow changes)

```bash
node .claude/skills/readme-media/scripts/illustrate.mjs
```

The script draws eight 480×800 screens: Plugins, the BookOrbit lists, Continue reading, search, downloading, a page
with a highlight, Progress found, and the session message. It frames them with `scripts/frame-screenshots.mjs` and
writes:

- `docs/images/picco-showcase.png`: four frames, 2000 px wide.
- `docs/images/picco-walkthrough.gif`: eight steps with an e-ink flash between them.

**Keep the screens truthful.** The `screens` object in `illustrate.mjs` must match what the plugin and firmware really
show:
- list titles from `device.json` `browse.lists`, plus the library, `Collection · …` and `SmartScope · …` lists `plugin.js` writes;
- strings from the firmware's `lib/I18n/translations/english.yaml`, such as `Progress found!`,
  `Page %d, %.2f%% overall`, `Apply remote progress`;
- the Lyra metrics in `src/components/themes/lyra/LyraTheme.h`.

Use public-domain books and quotes only.

## 3. Real reader screenshots

On the reader, **Power + Down** saves `/screenshots/*.bmp`, already in 480×800 portrait. Get them from the SD card, or
over Wi-Fi with File Transfer open:

```bash
curl -s "http://<reader-ip>/api/files?path=/screenshots"
```

```bash
curl -o shot.bmp "http://<reader-ip>/download?path=/screenshots/<file>.bmp"
```

Then frame them, using `NOTE=""` because these are real captures:

```bash
node scripts/frame-screenshots.mjs docs/images shot1.bmp=Catalog shot2.bmp="Progress sync" shot3.bmp=Highlights
```

The script writes `picco-<name>.png` per shot, plus `picco-showcase.png` when there's more than one. Shrink the
showcase before committing (`ffmpeg -i in.png -vf scale=2000:-1 out.png`). Then change the README caption from
"Illustrated screens…" to say they're real captures.

## Finish

- Keep README images light: GIFs under about 500 KB, and PNGs scaled so they aren't megabytes.
- Use `sips -g pixelWidth -g pixelHeight` or `ls -la` to check sizes.
- Commit the images together with any README caption changes.
- No release is needed: README images aren't in the plugin zip.
