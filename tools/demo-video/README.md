# Demo video kit

Records the captioned product video in `media/visitor-sign-in-demo.mp4`. A
scripted browser plays a visitor's whole journey on the kiosk (in demo mode)
inside a tablet frame, with captions, title cards, an NFC reader graphic and a
spreadsheet view.

- **No real face appears.** An illustration stands in for the camera, and
  `face-demo.js` replaces the face recognizer so the returning visitor is
  "recognized".
- **The people and companies are made up:** Jordan Rivera, Northwind
  Aerospace, Priya Nair, Marcus Webb, Lisa Chen and Tom Alvarez.

## Which version it records

The video shows the kiosk as it was built for Shock Tech, before the setup
wizard and screening questions. The script drives that version's exact screens
and demo data, so record it from that commit:

```bash
git worktree add ../kiosk-video 211c88d && cd ../kiosk-video
```

## Run it

Needs Node with Playwright and Chromium, Python 3, and ffmpeg.

```bash
# from the repository root
python3 -m http.server 8766 &
node tools/demo-video/record.js     # about 6 minutes; records in slow motion for smooth output
python3 tools/demo-video/encode.py  # → tools/demo-video/visitor-sign-in-demo.mp4
```

Edit the captions and timing in `record.js`, and the look of the tablet frame,
captions and title cards in `stage.html`.
