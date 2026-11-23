// Renders the Recall app icons (favicon SVG + PNGs for iOS "Add to Home Screen" and the web manifest)
// from the one mark below, using headless Google Chrome. Run: node scripts/build-icons.mjs
// Output goes to web/public/icons/. Re-run after changing the mark or colours.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'web', 'public', 'icons');
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));

// The mark, on a 64×64 grid: a flashcard with an R, and a second card fanned out behind it.
// `ink` is the colour of the R (the app passes its theme accent; icons use Orchard crimson).
export const mark = (ink) => `
  <rect x="14" y="16" width="28" height="34" rx="6" fill="#fff" opacity=".42" transform="rotate(-10 28 33)"/>
  <rect x="21" y="15.5" width="28" height="35" rx="6" fill="#5a0a1c" opacity=".2"/>
  <rect x="21" y="14" width="28" height="35" rx="6" fill="#fff"/>
  <path d="M29 41V24h7a5 5 0 0 1 0 10h-4l7 7" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;

const background = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f2513f"/><stop offset=".55" stop-color="#df3047"/><stop offset="1" stop-color="#a3122e"/>
    </linearGradient>
    <radialGradient id="glow" cx=".28" cy=".22" r=".62">
      <stop offset="0" stop-color="#ffa074" stop-opacity=".95"/><stop offset="1" stop-color="#ffa074" stop-opacity="0"/>
    </radialGradient>
  </defs>`;

/** Full icon. rounded=false gives a full-bleed square (iOS and Android round the corners themselves). */
const icon = ({ rounded = false, scale = 1 } = {}) => {
  const r = rounded ? 15 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${background}
  <rect width="64" height="64" rx="${r}" fill="url(#bg)"/><rect width="64" height="64" rx="${r}" fill="url(#glow)"/>
  <g transform="translate(32 32) scale(${scale}) translate(-30.5 -32.5)">${mark('#df3047')}</g>
</svg>`;
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.svg'), icon({ rounded: true }));

const pngs = [
  ['apple-touch-icon.png', 180, icon()],                     // iOS home screen (no transparency, iOS masks it)
  ['icon-192.png', 192, icon()],
  ['icon-512.png', 512, icon()],
  ['icon-maskable-512.png', 512, icon({ scale: 0.8 })],     // Android adaptive icons: mark inside the 80% safe zone
];
if (!CHROME) { console.error('Google Chrome not found; set CHROME=/path/to/chrome'); process.exit(1); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-icons-'));
for (const [name, size, svg] of pngs) {
  const html = path.join(tmp, `${name}.html`);
  fs.writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:#df3047}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  execFileSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=${size},${size}`, `--screenshot=${path.join(OUT, name)}`, `file://${html}`], { stdio: 'ignore' });
  console.log(`icons/${name} (${size}×${size})`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('icons/icon.svg');
