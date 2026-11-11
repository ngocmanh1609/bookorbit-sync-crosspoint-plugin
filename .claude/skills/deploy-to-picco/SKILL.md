---
name: deploy-to-picco
description: Install or update the cp-orbit plugin on the user's CrossPoint reader (BOOX Picco) straight from this checkout, over Wi-Fi or by SD card, then say what the user does next (leave File Transfer, reload the page; no restart on 2.0.0) and how to check it works. Use this whenever the user wants to try a change on the device, deploy, upload or copy the plugin to the reader, test on the Picco, reinstall, or asks why a change doesn't show up on the reader, even if they don't say "deploy".
---

# Deploy cp-orbit to the reader

The reader runs CrossPoint 2.0.0; the target is a BOOX Picco. The plugin lives in `/plugins/cp-orbit/` on its SD card.
The folder **must** be named `cp-orbit`: the firmware only delivers events, and so reading sessions, to folders of 23
bytes or less. Never copy `cp-orbit.crosspoint-plugin/` under its own name.

Only the files listed in `manifest.json` `files` belong on the card. User settings live in `/.cp-orbit/`, so a deploy
never touches them.

## Over Wi-Fi (usual)

1. Ask the user to open **File Transfer** on the reader and tell you the address it shows. The reader's web server
   only runs while that screen is open.
2. Deploy:

```bash
sh .claude/skills/deploy-to-picco/scripts/deploy.sh <reader-ip>
```

   The script creates `/plugins/cp-orbit`, uploads every declared file with `overwrite=1`, then reads `/api/plugins`
   back to confirm the reader sees `cp-orbit`. To push only some files, pass their names after the IP. With
   `DRY_RUN=1` it prints the requests instead of sending them. It only writes inside `/plugins/cp-orbit/`.

## By SD card (no Wi-Fi)

```bash
mkdir -p /Volumes/<CARD>/plugins/cp-orbit && cp cp-orbit.crosspoint-plugin/{manifest.json,device.json,plugin.js,README.md,config.example.json} /Volumes/<CARD>/plugins/cp-orbit/
```

Optionally remove the macOS `._*` files afterwards with `dot_clean`.

## What the user must do next

No restart, on CrossPoint 2.0.0. In the firmware source:
- Event delivery re-reads `device.json` every time (`PluginEvents.cpp`).
- The event table is rebuilt when File Transfer ends (`CrossPointWebServerActivity.cpp`), when Home → Plugins opens,
  and after a Plugin Hub install (`PluginCatalogActivity.cpp`).
- The catalog re-reads the file when it opens.

| Changed | Then |
|---|---|
| `plugin.js` only (web card) | Reload the reader's **Plugins** web page. |
| `device.json` (catalog, download, events) | Leave **File Transfer** on the reader. |
| First install | **Settings → Connectivity → Plugins** on, open Home → Plugins once, then on the web card enter the server and login and press **Save**. |

Turning the reader off and on (hold Power about half a second, then again) is the fallback if something doesn't show
up.

If the user also has the older `bookorbit-sync` plugin, they should remove it. Otherwise reading time is counted twice.

## Checking it works

- **Catalog:** Home → Plugins → BookOrbit shows the lists, and downloads land in `/Books/BookOrbit` with a
  `.meta.json`.
- **Progress:** in a book, reader menu → Sync progress shows "Progress found!" with Apply/Upload when the positions
  differ. "Could not sync clippings" means the reader's clipping sync is on: Save on the card turns it off, or untick
  Settings → Connectivity → CrossPoint Sync → Sync Clippings.
- **Sessions:** read for a minute or more, then sleep. Expect the "BookOrbit: reading session sent" message.
- **Screenshots:** **Power + Down** saves a BMP in `/screenshots/`. Fetch it with
  `curl -o shot.bmp "http://<reader-ip>/download?path=/screenshots/<file>.bmp"`. List the folder with
  `curl "http://<reader-ip>/api/files?path=/screenshots"`. The `readme-media` skill can frame these screenshots.

## Notes

- **No remote restart:** the reader has no restart endpoint (none of the web routes in `CrossPointWebServer.cpp`), and
  none is needed after a deploy.
- **Reads are fine, writes are not:** listing and reading are harmless (`/api/status`, `/api/plugins`,
  `/api/files`, `/download`). Never write outside `/plugins/cp-orbit/` or delete anything without asking.
- **The BookOrbit Devices list** only shows the reader after its first progress *upload*. It appears there as
  "CrossPoint", a name fixed in the firmware.
