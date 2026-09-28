/**
 * Build the icon contact sheet.
 *
 * The SVGs are inlined rather than referenced through `<img>` so the page can be
 * screenshotted straight from `file://` with no local-file restrictions, and so a
 * candidate is shown exactly as written in its own file.
 *
 * Usage: node design/icon-candidates/make-contact-sheet.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Strip the outer <svg> wrapper's sizing so the markup can be nested and resized. */
function inlineSvg(source) {
  return source
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<svg([^>]*?)width="\d+"\s*height="\d+"([^>]*?)>/, '<svg$1$2>')
    .replace(/<svg /, '<svg class="art" ');
}

const files = readdirSync(here)
  .filter((name) => name.endsWith('.svg'))
  .sort();

const candidates = files.map((name) => ({
  file: name,
  markup: inlineSvg(readFileSync(join(here, name), 'utf8')),
}));

const LABELS = {
  'a-bicep-u.svg': ['A', 'Bicep U + C fist', 'Bunny gradient. The arm is one wide U, the fist is a C gripping it.'],
  'b-ink-arm.svg': ['B', 'Carved ink arm', 'One solid silhouette with the U and the C cut back out of it.'],
  'c-orca-flat.svg': ['C', 'Ocean blue', 'White U for the arm, teal C for the fist, on deep blue.'],
  'd-tilted-flex.svg': ['D', 'Tilted flex', 'The same arm rotated into a flex, on a soft rose square.'],
  'e-pixel-16.svg': ['E', 'Pixel arm, 16×16', 'The same skeleton in the app’s own mascot grid, bunny palette.'],
  'f-pixel-24.svg': ['F', 'Pixel arm, 24×24', 'Same grid at a larger size, panda palette, monochrome.'],
};

const rows = candidates
  .map(({ file, markup }) => {
    const [letter, title, blurb] = LABELS[file] ?? ['?', file, ''];
    return `
      <section class="card">
        <div class="hero">${markup}</div>
        <div class="meta">
          <div class="letter">${letter}</div>
          <div>
            <div class="title">${title}</div>
            <div class="blurb">${blurb}</div>
            <div class="file">${file}</div>
          </div>
        </div>
        <div class="crops">
          <figure class="crop"><div class="mask circle">${markup}</div><figcaption>circle 96</figcaption></figure>
          <figure class="crop"><div class="mask squircle">${markup}</div><figcaption>squircle 96</figcaption></figure>
          <figure class="crop"><div class="mask rounded">${markup}</div><figcaption>rounded 96</figcaption></figure>
          <figure class="crop"><div class="mask circle tiny">${markup}</div><figcaption>circle 48</figcaption></figure>
          <figure class="crop"><div class="mask circle micro">${markup}</div><figcaption>circle 32</figcaption></figure>
        </div>
      </section>`;
  })
  .join('\n');

writeFileSync(
  join(here, 'contact-sheet.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>UCFit icon candidates</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 32px 36px; width: 1560px;
    background: #0e0f13; color: #e9ecf2;
    font: 14px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.01em; }
  .sub { margin: 0 0 22px; color: #98a0b3; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .card { background: #16181f; border: 1px solid #262a35; border-radius: 16px; padding: 18px; }
  .hero { width: 232px; height: 232px; margin: 0 auto 14px; border-radius: 20px; overflow: hidden; }
  .art { width: 100%; height: 100%; display: block; }
  .meta { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
  .letter {
    flex: none; width: 26px; height: 26px; border-radius: 8px; background: #e0326e; color: #fff;
    font-weight: 700; display: grid; place-items: center; font-size: 14px;
  }
  .title { font-weight: 650; }
  .blurb { color: #98a0b3; font-size: 12.5px; }
  .file { color: #5f6879; font-size: 11.5px; margin-top: 2px; font-family: ui-monospace, monospace; }
  .crops { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
  .crop { margin: 0; text-align: center; }
  .crop figcaption { color: #6b7488; font-size: 10.5px; margin-top: 5px; }
  .mask { overflow: hidden; }
  .mask.circle { border-radius: 50%; }
  .mask.squircle { border-radius: 28%; }
  .mask.rounded { border-radius: 18%; }
  .mask, .mask.squircle, .mask.rounded, .mask.circle { width: 96px; height: 96px; }
  .mask.tiny { width: 48px; height: 48px; }
  .mask.micro { width: 32px; height: 32px; }
</style>
</head>
<body>
  <h1>UCFit launcher icon — six candidates</h1>
  <p class="sub">
    Each card shows the artwork at 232px, then how it survives an Android adaptive-icon
    mask (circle, squircle, rounded) and how it reads at 48px and 32px.
  </p>
  <div class="grid">
${rows}
  </div>
</body>
</html>
`,
  'utf8',
);

console.log(`contact-sheet.html written with ${candidates.length} candidates`);
