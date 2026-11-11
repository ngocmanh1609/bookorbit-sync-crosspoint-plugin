BookOrbit for CrossPoint (cp-orbit)

Your self-hosted BookOrbit library on this reader.
Verified on the BOOX Picco (CrossPoint 2.0.0). Other readers are untested.

WHAT IT DOES
- Catalog: Home > Plugins > BookOrbit lists Continue reading, Recently added,
  Not started, Finished, All books, then your libraries, collections and
  SmartScopes (empty ones hidden; they update when you open the web card).
  Open a list and use Search at the top to find a title or author. Pick a
  book to download it to /Books/BookOrbit.
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
3. Leave File Transfer. No restart is needed.

SYNC READING PROGRESS
Inside a book: reader menu > Sync progress. If your reader lists it, you
can also set Settings > Controls > Short power button to Sync. When the positions
differ the reader asks: Apply remote progress (jump to BookOrbit's place)
or Upload local progress (keep this reader's place). The reader never
syncs progress on its own.

HIGHLIGHTS
The reader never syncs highlights by itself. To sync them:
1. In a book, select text and choose Clip. That is the highlight.
   (Bookmark only marks the page and is not synced. There are no notes.)
2. Open File Transfer, open its address on a phone or computer, then the
   Plugins tab.
3. In the BookOrbit card pick the book and press Sync highlights, or Sync
   all recent books for every book in the recent list.
New highlights and deletions go both ways, so BookOrbit's highlights
arrive here the same way. If some could not be synced, Show which lists
each one and why (for example, it spans two chapters).

IF SYNC SAYS "COULD NOT SYNC CLIPPINGS"
Untick Settings > Connectivity > CrossPoint Sync > Sync Clippings, or press
Save on the web card again. BookOrbit does not support that clipping sync.

UPDATING
On the reader: Home > Plugins > Plugin Hub > BookOrbit > Update. (No
Plugin Hub yet? Home > Plugins > Plugin Hub > Install.) The web card
shows a banner when an update is ready. Or copy the new cp-orbit folder
over the old one after using Sync progress. No restart is needed. Your
settings are kept in /.cp-orbit on the SD card.

PROBLEMS
The web card keeps a problem log. Under Updates and problems, press
Download log, then Report a problem, and attach the file to the GitHub
issue that opens. The log leaves out your password, key, username and
server address.

Help and known issues:
github.com/ngocmanh1609/bookorbit-sync-crosspoint-plugin
