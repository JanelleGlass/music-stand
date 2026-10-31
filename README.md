# Music Stand

A personal sheet music reader for iPad. It runs in Safari, installs to the
Home Screen, and works offline. Turn pages by winking at the front camera.

Everything stays on the iPad: PDFs, settings and reading positions are stored
in the browser's local database, and camera frames are analysed on the device
and never recorded or sent anywhere.

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
- Zoom (50 to 100% of the screen width), night mode (light notes on dark pages),
  and keep-screen-awake.
- **Backup**: Settings › Backup › Export creates one `.zip` with all PDFs and
  data (save it to Files or iCloud Drive). The zip is a normal archive; you can
  open it on a computer to get your PDFs back. Importing offers two choices:
  - **Merge** adds the scores this device doesn't have. A score that's already
    here (the same PDF, even if it was added separately on each device) isn't
    added twice; it keeps this device's copy and reading place. This device's
    settings are left alone.
  - **Replace** makes this device match the backup, settings included, except
    for this device's eye calibration (which depends on its camera).

### Using more than one device

Each device keeps its own library; nothing is stored on the website. To copy
your library to another iPad (or a computer), export a backup, save it to
iCloud Drive, then on the other device open Music Stand and import it with
**Merge**. Repeat whenever you've added music on one device that you want on
the other.

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

## Project layout

```
index.html, css/app.css      UI
js/app.js                    startup, routing, wink → page turn, keys, wake lock
js/viewer.js                 continuous PDF viewer (lazy rendering, animated turns)
js/library.js                library screen
js/settings-ui.js            settings sheet, wink tester, calibration, backup UI
js/wink-logic.js             wink detection state machine (no DOM, unit tested)
js/wink-camera.js            camera + MediaPipe → wink events
js/data.js, js/db.js         IndexedDB storage
js/backup.js, js/zip.js      backup export/import
js/merge.js                  rules for merging a backup into the library (unit tested)
sw.js, manifest.webmanifest  offline + Home Screen install
vendor/                      PDF.js 4.10.38 (legacy build), MediaPipe tasks-vision 0.10.21, face model
tests/                       node --test tests/wink-logic.test.mjs tests/merge.test.mjs
```

The storage already has places for Phase 2 (annotations per page) and Phase 3
(lists), and the viewer already takes a list of `{ file, page range }` pieces,
so a setlist can scroll through several files as one continuous stand.

To run locally, serve the folder with any static web server, for example
`npx http-server -p 8080`, and open `http://localhost:8080`. The service worker
caches files, so after editing, bump `VERSION` or clear site data in the browser's dev tools.

## Third-party code

- [PDF.js](https://github.com/mozilla/pdf.js), Apache License 2.0 (`vendor/pdfjs/LICENSE`)
- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) and the
  Face Landmarker model, Apache License 2.0
