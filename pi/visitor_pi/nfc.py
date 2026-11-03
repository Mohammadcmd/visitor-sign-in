"""The Pi's own USB NFC reader: tap a badge to sign out.

Generic USB readers act as keyboards: they "type" the card number and press
Enter. The Pi has no screen, so the reader is read straight from Linux's input
devices (python3-evdev). A tap is told apart from a person typing by speed,
with the same rules as the tablet (web/js/nfc.js).

The first device that produces a real tap is remembered as the reader and
grabbed, so its keystrokes no longer reach the console. Keyboards plugged in
for maintenance are never grabbed.
"""
import select
import time

MIN_CHARS = 4
MAX_AVG_GAP = 0.045
MAX_ENTER_GAP = 0.150
RESET_GAP = 0.120
DOUBLE_READ = 3.0


class TapDetector:
    """Feed it key presses; it returns the typed text when they add up to a reader tap."""

    def __init__(self):
        self.buf = []  # (char, time)

    def key(self, ch, t):
        if self.buf and t - self.buf[-1][1] > RESET_GAP:
            self.buf = []
        self.buf.append((ch, t))

    def enter(self, t):
        buf, self.buf = self.buf, []
        if len(buf) < MIN_CHARS or t - buf[-1][1] >= MAX_ENTER_GAP:
            return None
        gaps = [b[1] - a[1] for a, b in zip(buf, buf[1:])]
        if sum(gaps) / len(gaps) >= MAX_AVG_GAP:
            return None
        return ''.join(c for c, _ in buf)


def _keymap(ecodes):
    m = {}
    for d in '0123456789':
        m[getattr(ecodes, f'KEY_{d}')] = d
        m[getattr(ecodes, f'KEY_KP{d}')] = d
    for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
        m[getattr(ecodes, f'KEY_{c}')] = c
    return m


def run_reader(store, log, on_tap):
    """Runs forever in a background thread. on_tap(tag) handles each badge tap."""
    try:
        import evdev
        from evdev import ecodes
    except ImportError:
        log('Pi badge reader off: install python3-evdev to sign visitors out at the Pi.')
        return
    keymap = _keymap(ecodes)
    enters = {ecodes.KEY_ENTER, ecodes.KEY_KPENTER}
    last = {'tag': None, 'at': 0.0}

    while True:
        devices = {}
        try:
            for path in evdev.list_devices():
                dev = evdev.InputDevice(path)
                keys = dev.capabilities().get(ecodes.EV_KEY, [])
                if ecodes.KEY_ENTER in keys and ecodes.KEY_1 in keys:
                    devices[dev.fd] = (dev, TapDetector())
        except OSError as err:
            log(f'Pi badge reader: could not list input devices ({err})')
        learned = store.setting('nfc_reader_name')
        for dev, _ in devices.values():
            if learned and dev.name == learned:
                _grab(dev, log)
        if not devices:
            time.sleep(5)
            continue
        log('Pi badge reader: listening on ' + ', '.join(sorted({d.name for d, _ in devices.values()})))
        try:
            while True:
                ready, _, _ = select.select(list(devices), [], [], 30)
                for fd in ready:
                    dev, detector = devices[fd]
                    for ev in dev.read():
                        if ev.type != ecodes.EV_KEY or ev.value != 1:  # key down only
                            continue
                        t = ev.timestamp()
                        if ev.code in enters:
                            raw = detector.enter(t)
                            if raw is None:
                                continue
                            if store.setting('nfc_reader_name') != dev.name:
                                store.set_setting('nfc_reader_name', dev.name)
                                _grab(dev, log)
                                log(f'Pi badge reader: learned "{dev.name}" as the reader')
                            if raw == last['tag'] and t - last['at'] < DOUBLE_READ:
                                continue  # some readers send a tap twice
                            last.update(tag=raw, at=t)
                            on_tap(raw)
                        elif ev.code in keymap:
                            detector.key(keymap[ev.code], t)
                if not ready and len(evdev.list_devices()) != len(devices):
                    break  # a device was plugged in or out: rescan
        except OSError:
            log('Pi badge reader: a device was unplugged; looking again')
            time.sleep(2)
        finally:
            for dev, _ in devices.values():
                try:
                    dev.close()
                except OSError:
                    pass


def _grab(dev, log):
    try:
        dev.grab()
    except OSError as err:
        log(f'Pi badge reader: could not grab "{dev.name}" ({err}); taps will still work')
