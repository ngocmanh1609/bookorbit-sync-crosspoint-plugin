# Known issues and limitations

## How well it is tested

- **Verified on a BOOX Picco** running CrossPoint 2.0.0, with a self-hosted BookOrbit server.
- **Other CrossPoint readers are untested.** Readers without a clock chip, such as the original Xteink X4, cannot
  record reading sessions. ESP32-C3 readers keep at most 256 highlights per book. Please report what you see.
- **Automated tests:** a mock BookOrbit built from the server's DTOs and exchange rules, the firmware's file formats
  as read from its source, and the firmware's template rules.

## Things a CrossPoint plugin cannot do

- **No custom screens on the reader.** The firmware draws plugin catalogs as plain lists. The KOReader plugin's
  dashboard, widgets, reading buddies, covers, mosaic view, "on device" badges and book detail pages cannot be
  rebuilt. Bulk download is not offered either: the reader downloads one book at a time.
- **No automatic progress pull.** Progress syncs when you use **Sync progress**. CrossPoint runs nothing when a book
  opens, and a plugin cannot move the reading position.
- **The reader never syncs highlights by itself.** They sync when you press **Sync highlights** on the web card.
  Plugin events cannot read files. BookOrbit also does not implement CrossPoint's own clipping-sync endpoint
  (`/api/v1/clippings`), which is why the card turns that sync off.
- **No restart from a plugin.** The reader's web server has no restart route. None is needed after an update on
  2.0.0.
- **Bookmarks** are not synced. The reader's bookmarks have no exchange format in this version.
- **One level of catalog lists.** The firmware's plugin catalog has one list picker, and choosing a book can only
  download it or show its details. "Collections → a collection → its books" can't be built, so collections and
  SmartScopes are listed flat, with a prefix. CrossPoint's built-in OPDS browser with a BookOrbit OPDS user can
  browse them as folders.

## Catalog

- **EPUB only.** The reader opens EPUB, TXT, Markdown and XTC files, and the download name always ends in `.epub`.
- **Books with several formats** download the book's first file. If that is not the EPUB, the file will not open.
  Books with one EPUB, the usual case, are fine.
- **Server under a sub-path** (for example `https://example.com/bookorbit`): downloads may fail. BookOrbit answers
  with `/api/v1/...` paths, which the reader joins to the host only.
- **Libraries, collections and SmartScopes** are written into `device.json` by the web card, which only runs while
  its page is open. A change on the server shows on the reader after the next visit to the card.
  - An update resets the lists to libraries-only until that visit.
  - Their number is capped so `device.json` stays under the reader's 8KB limit.
  - SmartScopes beyond the server's preview limit report no book count, so empty ones of those can't be hidden.
- **Search** sits at the top of an open list, not on the list picker. That is where the firmware puts it.
- **Without a saved config** the catalog shows an error. Set up the web card first.

## Reading sessions

- They need a trusted clock, which the Picco's clock chip provides. A reader that lost its time needs one Wi-Fi
  connection first.
- The reader's queue holds about 4KB per plugin, roughly a dozen sessions. Connect now and then.
- After an install or update, the reader picks up the plugin's events when File Transfer ends, when Home → Plugins
  opens, or after a Plugin Hub install. No restart is needed.
- If you replace the plugin folder by hand while sessions are still queued, they are lost. Use Sync progress
  before updating. A Plugin Hub update keeps them.
- Each session is sent as two points on a 10,000-step scale, so BookOrbit statistics that count raw pages may show
  that scale.

## Highlights

- **Same file required.** BookOrbit matches books by content hash. A copy whose metadata was changed in BookOrbit no
  longer matches; download it again.
- **Positions are rebuilt from the book.** The reader stores highlights as character offsets. The card converts them
  to KOReader positions by reading the EPUB, and back again. BookOrbit re-checks every position against the
  highlighted text.
  - A highlight whose text cannot be found is skipped. **Show which** on the card lists it with the reason.
  - A highlight that runs into the next chapter can't be placed, because the reader keeps each highlight inside one
    chapter.
  - Paragraph breaks are ignored when matching text, because KOReader stores them as a line break and many books
    have no space between paragraphs.
  - Very large chapter text nodes (over 8,192 characters) are not split the way KOReader splits them, so positions
    inside them may be repaired by BookOrbit rather than exact.
- **Limits.**
  - The reader keeps up to 1,024 highlights per book on the Picco, and 256 on ESP32-C3 readers.
  - The card can write a highlight file of up to 256KB.
  - A highlight text is stored up to 4KB on the reader.
- **Edits.** CrossPoint highlights have no notes or colours, so edits made in BookOrbit only update the highlighted
  text and position.
- **Times.** Highlight times use your browser's time zone, which should match the time zone set in BookOrbit.

## Updates and the problem log

- **The update banner follows Plugin Hub.** The card reads the Hub's catalog, so a new release shows up there (and
  in Plugin Hub on the reader) only after the Hub refreshes, a few times a day. The check needs internet access;
  without it (for example in the reader's hotspot mode) the card stays quiet.
- **The log only covers the web card.** Errors in the reader's own catalog, downloads and progress sync go to the
  firmware's serial port, which a plugin can't read. The report does show how many reading sessions are waiting to be
  sent, which is the visible sign that sending them fails.
- **What the log contains.** It leaves out the password, key, username, server address and device ID. It does
  contain book file paths and the start of highlights that couldn't be synced.

## Credentials

`/.cp-orbit/config.json` holds the MD5 of the KOReader sync password. BookOrbit accepts it as the key. Plugins
cannot use the firmware's protected credential storage, so use a dedicated sync login.

## Relying on BookOrbit's KOReader API

This plugin uses the same endpoints as BookOrbit's KOReader plugin. They are not a versioned public API and could
change.
