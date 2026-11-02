# Shock Tech Visitors: Android app

The kiosk from `web/` packaged as an Android app (APK) for a lobby tablet. It runs full screen, keeps the screen on, keeps the tablet locked to the app, and reports every sign-in to the Google Sheet with nothing to set up on the tablet.

## What you need

- **An Android tablet** running Android 7.0 or newer, ideally with a front camera.
  - Open the Play Store and update **Android System WebView** (or **Google Chrome**). The app runs inside it, and old versions are slow or missing features.
- **A USB NFC reader that acts as a keyboard.** Most generic Amazon readers do: they type the card number and press Enter.
  - Plug it in with a USB-C or micro-USB OTG adapter if the tablet has no full-size port.
  - Test it first: open any app with a text box and tap a card. If a number appears, it will work.
- **NFC cards or key fobs** for the visitor badges.

## 1. Get the APK

**Option A: from GitHub** (recommended once the Google Sheet is set up)

1. In the repository on GitHub, go to **Settings → Secrets and variables → Actions** and add:
   - `KIOSK_API_URL`: the Apps Script web app URL ending in `/exec` (see the main README).
   - `KIOSK_KEY`: the `KIOSK_KEY` script property.
2. Go to **Actions → Build Android app → Run workflow**.
3. When the run finishes, download **shocktech-visitor-kiosk** from its page. The download is a zip containing the APK.

**Option B: build it on a computer** that has Node 22, Java 21 and the Android SDK:

```bash
npm ci
KIOSK_API_URL="https://script.google.com/macros/s/…/exec" KIOSK_KEY="…" npm run android:build
# → dist/shocktech-visitor-kiosk.apk
```

Without `KIOSK_API_URL` and `KIOSK_KEY`, the app runs in **demo mode**: nothing is saved to Google, and the admin PIN is `123456`. That's handy for trying it out.

## 2. Install it on the tablet

1. Copy the APK to the tablet (USB cable, Google Drive, or email) and open it.
2. Android asks to allow installs from that source. Allow it, then tap **Install**.
3. Open **Shock Tech Visitors**. When asked, allow the **camera**.
4. Android asks whether to **pin** the app. Tap **Got it / Start**. This keeps visitors inside the kiosk.

### Make it start by itself

So the kiosk comes back after a power cut or reboot:

1. Press the tablet's **Home** button.
2. Android asks which app to use as Home. Choose **Shock Tech Visitors** → **Always**.

To undo this later: **Settings → Apps → Default apps → Home app**.

### Tablet settings worth changing

- **Display → Screen timeout:** the longest available. The app also keeps the screen on while it's open.
- **Battery:** keep the tablet plugged in. On Samsung, turn on **Protect battery** (85% limit) if available.
- **Sound:** turn notification sounds off.

## 3. Badges

1. Hold the Shock Tech logo on the welcome screen for 2.5 seconds and enter the admin PIN.
2. Go to **Badges → Add badge by tapping it**, then tap each card on the reader. They're numbered V1, V2, … in order.

## Admin: getting out of the kiosk

In the admin screen, **Unlock tablet** (tap twice) releases the pin for 5 minutes so you can reach Android settings. The kiosk locks itself again the next time it's opened.

The welcome screen's **Exit admin** button only leaves the admin screen. It doesn't unlock the tablet.

## Optional: fully locked kiosk (device owner)

App pinning can be undone by someone who knows the button combination. For a tablet visitors can't leave at all, make the app the tablet's **device owner**. Android then locks it silently: no pin prompt, and the home and recent-apps buttons are disabled.

This needs a computer with `adb`, and **a freshly reset tablet with no Google account added yet**:

```bash
adb install dist/shocktech-visitor-kiosk.apk
adb shell dpm set-device-owner com.shocktech.visitorkiosk/.KioskAdminReceiver
```

To undo it, factory-reset the tablet.

## Updates

- Every build is signed. Android only installs a new version **over** the old one if both were signed with the same key.
- Builds without a release key use a throwaway debug key. To install a newer debug build, uninstall the old app first. Nothing important is lost, because visits live in the Google Sheet.
- To sign every build with one permanent key, create a keystore once and add it to the GitHub secrets:

  ```bash
  keytool -genkeypair -v -keystore shocktech-kiosk.jks -alias kiosk -keyalg RSA -keysize 2048 -validity 10000
  base64 -w0 shocktech-kiosk.jks   # → KIOSK_KEYSTORE_BASE64
  ```

  Also set `KIOSK_KEYSTORE_PASSWORD`, `KIOSK_KEY_ALIAS` (`kiosk`) and `KIOSK_KEY_PASSWORD`.
- Keep the `.jks` file somewhere safe. If it's lost, future updates need an uninstall first.

## Troubleshooting

| Problem | Fix |
|---|---|
| Badge taps do nothing | Tap anywhere on the kiosk screen once, so it has keyboard focus. Check that the reader types numbers in another app. |
| A small "Offline · reconnecting…" label | The tablet can't reach Google. Sign-ins need the connection. New face photos wait on the tablet and are sent automatically once it's back. |
| Animations stutter | The app turns off blur effects automatically on slower tablets. Updating Android System WebView also helps. |
| The camera bubble says "Camera off" | Allow the camera: **Settings → Apps → Shock Tech Visitors → Permissions → Camera**. |
| Everything looks small | The app scales itself to fit the screen. A tablet with a larger screen shows it bigger. |
