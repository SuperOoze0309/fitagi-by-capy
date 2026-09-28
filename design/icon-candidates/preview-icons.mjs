/**
 * Preview the launcher icons the way a launcher draws them.
 *
 * A density-correct PNG proves nothing on its own: what matters is the icon inside
 * the mask a phone applies. This renders the legacy icons next to the adaptive
 * background under the three mask shapes Android uses (circle, squircle, rounded
 * square), at launcher size and at 48px.
 *
 * Usage: node design/icon-candidates/preview-icons.mjs   (then open preview-icons.png)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const res = join(root, 'android', 'app', 'src', 'main', 'res');
const work = join(here, '.render-preview');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chrome = CHROME_CANDIDATES.find((candidate) => candidate && existsSync(candidate));
if (!chrome) {
  console.error('No Chrome or Edge found.');
  process.exit(1);
}

const dataUrl = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;

const launcher = dataUrl(join(res, 'mipmap-xxxhdpi', 'ic_launcher.png'));
const round = dataUrl(join(res, 'mipmap-xxxhdpi', 'ic_launcher_round.png'));
const adaptive = dataUrl(join(res, 'mipmap-xxxhdpi', 'ic_launcher_background.png'));
const small = dataUrl(join(res, 'mipmap-mdpi', 'ic_launcher.png'));

const CARD = (label, inner, size = 120) => `
  <figure>
    <div class="slot" style="width:${size}px;height:${size}px">${inner}</div>
    <figcaption>${label}</figcaption>
  </figure>`;

const masked = (radius) =>
  `<img src="${adaptive}" style="width:120px;height:120px;border-radius:${radius}">`;

mkdirSync(work, { recursive: true });
const page = join(work, 'preview.html');
writeFileSync(
  page,
  `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:26px 30px;background:#14161c;color:#e9ecf2;
      font:13px "Segoe UI",system-ui,sans-serif;width:1180px}
    h1{margin:0 0 4px;font-size:19px}
    p{margin:0 0 20px;color:#98a0b3;font-size:12.5px}
    .row{display:flex;gap:26px;align-items:flex-start;margin-bottom:22px}
    figure{margin:0;text-align:center}
    figcaption{color:#98a0b3;font-size:11px;margin-top:7px}
    .slot{display:grid;place-items:center}
    img{display:block}
  </style></head><body>
    <h1>Launcher icon, as a launcher draws it</h1>
    <p>Legacy icons at the left, then the adaptive layer under the three mask shapes Android uses.</p>
    <div class="row">
      ${CARD('legacy square', `<img src="${launcher}" style="width:120px;height:120px">`)}
      ${CARD('legacy round', `<img src="${round}" style="width:120px;height:120px">`)}
      ${CARD('adaptive: circle', masked('50%'))}
      ${CARD('adaptive: squircle', masked('27%'))}
      ${CARD('adaptive: rounded', masked('18%'))}
    </div>
    <div class="row">
      ${CARD('legacy 48px', `<img src="${small}" style="width:48px;height:48px">`, 48)}
      ${CARD('adaptive 48px, circle', `<img src="${adaptive}" style="width:48px;height:48px;border-radius:50%">`, 48)}
      ${CARD('adaptive 48px, squircle', `<img src="${adaptive}" style="width:48px;height:48px;border-radius:27%">`, 48)}
    </div>
  </body></html>`,
  'utf8',
);

const out = join(here, 'preview-icons.png');
execFileSync(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1240,430',
    `--screenshot=${out}`,
    page,
  ],
  { stdio: 'ignore' },
);
rmSync(work, { recursive: true, force: true });
console.log(`preview written: ${out.replace(root + '\\', '')}`);
