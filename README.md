# Music Stand

A personal sheet music reader for iPad. It runs in Safari, installs to the
Home Screen, and works offline. Turn pages by winking at the front camera.

PDFs, settings and reading positions are stored in the browser's local
database on the iPad, so the music works offline. If you connect Google Drive,
your scores are also kept in a "Music Stand" folder in your own Drive and stay
the same on all your devices. Camera frames are analysed on the device and
never recorded or sent anywhere. See [privacy.html](privacy.html).

## Features (Phase 1)

- **Library**: add PDFs from Files (or drag them in from Split View), search,
  sort, rename, delete. Adding the same PDF twice is detected.
- **Continuous vertical scrolling**: pages are drawn with PDF.js just ahead of
  where you are reading, so scrolling stays smooth even in long hymnals.
- **Page turns**: each turn scrolls a set share of the screen (default 80%)
  with an animation. A short orange **reading guide** line marks where the old
  edge of the screen moved to, so your eye can find its place again.
- **Ways to turn**: wink, tap (bottom third = forward, top third = back,
  middle = toolbar), arrow / Page Up / Page Down / Space keys, and Bluetooth
  page-turner pedals (which send those keys).
- **Wink control** (MediaPipe Face Landmarker):
  - One eye goes forward, the other goes back. Either can be the forward eye,
    and "back" can be turned off if you can only wink one eye.
  - Normal blinks are ignored: a wink only counts when one eye is closed while
    the other stays clearly open, held for the hold time (default 200 ms).
  - Holding a wink doesn't repeat; open both eyes before the next one.
  - Adjustable sensitivity and hold time. Each eye's resting level is learned
    automatically, which handles naturally uneven eyes and looking down at the music.
  - A ring in the bottom-left corner fills while you hold a wink, and an arrow
    flashes when a wink registers.
  - **Test & tune** panel in Settings with live meters per eye, plus
    **Calibrate eyes**, which checks whether the camera reports your left and
    right eyes the right way round and fixes it if not.
- Remembers your place and zoom in every score, and reopens the score you were
  reading if iPadOS closes the app in the background.
- Zoom (50 to 100% of the screen width, while scrolling), night mode (light
  notes on dark pages), and keep-screen-awake.
- **Backup**: Settings › Backup › Export creates one `.zip` with all PDFs and
  data (save it to Files or iCloud Drive). The zip is a normal archive; you can
  open it on a computer to get your PDFs back. Importing offers two choices:
  - **Merge** adds the scores this device doesn't have. A score that's already
    here (the same PDF, even if it was added separately on each device) isn't
    added twice; it keeps this device's copy and reading place. This device's
    settings are left alone.
  - **Replace** makes this device match the backup, settings included, except
    for this device's eye calibration (which depends on its camera).

## One page at a time or scrolling

Settings › Page turning › **Pages** chooses how the music is shown. The
button next to the pen in a score's top bar switches between the two (its
icon shows which one is on), and the score stays on the page you're reading.

- **Scroll** (the default) is the continuous strip described above: each turn
  moves part of the screen (Scroll amount), and you can scroll freely.
- **One at a time** shows each page whole, as large as fits the screen, and
  every turn (wink, tap, pedal or key) goes exactly one page. The page turns
  like a book's: it lifts at the right and turns over to the left, showing
  the next page beneath; going back, the previous page turns back over from
  the left. Turns that come while a page is turning (two quick winks) follow
  one after the other.
- Drag a page to the left and it turns under your finger. Let go past about
  a third of the way (or flick it) and it finishes turning; otherwise it
  falls back. Drag to the right for the page before. A swipe up or down also
  turns a page, and a mouse wheel or trackpad turns one page per push.
- Turn animation sets how long a page takes to turn; 0 switches pages
  instantly.
- In landscape, one at a time shows the page full height with the stage on
  either side. Zoom is for scrolling, so its buttons hide in this mode.
- With *Write with a finger* on, a two-finger swipe turns the page.

## Scroll bar

A scroll bar runs down the right edge of a score for getting around long
scores quickly. It appears with the top bar (tap the middle of the page) and
while you scroll by hand, and stays out of the way otherwise.

- Drag its handle: a label beside it shows the page you'll land on, and the
  music follows your finger. Tap anywhere on the track to jump there.
- With an index (below), a magnifier pops out beside your finger instead of
  the label: the hymns around where you'd land, in big type, the one you'd
  land on lit. To pick one exactly, slide your finger left onto the
  magnifier: it then goes one hymn per row, and the music follows. Hold the
  top or bottom row at the edge of the screen to bring in more. Slide back
  onto the bar for big moves again; let go to stay on the hymn.
- One page at a time, it moves whole pages, without the page-turn animation.
- It hides while the markings tools are open (so you can write near the
  right edge), and when the whole score fits on the screen.

## Index: hymns, sections and tap areas

The **list button** next to the page number in a score's top bar opens the
score's *Index*: where its hymns and sections start. It's made for hymnals,
including scanned ones.

- **Hymn here** adds the hymn that starts at the top of the screen (it
  suggests the number after the hymn before it). **Section here** adds a
  part of the book, such as Advent or Communion.
- **Add many** adds a whole run at once: for example hymns 1 to 600, the
  first on page 12, one every page (or every 2 pages). Hymns already in the
  index stay where they are; move any that land wrong with the pencil
  button beside them.
- **Paste titles** sets titles from a list with one hymn per line, number
  first or last, as a printed index has them (`245 Amazing Grace`,
  `Abide with Me .... 10`). Type the list, or copy one from a website.
- **Search** by hymn number (`245`, then Return goes straight there) or by
  any words of a title (`grace amazing`), ignoring case, accents and
  punctuation. Tap a row to go to it.
- The **scroll bar** shows the sections and hymn numbers; tap one to go
  there. When they don't all fit, it shows round numbers a step apart
  (every 10th, 20th, 50th...) so they're easy to steer by. Holding the bar
  pops out a magnifier of the hymns around your finger; slide onto it to
  pick any hymn exactly (see *Scroll bar* above).
- **Tap areas** make a scanned index page clickable. Go to the index page,
  tap *Tap areas*, and drag across a line (say *245 Amazing Grace*). Then
  type the hymn number it goes to (or a page). Tapping that line while
  reading then goes to the hymn, and a **Back** button shows for a few
  seconds to return to the index. Tap an area while drawing to change or
  delete it. ‹ › go through the pages while drawing.

The index is kept with the score's markings: it syncs through Google Drive
and goes into backups the same way.

### Reading scanned pages (text recognition)

In a scanned PDF the words are pictures, so Music Stand reads them with
text recognition (OCR), on the iPad itself:

- **Read the printed index**: *Paste titles* › *Read pages* (say pages 3
  to 6, where the book's index is) reads the index and puts the hymns it
  finds in the list, number and title. Check the list, fix what was misread
  (text recognition mixes up some letters and numbers), then *Set titles*.
  An index in two columns works too.
- **Search the words of the music**: *Read all pages* reads every page once
  (it can take a while for a whole hymnal: a few seconds a page; you can
  keep reading the music meanwhile, and it carries on where it stopped).
  Then searching finds the pages with those words, lyrics included, even
  when they're printed in syllables ("A - maz - ing"), under *Words on the
  pages*.
- The first use downloads text recognition (about 11 MB), so do it once
  while online; after that it works offline.
- With Google Drive sync on, what the pages say syncs too (in the notes and
  folders file), so a hymnal only has to be read on one device: the others
  can search it as soon as they've synced. It isn't in backups; reading the
  pages again puts it back.

## Links to a page or a piece

A link can open a score at a page, or at an entry of its Index, from another
app or web page (a lesson plan, a curriculum map):

| Link | Opens |
|---|---|
| `…/music-stand/#/open/<score>?page=<n>` | the score at page *n* of its PDF |
| `…/music-stand/#/open/<score>?piece=<number or title>` | the score at that Index entry, for example `?piece=2` or `?piece=Lightly%20Row` |
| `…/music-stand/#/open/<score>` | the score, where you left it |

For example
`https://janelleglass.github.io/music-stand/#/open/Suzuki%20Violin%20Book%201?piece=Lightly%20Row`.
The score's name and the piece are written as in a web address (a space is
`%20`).

- The score is found by its name in the library; capitals, accents and a
  `.pdf` at the end don't matter. If the name only matches part of one
  score's name, that score opens; if it matches several, Music Stand asks
  which.
- A number finds the Index entry with that number; words find the entry with
  that title (or the closest match). The music opens where the entry starts,
  as when you tap it in the Index. If the Index has no such entry, the score
  opens at the top and says so.
- **Copy link**: the link button in a score's top bar copies a link to the
  page showing, the Index entry you're in, or the score. In the Index, the
  link button on each row copies a link to that entry (by its title, or its
  number if two entries share the title). Paste these where you want them.
- If the score isn't in the library, Music Stand says so. With Google Drive
  sync connected, it first waits for the sync to bring the score in.

**On the iPad, a tapped link opens Music Stand in Safari, not in the Home
Screen app**, and iPadOS keeps Safari's data apart from the Home Screen
app's. Your scores reach Safari's copy through Google Drive sync: connect
Google Drive in Safari's copy of Music Stand too (Settings › Google Drive),
and give it time for its first sync. Markings and notes you make in either
copy then reach the other through Drive.

## Adjusting pages: crop, turn and straighten

The **crop button** in a score's top bar opens *Adjust pages* for the page
you're on. It shows the whole page with an orange frame round the part that
will show.

- Drag the frame's edges or corners to crop, or drag inside it to move it.
- **Turn left / Turn right** for a page scanned sideways or upside down.
- **Straighten** levels a crooked scan: drag the slider (−10° to +10°) and
  line the staff lines up with the blue guide lines that show while it
  moves. **Auto** finds the angle from the staff lines. Tap the angle to set
  it back to 0. The corners that turn off the page are cut off, and markings
  turn with the music.
- **Trim margins** finds the music on the page and crops to it, keeping a
  little paper round it. It ignores the edge of a scan and a dark scanner
  shadow along the edge, but check a page with faint marks (page numbers,
  tempo markings) near the edge, and widen the frame if it cut them.
- **Whole page** takes the crop away.
- **Shape** keeps the frame's proportions while you drag it and when you trim
  margins: *Free* (any shape), *Page* (the page's own shape, so the music
  just gets bigger), or *Screen* (the shape of the screen held the way it is
  now, so one page at a time the page fills it with no dark bands). The
  frame grows round the music to that shape. The choice is remembered on
  this device.
- ‹ › (or the arrow keys) go through the pages; each keeps what you did to it.
- **Apply to** *This page*, *All*, *Odd* or *Even* (by the page's number in
  the PDF) says which pages Done changes. After Trim margins, each of those
  pages is trimmed to its own music, and after Auto, each is straightened by
  its own amount; otherwise they all get this page's crop, turn and
  straightening. (Moving the slider after Auto uses that angle on them all.)
- **Done** saves; **Cancel** leaves the pages as they were.

A cropped page is laid out larger, as if its margins weren't there, in both
scrolling and one page at a time. The PDF itself isn't changed: the PDF in
the Google Drive folder, or taken out of a backup, still has its margins.
Adjustments are kept with the page's markings, so they sync through Google
Drive and go in backups the same way (restoring with *Replace* brings back
the backup's adjustments).

Markings stay on the music they were written on: turning a page turns its
markings with it, and marks in a margin that's cropped away are hidden, not
deleted (they show again with Whole page).

## Markings, favorites and folders (Phase 2)

- **Write on the music with the Apple Pencil** whenever a score is open:
  fingerings, dynamics, breath marks, cuts. Fingers still scroll and turn
  pages, and a quick Pencil tap works like a finger tap. While the Pencil is
  writing, and for a moment after, page turns (winks, pedals, taps) are
  ignored, so a mark never streaks across the page.
- The **pen button** in the score's top bar opens the markings tools in place
  of the page and zoom controls: pen (5 colours, 3 widths), highlighter
  (4 colours, blended into the paper), eraser (takes pen marks before the
  highlight under them), undo and redo, and Done. Tap the chosen pen or
  highlighter again for its colours.
- **Your own colours**: in the colours, the rainbow **+** opens a colour
  picker and a **hex code** field (like `1F5FD1`); the colour is used as
  soon as you pick or type it. **Save colour** adds it to the list for next
  time. **Remove…** lets you tap colours (built-in ones too) to take them off
  the list, and **Reset** brings back the built-in colours. The pen and the
  Text tool share one list; the highlighter has its own. Markings keep the
  colour they were drawn in. Saved colours are part of the settings, so
  backups carry them (Google Drive sync doesn't). The **⋯** menu has *Write with a finger*
  (one finger writes, two scroll; also for a mouse on a computer),
  *Hide markings* for a clean copy, and *Clear markings on page N*. The
  **Text** tool types notes (below).
- Markings are vector strokes on each page, so they keep their place at every
  zoom, and show light on dark pages in night mode.
- Settings › Markings › **Apple Pencil marks right away** can be turned off,
  so the Pencil only writes after tapping the pen button (and scrolls
  otherwise).
- **Favorites and folders** run along the bottom of the library: All,
  Favorites, your folders, and **+** for a new folder. Tap the star on a
  score (or in its top bar) to make it a favorite. A score can be in any
  number of folders. Inside a folder: *Add scores* (a list with search and
  checkboxes), *Rename*, *Delete folder* (the scores stay in the library),
  and the sort *Folder order* (the order scores were put in), so a service's
  pieces stay in their places. Add PDF while a folder is open adds to it.
- Deleting a score deletes its markings and takes it out of its folders.
  Backups include markings and folders. With Google Drive sync on, Drive
  keeps a deleted score's markings and folder places (by its PDF), so they
  come back if the same PDF is added again or restored from the Drive trash.

### Typed notes

- The **Text** tool (the **T** next to the eraser) types notes onto the
  music. Tap the page where the note goes and a box opens there with the
  keyboard; with the Apple Pencil you can also write in it by hand and let
  Scribble turn it into text. The bar above it has the pen colours, three
  text sizes, *Collapse*, *Delete* and *Done*. Tap the Text tool again to
  choose the colour and size of new notes.
- With the Text tool, tap a note to change it, or drag it to move it. While
  you type, the round handle at its corner moves it and the square one at
  its side sets its width. Undo and redo cover notes as they do strokes.
- Each note is either **shown** (its text on the music) or **collapsed** to
  a small note marker at that spot. When you're reading (the markings tools
  closed), tap a note or marker to collapse or open it; that tap doesn't
  turn the page, and winks and pedals turn pages as usual. Notes only change
  with the Text tool, so a note can't be edited by accident while playing.
- The **⋯** menu has *Collapse all typed notes* and *Show all typed notes*
  for the score, and *Hide markings* hides notes along with the ink.
- Notes stay on their music like strokes: at every zoom, in both ways of
  turning pages and in night mode. They turn with a turned page, and a note in
  a margin that is cropped away is hidden, not deleted.
- The Index search finds words in typed notes, under *Words on the pages*.
- Notes sync through Google Drive with the other markings and go into backups.
  If two devices change the same note, the later change wins.

### Using more than one device: Google Drive sync

Settings › Google Drive › **Connect Google Drive** signs in with Google and
keeps the library the same on every device connected to the same Google
account:

- Scores are stored as ordinary PDFs in a **Music Stand** folder in your
  Drive, named like the score. That folder is also a backup you can open on a
  computer.
- Adding, renaming and deleting scores travels to the other devices. Deleted
  scores go to the Google Drive trash, where Drive keeps them for 30 days.
- The same PDF added on two devices becomes one score. A new version of a PDF
  uploaded in Drive on the web (Manage versions) reaches every device.
- Sync runs when the app opens, when you come back to it, a moment after you
  change something, and when you tap the cloud button or **Sync now**. It never
  runs while a score is open, and big transfers carry on where they stopped.
- Google gives the app an hour of access at a time. When the app opens it
  fetches a new hour by going to Google and straight back (a brief flash).
  Otherwise the cloud button asks for a tap, which opens Google's sign-in
  window for a moment.
- If many scores disappear from Drive at once (for example the Music Stand
  folder went to the trash), nothing is deleted on the iPad until you choose,
  from the **Review** strip, to keep them or delete them.
- **Markings, typed notes, page adjustments, the index (and what Read all pages read), zoom, favorites and folders** sync too, in one small file in the
  Music Stand folder ("Music Stand notes and folders.json"; leave it as it
  is). A score is recognised by its PDF, so markings and folders come back if
  a deleted score is restored from the Drive trash. Strokes written on two
  devices at once are all kept; an erased stroke is erased everywhere; for
  folder names and contents the latest change wins.
- **Zoom** (the − / + in a score's top bar) syncs too: each score opens at
  the zoom you last chose for it on any device. Zoom is a share of the
  screen's width, so it looks the same on iPads of different sizes.
  Changes arrive the next time sync runs; tap the cloud button or **Sync
  now** to send or fetch them straight away (sync waits while a score is open).
- Reading positions and settings stay per device.
- The app can only see files it made itself, so add music with **Add PDF**:
  PDFs dropped into the folder from a computer don't show up.
- **Copy sync report** in Settings copies a log that helps when something
  doesn't sync.

Without Google Drive, copy your library to another device with a backup:
export it, save it to iCloud Drive, then import it on the other device with
**Merge**.

## Put it on GitHub Pages

1. Create a new repository on GitHub (it can be private if your plan allows
   private Pages; public works too, since your music is not in the repo).
2. Upload everything in this folder to the repository root, keeping the
   folder structure (`index.html` must be at the top level). With git:
   ```bash
   git init
   git add .
   git commit -m "Music Stand"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/music-stand.git
   git push -u origin main
   ```
3. On GitHub: **Settings › Pages › Build and deployment › Source: Deploy from
   a branch**, branch `main`, folder `/ (root)`. Save.
4. After a minute the site is live at `https://YOUR-NAME.github.io/music-stand/`.

## Install on the iPad

1. Open the GitHub Pages address in **Safari**.
2. Tap **Share › Add to Home Screen**.
3. Open Music Stand from the Home Screen **once while online** and leave it
   open for a minute. It downloads everything it needs for offline use,
   including about 15 MB for wink detection.
4. Add your PDFs with **Add PDF**.

Use the Home Screen app rather than a Safari tab: iPadOS keeps a Home Screen
app's data, but may clear website data that hasn't been used for a while.
Export a backup now and then anyway.

## Setting up wink control

1. Settings › Wink control › turn on **Turn pages by winking**, and allow the camera.
2. Tap **Start test**. Wink each eye and watch the meters. The bar for the eye
   you close should rise past the dashed line and flash green.
3. If the wrong bar rises, tap **Calibrate eyes** and follow the prompt.
4. Tune:
   - Normal blinks register as winks → raise **Hold time** or lower **Sensitivity**.
   - Winks are missed → raise **Sensitivity** or shorten **Hold time**.
5. Tips: face the iPad with your face evenly lit (a bright window behind you
   makes it harder). The camera only runs while a score is open. The eye
   button in the score's toolbar switches wink control on and off.

Camera rate: *Battery saver* (12 per second) is enough for most people and
helps on long services; *Responsive* (30 per second) reacts slightly faster.

## Google Cloud setup (for Drive sync)

The Client ID in `js/gdrive-auth.js` belongs to a Google Cloud project
(Google Auth Platform):

- **Clients**: a Web application client whose authorized JavaScript origins
  and redirect URIs include `https://janelleglass.github.io` and
  `https://janelleglass.github.io/music-stand/` (plus `http://localhost:8787`
  for local testing). Only the Client ID is used; there is no client secret.
- **Data access**: the only scope is `.../auth/drive.file` (files the app
  creates), which Google treats as non-sensitive.
- **Branding**: home page `https://janelleglass.github.io/music-stand/`,
  privacy policy `https://janelleglass.github.io/music-stand/privacy.html`.
- **Audience**: while the app is in *Testing*, Google ends each sign-in's
  approval after 7 days and only listed test users can sign in. Publish the app
  (*In production*) so sign-in renews on its own; with only `drive.file` this
  needs no Google review.

## Updating the app

When you change any app file, bump `VERSION` at the top of `sw.js` (for example
`1.0.0` → `1.0.1`) and push. The next time the library screen is opened online,
an **Update now** banner appears. It never reloads while you're reading.

If you replace anything in `vendor/`, also bump `LIB_CACHE` in `sw.js`.

## Notes and limits

- Needs iPadOS 16.4 or newer (for wink detection and keep-screen-awake).
  Reading PDFs works on older versions.
- Camera access requires HTTPS, so the camera won't work when testing on the
  iPad over plain `http://` on your home network. Use the GitHub Pages address.
- When installed to the Home Screen, iPadOS may ask for camera permission
  again after the app has been closed. That's an iPadOS rule.
- Password-protected PDFs can't be opened; remove the password first.
- If quick Pencil strokes go missing, turn off Settings › Apple Pencil ›
  Scribble on the iPad (it can take strokes meant for web pages). Typed notes
  then need the keyboard.

## Project layout

```
index.html, css/app.css      UI
js/app.js                    startup, routing (and links to a page or piece), wink → page turn, keys, wake lock
js/links.js                  links: reading them, finding the score and the piece, making them (unit tested)
js/viewer.js                 PDF viewer: scrolling or one page at a time (lazy rendering, animated turns, swipes)
js/paging.js                 one page at a time: page fitting, swipes, how far a page has turned (unit tested)
js/scrubber.js, js/scrub.js  the scroll bar down the right edge (its arithmetic is unit tested)
js/index-ui.js               the Index panel, and drawing tap areas on a printed index
js/marks.js                  the open score's index marks: saving, tap-area layers
js/index-logic.js            index rules: search, ordering, scroll bar labels, pasted lists, page words (unit tested)
js/ocr.js                    text recognition of scanned pages (Tesseract.js), and the text kept per page
js/page-view.js              page adjustments: crop, turn and straighten geometry, finding the music and the staff lines' angle (unit tested)
js/adjust-ui.js              the Adjust pages screen
js/views-store.js            saving page adjustments, with the page's markings
js/flip.js                   a page turning like a book's, drawn over the music
js/library.js                library screen, favorites and folders bar
js/lists.js                  favorites and folders (data)
js/ink.js, js/ink-draw.js    writing on the music: Pencil input, SVG layers, eraser
js/colors.js                 pen and highlighter colours: built-in, saved, the one in use (unit tested)
js/text-notes.js             typed notes: their layer on each page, the Text tool, shown or collapsed
js/notes-store.js            the open score's markings: undo, redo, saving
js/notes-ui.js               the markings tools in the top bar
js/notes-merge.js            rules for combining markings and folders from two devices (unit tested)
js/sync-data.js              Drive sync of markings and folders (unit tested with fakes)
js/settings-ui.js            settings sheet, wink tester, calibration, backup UI
js/wink-logic.js             wink detection state machine (no DOM, unit tested)
js/wink-camera.js            camera + MediaPipe → wink events
js/data.js, js/db.js         IndexedDB storage
js/backup.js, js/zip.js      backup export/import
js/merge.js                  rules for merging a backup into the library (unit tested)
js/gdrive-auth.js            Google sign-in (pop-up and redirect), no server
js/gdrive.js                 Google Drive REST calls
js/sync-plan.js              Drive sync rules (no DOM or network, unit tested)
js/sync-engine.js            carries out one sync through two adapters (unit tested with fakes)
js/sync-local.js, sync-remote.js  the adapters: IndexedDB library, Google Drive
js/sync.js, js/sync-ui.js    when sync runs, its sign-in, Settings section and cloud button
sw.js, manifest.webmanifest  offline + Home Screen install
vendor/                      PDF.js 4.10.38 (legacy build), MediaPipe tasks-vision 0.10.21, face model, Tesseract.js 6.0.1 (core 6.0.0, English data 4.0.0_best_int)
tests/                       node --test tests/*.test.mjs (fake Drive and devices for sync)
```

The viewer already takes a list of `{ file, page range }` pieces, so a
setlist (Phase 3) can scroll through several files as one continuous stand.

To run locally, serve the folder with any static web server, for example
`npx http-server -p 8080`, and open `http://localhost:8080`. The service worker
caches files, so after editing, bump `VERSION` or clear site data in the browser's dev tools.

## Third-party code

- [PDF.js](https://github.com/mozilla/pdf.js), Apache License 2.0 (`vendor/pdfjs/LICENSE`)
- [Tesseract.js](https://github.com/naptha/tesseract.js) and tesseract.js-core,
  Apache License 2.0 (`vendor/tesseract/LICENSE`, `vendor/tesseract/LICENSE-core`),
  with the English model from [tessdata](https://github.com/tesseract-ocr/tessdata_best), Apache License 2.0
- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) and the
  Face Landmarker model, Apache License 2.0
