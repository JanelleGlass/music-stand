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
- One page at a time, it moves whole pages, without the page-turn animation.
- It hides while the markings tools are open (so you can write near the
  right edge), and when the whole score fits on the screen.

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
  highlighter again for its colours. The **⋯** menu has *Write with a finger*
  (one finger writes, two scroll; also for a mouse on a computer),
  *Hide markings* for a clean copy, and *Clear markings on page N*.
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
- **Markings, page adjustments, zoom, favorites and folders** sync too, in one small file in the
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
  Scribble on the iPad (it can take strokes meant for web pages).

## Project layout

```
index.html, css/app.css      UI
js/app.js                    startup, routing, wink → page turn, keys, wake lock
js/viewer.js                 PDF viewer: scrolling or one page at a time (lazy rendering, animated turns, swipes)
js/paging.js                 one page at a time: page fitting, swipes, how far a page has turned (unit tested)
js/scrubber.js, js/scrub.js  the scroll bar down the right edge (its arithmetic is unit tested)
js/page-view.js              page adjustments: crop, turn and straighten geometry, finding the music and the staff lines' angle (unit tested)
js/adjust-ui.js              the Adjust pages screen
js/views-store.js            saving page adjustments, with the page's markings
js/flip.js                   a page turning like a book's, drawn over the music
js/library.js                library screen, favorites and folders bar
js/lists.js                  favorites and folders (data)
js/ink.js, js/ink-draw.js    writing on the music: Pencil input, SVG layers, eraser
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
vendor/                      PDF.js 4.10.38 (legacy build), MediaPipe tasks-vision 0.10.21, face model
tests/                       node --test tests/*.test.mjs (fake Drive and devices for sync)
```

The viewer already takes a list of `{ file, page range }` pieces, so a
setlist (Phase 3) can scroll through several files as one continuous stand.

To run locally, serve the folder with any static web server, for example
`npx http-server -p 8080`, and open `http://localhost:8080`. The service worker
caches files, so after editing, bump `VERSION` or clear site data in the browser's dev tools.

## Third-party code

- [PDF.js](https://github.com/mozilla/pdf.js), Apache License 2.0 (`vendor/pdfjs/LICENSE`)
- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) and the
  Face Landmarker model, Apache License 2.0
