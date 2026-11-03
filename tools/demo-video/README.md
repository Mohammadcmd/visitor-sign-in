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
