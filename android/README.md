# Visitor Sign-In: Android app

The kiosk from `web/` packaged as an Android app (APK) for a lobby tablet. It runs full screen, keeps the screen on and keeps the tablet locked to the app. On first start it opens the setup wizard (see the main README). Optionally, the Google Sheets connection can be built into the app, so a tablet needs no connecting at all.

## What you need

- **An Android tablet** running Android 7.0 or newer, ideally with a front camera.
  - Open the Play Store and update **Android System WebView** (or **Google Chrome**). The app runs inside it, and old versions are slow or missing features.
- **A USB NFC reader that acts as a keyboard.** Most generic Amazon readers do: they type the card number and press Enter.
  - Plug it in with a USB-C or micro-USB OTG adapter if the tablet has no full-size port.
  - Test it first: open any app with a text box and tap a card. If a number appears, it will work.
- **NFC cards or key fobs** for the visitor badges.

## 1. Get the APK

**Option A: from GitHub**

1. Go to **Actions → Build Android app → Run workflow** (it also runs on every push that changes the app).
2. When the run finishes, download **visitor-sign-in** from its page. The download is a zip containing the APK.

Optional repository secrets (**Settings → Secrets and variables → Actions**):
- `KIOSK_API_URL` and `KIOSK_KEY`: build the Google Sheets connection into the app: the web app URL ending in `/exec`, and the `KIOSK_KEY` script property (Admin → Settings → Connect another tablet shows both in its link). Every tablet with this APK then connects to that sheet on its own.
- `KIOSK_APP_ID`: the Android app id (default `com.visitorsignin.kiosk`). Set it to the id of an app that's already on your tablets, so they take the new version as an update.
- The signing secrets under **Updates** below.

**Option B: build it on a computer** that has Node 22, Java 21 and the Android SDK:

```bash
npm ci
npm run android:build
# or, with the connection built in:
KIOSK_API_URL="https://script.google.com/macros/s/…/exec" KIOSK_KEY="…" npm run android:build
# → dist/visitor-sign-in.apk
```

Without `KIOSK_API_URL` and `KIOSK_KEY`, the setup wizard lets you choose: records on the tablet, or connect a Google Sheet.

## 2. Install it on the tablet

1. Copy the APK to the tablet (USB cable, Google Drive, or email) and open it.
2. Android asks to allow installs from that source. Allow it, then tap **Install**.
3. Open **Visitor Sign-In**. When asked, allow the **camera**. The setup wizard opens.
4. Android asks whether to **pin** the app. Tap **Got it / Start**. This keeps visitors inside the kiosk.

### Make it start by itself

So the kiosk comes back after a power cut or reboot:

1. Press the tablet's **Home** button.
2. Android asks which app to use as Home. Choose **Visitor Sign-In** → **Always**.

To undo this later: **Settings → Apps → Default apps → Home app**.

### Tablet settings worth changing

- **Display → Screen timeout:** the longest available. The app also keeps the screen on while it's open.
- **Battery:** keep the tablet plugged in. On Samsung, turn on **Protect battery** (85% limit) if available.
- **Sound:** turn notification sounds off.

## 3. Badges

The setup wizard registers badges as you tap them. To add more later: hold the logo on the welcome screen for 2.5 seconds, enter the admin PIN, go to **Badges → Add badge**, then tap each card on the reader. They're numbered V1, V2, … in order.

## Admin: getting out of the kiosk

In the admin screen, **Unlock tablet** (tap twice) releases the pin for 5 minutes so you can reach Android settings. The kiosk locks itself again the next time it's opened.

The welcome screen's **Exit admin** button only leaves the admin screen. It doesn't unlock the tablet.

## Optional: fully locked kiosk (device owner)

App pinning can be undone by someone who knows the button combination. For a tablet visitors can't leave at all, make the app the tablet's **device owner**. Android then locks it silently: no pin prompt, and the home and recent-apps buttons are disabled.

This needs a computer with `adb`, and **a freshly reset tablet with no Google account added yet**:

```bash
adb install dist/visitor-sign-in.apk
adb shell dpm set-device-owner com.visitorsignin.kiosk/com.visitorsignin.kiosk.KioskAdminReceiver
```

To undo it, factory-reset the tablet.

## Updates

- Every build is signed. Android only installs a new version **over** the old one if both were signed with the same key.
- Builds without a release key use a throwaway debug key. To install a newer debug build, uninstall the old app first. With Google Sheets nothing important is lost, because visits live in the sheet. With records on the tablet, uninstalling erases them, so use a release key (below).
- To sign every build with one permanent key, create a keystore once and add it to the GitHub secrets:

  ```bash
  keytool -genkeypair -v -keystore visitor-kiosk.jks -alias kiosk -keyalg RSA -keysize 2048 -validity 10000
  base64 -w0 visitor-kiosk.jks   # → KIOSK_KEYSTORE_BASE64
  ```

  Also set `KIOSK_KEYSTORE_PASSWORD`, `KIOSK_KEY_ALIAS` (`kiosk`) and `KIOSK_KEY_PASSWORD`.
- Keep the `.jks` file somewhere safe. If it's lost, future updates need an uninstall first.

## Troubleshooting

| Problem | Fix |
|---|---|
| Badge taps do nothing | Tap anywhere on the kiosk screen once, so it has keyboard focus. Check that the reader types numbers in another app. |
| A small "Offline · reconnecting…" label | The tablet can't reach Google. Sign-ins need the connection. New face photos wait on the tablet and are sent automatically once it's back. (With records on the tablet, there's nothing to reach.) |
| Animations stutter | The app turns off blur effects automatically on slower tablets. Updating Android System WebView also helps. |
| The camera bubble says "Camera off" | Allow the camera: **Settings → Apps → Visitor Sign-In → Permissions → Camera**. |
| Everything looks small | The app scales itself to fit the screen. A tablet with a larger screen shows it bigger. |

## Changing the icon

The launcher icon and splash screens are rendered by `tools/icons/render.js`. Change its colors (or the mark) and run `node tools/icons/render.js`.

## Earlier Shock Tech tablets

Tablets with the earlier Shock Tech build have the app id `com.shocktech.visitorkiosk`. To update them in place instead of installing a second app, build with `KIOSK_APP_ID=com.shocktech.visitorkiosk` and the same signing key. The device-owner command then uses that id too: `com.shocktech.visitorkiosk/com.visitorsignin.kiosk.KioskAdminReceiver`.
