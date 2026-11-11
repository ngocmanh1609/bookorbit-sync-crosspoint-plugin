BookOrbit for CrossPoint (cp-orbit)

Your self-hosted BookOrbit library on this reader.
Verified on the BOOX Picco (CrossPoint 2.0.0). Other readers are untested.

WHAT IT DOES
- Catalog: Home > Plugins > BookOrbit lists Continue reading, Recently added,
  Not started, Finished, All books and your BookOrbit libraries. Open a list
  and use Search at the top to find a title or author. Pick a book to
  download it to /Books/BookOrbit.
- Reading sessions: every reading session is sent to BookOrbit by itself
  (reading log, streaks, stats), when the reader goes online or to sleep.
- Reading progress: uses the reader's own KOReader sync, which this plugin
  sets up for you.
- Highlights, status and rating: from the plugin's card on the reader's
  web page.

SET UP (once)
1. On a phone or computer on the same Wi-Fi, open the address the reader
   shows under File Transfer, then the Plugins tab.
2. In the BookOrbit card enter your server address and your BookOrbit
   KOReader sync login (BookOrbit web: Settings > KOReader), then Save.
   Save also sets the reader's progress sync to BookOrbit.
3. Restart the reader once so reading sessions start being sent.

SYNC READING PROGRESS
Inside a book: reader menu > Sync progress. If your reader lists it, you
can also set Settings > Controls > Short power button to Sync. When the positions
differ the reader asks: Apply remote progress (jump to BookOrbit's place)
or Upload local progress (keep this reader's place). The reader never
syncs progress on its own.

HIGHLIGHTS
In the web card pick a book and press Sync highlights. New highlights go
both ways, and deletions too. Sync all recent books does every book in
the reader's recent list.

IF SYNC SAYS "COULD NOT SYNC CLIPPINGS"
Untick Settings > Connectivity > CrossPoint Sync > Sync Clippings, or press
Save on the web card again. BookOrbit does not support that clipping sync.

UPDATING
Use Sync progress first, then copy the new cp-orbit folder over the old
one and restart. Your settings are kept in /.cp-orbit on the SD card.

Help and known issues:
github.com/ngocmanh1609/bookorbit-sync-crosspoint-plugin
