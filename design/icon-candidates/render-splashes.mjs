/**
 * Render the Android splash screens.
 *
 * One page per size, with the mark sized relative to the shorter edge so a splash
 * looks the same on a phone, a tablet and in landscape. The splashes Capacitor
 * generates by default carry its logo and the old app name, so they have to be
 * regenerated rather than inherited.
 *
 * The mark is the cropped cat sketch (`source/cat-crop.png`, produced by
 * render-android-icons.ps1) on the sketch's own paper colour, so the splash and the
 * launcher icon are the same drawing.
 *
 * Usage: node design/icon-candidates/render-splashes.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const res = join(root, 'android', 'app', 'src', 'main', 'res');
const work = join(here, '.render-splash');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chrome = CHROME_CANDIDATES.find((candidate) => candidate && existsSync(candidate));
if (!chrome) {
  console.error('No Chrome or Edge found; cannot render the splashes.');
  process.exit(1);
}

const crop = join(here, 'source', 'cat-crop.png');
if (!existsSync(crop)) {
  console.error('Missing source/cat-crop.png - run render-android-icons.ps1 first.');
  process.exit(1);
}
/** Inlined as a data URL so the page has no external file dependency. */
const catDataUrl = `data:image/png;base64,${readFileSync(crop).toString('base64')}`;

/** The sketch's own paper colour, so the splash background matches its edges. */
const PAPER = '#f9f5f2';

const SPLASHES = [
  { dir: 'drawable', width: 480, height: 320 },
  { dir: 'drawable-land-mdpi', width: 480, height: 320 },
  { dir: 'drawable-land-hdpi', width: 800, height: 480 },
  { dir: 'drawable-land-xhdpi', width: 1280, height: 720 },
  { dir: 'drawable-land-xxhdpi', width: 1600, height: 960 },
  { dir: 'drawable-land-xxxhdpi', width: 1920, height: 1280 },
  { dir: 'drawable-port-mdpi', width: 320, height: 480 },
  { dir: 'drawable-port-hdpi', width: 480, height: 800 },
  { dir: 'drawable-port-xhdpi', width: 720, height: 1280 },
  { dir: 'drawable-port-xxhdpi', width: 960, height: 1600 },
  { dir: 'drawable-port-xxxhdpi', width: 1280, height: 1920 },
];

console.log('Rendering splashes:');
mkdirSync(work, { recursive: true });

for (const { dir, width, height } of SPLASHES) {
  // The mark scales with the shorter edge, so a landscape splash is not enormous.
  const mark = Math.round(Math.min(width, height) * 0.42);
  const page = join(work, `splash-${dir}.html`);
  writeFileSync(
    page,
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;overflow:hidden;width:${width}px;height:${height}px;
        background:${PAPER}}
      .wrap{width:${width}px;height:${height}px;display:flex;flex-direction:column;
        align-items:center;justify-content:center;gap:${Math.round(mark * 0.14)}px;
        font-family:"Segoe UI",system-ui,sans-serif}
      img{width:${mark}px;height:${mark}px;display:block}
      .name{font-size:${Math.round(mark * 0.17)}px;font-weight:650;color:#33302c;
        letter-spacing:.01em}
      .tag{font-size:${Math.round(mark * 0.1)}px;color:#6f6862}
    </style></head><body><div class="wrap">
      <img src="${catDataUrl}" alt="">
      <div class="name">FitAGI by Capy</div>
      <div class="tag">local-first training &amp; meal log</div>
    </div></body></html>`,
    'utf8',
  );

  const out = join(res, dir, 'splash.png');
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      page,
    ],
    { stdio: 'ignore' },
  );
  console.log(`  ${dir}/splash.png  ${width}x${height}`);
}

rmSync(work, { recursive: true, force: true });
console.log('done');
