/**
 * Render the Android launcher icon set from the two source SVGs.
 *
 * Chrome does the rasterising (it is already a hard requirement of the browser
 * smoke test, so this adds no dependency). Each size gets its own page with the
 * SVG inline at exactly the target pixel size, so the output is 1:1 with no
 * scaling artefacts and no image-resampling library.
 *
 * Usage: node design/icon-candidates/render-android-icons.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const res = join(root, 'android', 'app', 'src', 'main', 'res');
const work = join(here, '.render');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const chrome = CHROME_CANDIDATES.find((candidate) => candidate && existsSync(candidate));
if (!chrome) {
  console.error('No Chrome or Edge found; cannot render the icon set.');
  process.exit(1);
}

/** Pin the root <svg> to an exact pixel box so a screenshot is a 1:1 render. */
function sized(svg, size) {
  return svg
    .replace(/width="\d+"\s+height="\d+"/, `width="${size}" height="${size}"`)
    .replace(/viewBox="0 0 512 512"/, `viewBox="0 0 512 512" preserveAspectRatio="xMidYMid meet"`);
}

function render(svgSource, size, outPath) {
  mkdirSync(work, { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });
  const page = join(work, `icon-${size}.html`);
  writeFileSync(
    page,
    `<!doctype html><html><head><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;overflow:hidden;background:transparent}
       svg{display:block}
     </style></head><body>${sized(svgSource, size)}</body></html>`,
    'utf8',
  );
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      '--force-device-scale-factor=1',
      `--window-size=${size},${size}`,
      `--screenshot=${outPath}`,
      page,
    ],
    { stdio: 'ignore' },
  );
  console.log(`  ${outPath.replace(root + '\\', '')}  ${size}x${size}`);
}

const icon = readFileSync(join(here, 'ragdoll-app-icon.svg'), 'utf8');
const foreground = readFileSync(join(here, 'ragdoll-app-foreground.svg'), 'utf8');

/**
 * Android densities. Launcher icons are 48dp, adaptive foregrounds are 108dp, and
 * the foreground is rendered on a transparent background because Android composites
 * it over the background layer itself.
 */
const DENSITIES = [
  { dir: 'mipmap-mdpi', launcher: 48, foreground: 108 },
  { dir: 'mipmap-hdpi', launcher: 72, foreground: 162 },
  { dir: 'mipmap-xhdpi', launcher: 96, foreground: 216 },
  { dir: 'mipmap-xxhdpi', launcher: 144, foreground: 324 },
  { dir: 'mipmap-xxxhdpi', launcher: 192, foreground: 432 },
];

console.log('Rendering launcher icons:');
for (const { dir, launcher, foreground: fgSize } of DENSITIES) {
  const target = join(res, dir);
  render(icon, launcher, join(target, 'ic_launcher.png'));
  render(icon, launcher, join(target, 'ic_launcher_round.png'));
  render(foreground, fgSize, join(target, 'ic_launcher_foreground.png'));
}

rmSync(work, { recursive: true, force: true });
console.log('done');
