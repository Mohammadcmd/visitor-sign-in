package com.visitorsignin.kiosk;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the tablet locked to the kiosk.
 *
 * If the app has been made the device owner (see android/README.md), Android's
 * lock task mode locks it silently and fully. Otherwise Android's "app pinning"
 * is used, which asks once for confirmation when the app starts.
 *
 * The admin screen can unlock the tablet for a few minutes to reach Android
 * settings; after that the kiosk locks itself again the next time it's shown.
 *
 * It also saves files (CSV exports, the settings backup) to the Downloads
 * folder, because downloads started by a web page don't work inside the app.
 */
@CapacitorPlugin(name = "Kiosk")
public class KioskPlugin extends Plugin {

    private static final long UNLOCK_MS = 5 * 60 * 1000;
    private static long unlockedUntil = 0;
    private static boolean askedToPin = false;

    static void lock(Activity activity) {
        if (SystemClock.elapsedRealtime() < unlockedUntil || isLocked(activity)) return;
        DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
        String pkg = activity.getPackageName();
        try {
            if (dpm != null && dpm.isDeviceOwnerApp(pkg)) {
                dpm.setLockTaskPackages(new ComponentName(activity, KioskAdminReceiver.class), new String[] { pkg });
                activity.startLockTask();
            } else if (!askedToPin) {
                // Without device owner, Android asks the person to confirm pinning. Ask once per start.
                askedToPin = true;
                activity.startLockTask();
            }
        } catch (RuntimeException e) {
            // Lock task isn't available on this device; the kiosk still runs full screen.
        }
    }

    static boolean isLocked(Activity activity) {
        ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
        }
        return am.isInLockTaskMode();
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        Activity activity = getActivity();
        unlockedUntil = SystemClock.elapsedRealtime() + UNLOCK_MS;
        askedToPin = false;
        activity.runOnUiThread(() -> {
            try {
                activity.stopLockTask();
            } catch (RuntimeException e) {
                // Wasn't locked.
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        Activity activity = getActivity();
        DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
        JSObject out = new JSObject();
        out.put("locked", isLocked(activity));
        out.put("deviceOwner", dpm != null && dpm.isDeviceOwnerApp(activity.getPackageName()));
        call.resolve(out);
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = call.getString("name", "export.txt").replaceAll("[^A-Za-z0-9._-]", "-");
        String text = call.getString("text", "");
        String mime = call.getString("mime", "text/plain");
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        try {
            JSObject out = new JSObject();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Android 10 and newer: the shared Downloads folder, no permission needed.
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                ContentResolver resolver = getContext().getContentResolver();
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IOException("Downloads folder unavailable");
                try (OutputStream stream = resolver.openOutputStream(uri)) {
                    if (stream == null) throw new IOException("Downloads folder unavailable");
                    stream.write(bytes);
                }
                out.put("where", "Downloads");
            } else {
                // Older Android: the app's own Downloads folder (Android/data/<app>/files/Download).
                File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) throw new IOException("Storage unavailable");
                File file = new File(dir, name);
                try (FileOutputStream stream = new FileOutputStream(file)) {
                    stream.write(bytes);
                }
                out.put("where", file.getAbsolutePath());
            }
            call.resolve(out);
        } catch (IOException | RuntimeException e) {
            call.reject("Couldn't save the file", e);
        }
    }
}
