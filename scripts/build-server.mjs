// Makes the file to send customers for screenless sign-in on a Raspberry Pi or
// PC (server/README.md): dist/visitor-sign-in-server.zip, with the program,
// the kiosk it serves on their Wi-Fi, and a START HERE note.
//   node scripts/build-server.mjs [--out file.zip]
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const START = `Visitor Sign-In ${version}: screenless sign-in on a PC or Raspberry Pi
==========================================================================

Visitors scan a QR code by your door and sign in on their own phone.
This computer keeps the records and shows the sign-in page on your Wi-Fi.
No accounts or internet needed. It has to stay on while you're open.

ON A WINDOWS PC
  1. Install Node.js (the LTS version) from https://nodejs.org/
  2. Unzip this folder somewhere it can stay, such as Documents.
  3. Double-click server\\start-windows.cmd. If Windows asks about
     networks, allow Node.js on private networks.
  4. Leave the window open. It shows a setup link: open it in a browser on
     any computer, tablet or phone on the same Wi-Fi, and set up.
  5. In Admin > Settings > Phone sign-in: switch it on, type your guest
     Wi-Fi's name and password, and print the poster for the door.

ON A MAC
  Same, but in step 3 right-click server/start-mac.command and choose Open.

ON A RASPBERRY PI (Raspberry Pi OS)
  Copy this folder to the Pi, open a terminal in it, and run:
    sudo bash server/install-pi.sh
  It starts by itself whenever the Pi is switched on, and prints the setup
  link.

Good to know
  - Visitors' phones must be on the same Wi-Fi: the poster shows a code that
    connects them.
  - Phones can't take the visitor photo on a Wi-Fi page (that needs a secure
    https website). Names, questions, rules, signatures and passes all work.
  - Records are in the "Visitor Sign-In" folder in your home folder (on a
    Pi: /var/lib/visitor-sign-in), with a daily backup copy. Copy that
    folder somewhere safe now and then.
  - Keep the setup link private: it allows setting up before you do.
  - Ask your router to always give this computer the same address (a
    "DHCP reservation"), so the poster keeps working.
`;

/** Builds the zip; returns its path, or '' when this computer has no zip command. */
export function buildServerZip(out = join(root, 'dist', 'visitor-sign-in-server.zip')) {
  const stage = mkdtempSync(join(tmpdir(), 'vsi-server-'));
  try {
    for (const f of ['server/box.mjs', 'server/relay.mjs', 'server/local.mjs', 'server/visitor-server.mjs', 'server/README.md',
      'server/start-windows.cmd', 'server/start-mac.command', 'server/install-pi.sh', 'LICENSE']) {
      mkdirSync(dirname(join(stage, f)), { recursive: true });
      copyFileSync(join(root, f), join(stage, f));
    }
    cpSync(join(root, 'web'), join(stage, 'web'), { recursive: true });
    // Node reads the kiosk's files as modules, without a warning.
    writeFileSync(join(stage, 'web/package.json'), '{ "type": "module" }\n');
    writeFileSync(join(stage, 'START HERE.txt'), START.replace(/\n/g, '\r\n'));
    mkdirSync(dirname(out), { recursive: true });
    rmSync(out, { force: true });
    execFileSync('zip', ['-qr', out, '.'], { cwd: stage });
    return out;
  } catch (err) {
    if (err.syscall === 'spawnSync zip' || err.path === 'zip') return '';
    throw err;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--out');
  const made = buildServerZip(i > 0 ? resolve(process.argv[i + 1]) : undefined);
  if (!made) { console.error('There is no zip command on this computer.'); process.exit(1); }
  console.log(`Wrote ${made} (${(statSync(made).size / 1e6).toFixed(1)} MB)`);
}
