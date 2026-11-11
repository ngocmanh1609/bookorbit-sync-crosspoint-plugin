# BookOrbit for CrossPoint

[![Release](https://img.shields.io/github/v/release/ngocmanh1609/bookorbit-sync-crosspoint-plugin?label=release)](https://github.com/ngocmanh1609/bookorbit-sync-crosspoint-plugin/releases/latest)
[![Tests](https://github.com/ngocmanh1609/bookorbit-sync-crosspoint-plugin/actions/workflows/tests.yml/badge.svg)](https://github.com/ngocmanh1609/bookorbit-sync-crosspoint-plugin/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 💛 Many thanks to [neonsolstice](https://github.com/neonsolstice) for [BookOrbit](https://github.com/bookorbit/bookorbit)
> and its excellent KOReader plugin, whose features this project brings to CrossPoint, and to
> [Styxbleich](https://github.com/Styxbleich) for
> [BookOrbit-Sync-for-Crosspoint](https://github.com/Styxbleich/BookOrbit-Sync-for-Crosspoint), the plugin that
> showed it could be done on CrossPoint and inspired this one.

Your self-hosted [BookOrbit](https://github.com/bookorbit/bookorbit) library on a
[CrossPoint](https://github.com/crosspoint-reader/crosspoint-reader) e-reader. The plugin browses and downloads books,
syncs reading progress and reading sessions, and syncs highlights, read status and ratings. These are the features of
BookOrbit's [KOReader plugin](https://bookorbit.app/koreader-plugin), rebuilt as a CrossPoint SD-card plugin
(`cp-orbit`).

> [!IMPORTANT]
> **Verified on the BOOX Picco only**, running CrossPoint 2.0.0. Other CrossPoint readers (Xteink X3, X4, X4 Pro, …)
> may work but are untested. Reading sessions need a reader with a clock chip. Reports from other devices are welcome.

<p align="center">
  <img src="docs/images/web-card.gif" alt="The BookOrbit card on the reader's Plugins web page: saving the login, adding shelves, syncing highlights and setting a rating" width="760">
</p>

## Features

**On the reader**

- **Catalog:** Home → Plugins → BookOrbit lists Continue reading, Recently added, Not started, Finished, All books,
  your libraries, and your collections and SmartScopes. Search finds a title or author.
- **Downloads:** pick a book and it is saved to `/Books/BookOrbit` (EPUB only; the reader cannot open PDF or CBZ).
- **Reading sessions and stats:** your reading log, streaks and stats update automatically, when the reader connects
  to Wi-Fi or goes to sleep.
- **Reading progress:** sync your position with BookOrbit, and choose which position wins when they differ.

**On the reader's web page**, from a phone or computer on the same Wi-Fi

- **One-time setup:** enter your login once. The plugin also configures the reader's own progress sync for you.
- **Two-way highlights:** new highlights and deletions go both ways. Every highlight is placed by its position and
  checked against the book's text.
- **Read status and star rating** for any book.

## Install

You need CrossPoint 2.0.0 or newer, a BookOrbit server the reader can reach, and a BookOrbit **KOReader sync login**
(BookOrbit web → Settings → KOReader). That login is not your BookOrbit web login.

1. Download `cp-orbit-<version>.zip` from the
   [latest release](https://github.com/ngocmanh1609/bookorbit-sync-crosspoint-plugin/releases/latest) and unzip it.
2. Copy the `cp-orbit` folder to `/plugins/` on the reader's SD card, giving `/plugins/cp-orbit/`. Keep that folder
   name: the reader only sends reading sessions to plugin folders named 23 bytes or less.
3. On the reader, turn on **Settings → Connectivity → Plugins**. Then turn the reader **off and on** (hold Power for
   about half a second, twice).

<details>
<summary>No card reader? Copy it over Wi-Fi instead</summary>

Open **File Transfer** on the reader and note its address (for example `192.168.1.123`). Then, inside the unzipped
folder:

```bash
curl -X POST -d "name=plugins&path=/" http://<reader-ip>/mkdir
```

```bash
curl -X POST -d "name=cp-orbit&path=/plugins" http://<reader-ip>/mkdir
```

```bash
for f in manifest.json device.json plugin.js README.md config.example.json; do curl -X POST -F "file=@cp-orbit/$f" "http://<reader-ip>/upload?path=/plugins/cp-orbit&overwrite=1"; echo; done
```

You can also do the same by hand in the reader's web page, on the **File Manager** tab.

</details>

> [!WARNING]
> If you also installed the older **BookOrbit Sync** plugin (`bookorbit-sync`), remove it. Otherwise both plugins
> send every reading session and BookOrbit counts your reading time twice.

## Set up

1. On the reader, open **File Transfer**. Then open the address it shows in a browser on the same Wi-Fi.
2. Go to the **Plugins** tab and find the **BookOrbit** card.
3. Enter the server address (for example `http://192.168.1.50:3000`) and your KOReader sync username and password.
   Press **Test connection**, then **Save**.

That's all. **Save** does two things:

- It stores your settings in `/.cp-orbit/config.json` on the SD card. Only the MD5 hash of the password is kept
  there; BookOrbit accepts it as the key.
- It points the reader's own progress sync at BookOrbit: server `<your server>/api/v1/koreader`, matching
  **Binary**, the conflict choice you picked, and CrossPoint's clipping sync **off**. BookOrbit doesn't support that
  clipping sync; highlights go through the card instead. If the reader already syncs with another server, the card
  asks before replacing it.

<p align="center">
  <img src="docs/images/web-card.png" alt="The full BookOrbit card on the reader's Plugins page" width="560">
</p>

## Using it

### Reading progress

CrossPoint syncs progress only when you ask, from inside a book:

- **Reader menu → Sync progress** (tap or swipe up to open the menu).
- Or, if your reader lists it, set **Settings → Controls → Short Power Button Click** to **Sync**, so syncing is one
  press.

When this reader and BookOrbit disagree, the reader shows both positions: chapter, page, percentage, and the device
that saved it. Choose **Apply remote progress** to jump to BookOrbit's place, or **Upload local progress** to keep
this one. If you'd rather not be asked, pick **Use the furthest automatically** on the card.

### Reading sessions

Nothing to do. Sessions are recorded as you read and sent whenever the reader connects to Wi-Fi or goes to sleep.
Sending one twice is harmless, because BookOrbit drops duplicates.

### Highlights

On the card, pick a book and press **Sync highlights**, or **Sync all recent books** to do every book in the reader's
recent list:

- New highlights on the reader go to BookOrbit, and open at the right spot in BookOrbit's web reader.
- New highlights from BookOrbit are added to the reader. One that can't be found in the book is reported, never
  placed by guessing.
- Deleting a highlight on either side deletes it on the other at the next sync.

The book must be the same file BookOrbit has; books downloaded through the catalog always are. Before every change,
the reader's highlight file is backed up to `/.cp-orbit/backup/`.

### Status, rating and shelves

- **Show status & rating** looks the book up and shows its current values. Change them, then press **Save status &
  rating**.
- **Update shelves** adds your collections and SmartScopes to the reader's catalog.

<details>
<summary>Every control on the card</summary>

| Control | What it does |
|---|---|
| Server | Your BookOrbit address. `http://` is added if you leave it out. |
| KOReader sync username / password | Your BookOrbit KOReader sync login. After saving, leave the password empty to keep it. |
| Download folder | Where catalog downloads go. Default `/Books/BookOrbit`. |
| Use BookOrbit for reading progress | When ticked, **Save** also sets up the reader's progress sync. |
| When positions differ | **Ask me**, or **Use the furthest automatically**. |
| **Test connection** | Checks the address and login. Saves nothing. |
| **Save** | Checks the login, saves the settings and, if ticked, sets up progress sync. Nothing is saved if the login fails. |
| **Update shelves** | Adds your collections and SmartScopes to the catalog. Press it again after you change them in BookOrbit. |
| Book | The book the buttons below work on: a recent book, or **Another book** to type a path. |
| **Sync highlights** | Two-way highlight sync for that book. |
| **Sync all recent books** | Sync highlights for every recent book, with a result line for each. |
| **Show status & rating** | Shows the book's current status and rating. Changes nothing. |
| **Save status & rating** | Sends the status and rating shown to BookOrbit. |

</details>

## Updating

1. Use **Sync progress**, or just connect the reader to Wi-Fi, so queued reading sessions go out first.
2. Copy the new `cp-orbit` folder over the old one ("Replace" is fine), then turn the reader off and on.

Your settings and sync state live in `/.cp-orbit/`, outside the plugin folder, so you never re-enter them.
Shelves come back the next time you open the card. Deleting `/.cp-orbit/` resets the plugin.

## Troubleshooting

| Problem | Fix |
|---|---|
| **"Sync failed. Could not sync clippings"** | The reader's clipping sync is on, and BookOrbit doesn't support it. Untick **Settings → Connectivity → CrossPoint Sync → Sync Clippings**, or press **Save** on the card again. |
| The Picco isn't in BookOrbit's **Devices** list | That list only shows devices that have uploaded a position. Use **Sync progress** and choose **Upload local progress**. The reader appears as **"CrossPoint"**, a name fixed in the firmware. |
| The catalog shows an error | Set up the card first, and check that the reader can reach the server address. |
| No reading sessions in BookOrbit | The folder must be `/plugins/cp-orbit`. Turn the reader off and on after installing, and make sure the reader shows the correct time. |
| A downloaded book won't open | That book's first file in BookOrbit isn't an EPUB (see [known issues](KNOWN_ISSUES.md)). |

## What CrossPoint can't do

CrossPoint plugins can't draw their own screens or run code on the reader. The KOReader plugin's dashboard, widgets,
covers, bulk download and bookmark sync therefore have no equivalent. Progress never syncs on its own; you start it
with Sync progress. All limits are listed in [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Security

- The SD card holds the MD5 hash of your KOReader sync password, which BookOrbit accepts as the key. Use a dedicated
  sync login, and `https` or a trusted network.
- The plain password is only handed to the reader's own (obfuscated) credential store. The plugin never writes it
  anywhere.

## Development

```bash
npm ci
npm test
```

```bash
sh scripts/package.sh
```

- `npm test` runs 34 tests against a mock BookOrbit and the firmware's rules. They cover the highlight-file format,
  position mapping, the two-way exchange, `device.json` templates, the Plugin Hub rules and the release zip.
- `sh scripts/package.sh` builds `dist/cp-orbit-<version>.zip`.
- To release, push a tag `v<version>` that matches `manifest.json`. GitHub Actions then tests the code, builds the
  zip and publishes the release.

This plugin was written from the CrossPoint firmware and BookOrbit server sources. It is not affiliated with either
project. MIT licensed.
