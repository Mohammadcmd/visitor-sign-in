package com.shocktech.visitorkiosk;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Runs the kiosk web app full screen, keeps the screen on, ignores the Back
 * button and keeps the tablet locked to this app (see KioskPlugin).
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KioskPlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Visitors can't back out of the kiosk.
            }
        });
        hideSystemBars();
        // Honor the page's viewport width so smaller tablets scale the kiosk down to fit.
        WebSettings web = getBridge().getWebView().getSettings();
        web.setUseWideViewPort(true);
        web.setLoadWithOverviewMode(true);
        web.setMediaPlaybackRequiresUserGesture(false);
    }

    @Override
    public void onResume() {
        super.onResume();
        hideSystemBars();
        KioskPlugin.lock(this);
        // Keyboard-style NFC readers type into whatever has focus: make sure it's the kiosk.
        if (getBridge() != null) getBridge().getWebView().requestFocus();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.hide(WindowInsetsCompat.Type.systemBars());
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
