package com.shocktech.visitorkiosk;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.os.SystemClock;
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
}
