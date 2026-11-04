package com.shocktech.visitorkiosk;

/**
 * The device-admin receiver under its original name. Tablets made device
 * owner with the earlier Shock Tech build point at this class; keeping it lets
 * those tablets update in place (KIOSK_APP_ID=com.shocktech.visitorkiosk)
 * without losing the fully locked kiosk mode.
 */
public class KioskAdminReceiver extends com.visitorsignin.kiosk.KioskAdminReceiver {
}
