/**
 * Render a preview sheet for the theme art: every mascot, every motif and every
 * composed scene, at a scale where a mistake is obvious.
 *
 * Usage: node design/theme-art/preview.mjs   (writes preview.html + preview.png)
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES } from '../../src/theme/tokens.ts';
import { MASCOTS } from '../../src/theme/tokens.ts';
import { MOTIFS } from '../../src/theme/motifs.ts';
import { composeScene } from '../../src/theme/scenery.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Render a sprite as an SVG with one rect per pixel, at `scale` pixels per cell. */
function spriteSvg(sprite, scale = 8) {
  const height = sprite.grid.length;
  const width = sprite.grid[0]?.length ?? 0;
  const rects = [];
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const key = sprite.grid[row][column];
      if (key === '.') continue;
      const colour = sprite.palette[key];
      if (!colour) continue;
      rects.push(
        `<rect x="${column}" y="${row}" width="1" height="1" fill="${colour}"/>`,
      );
    }
  }
  return `<svg viewBox="0 0 ${width} ${height}" width="${width * scale}" height="${height * scale}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}

const SCALE = 7;

const themeSections = THEMES.map((theme) => {
  const mascot = MASCOTS[theme.id];
  const motifs = MOTIFS[theme.id];
  const scene = composeScene(theme.id);

  const motifCells = [motifs.ground, ...motifs.accents, ...motifs.specks]
    .map((sprite) => `<div class="cell">${spriteSvg(sprite, SCALE)}</div>`)
    .join('');

  return `
  <section class="theme" style="background:${theme.tokens.background};color:${theme.tokens.textPrimary}">
    <h2>${theme.id} <span class="hint">${theme.tokens.primary} / ${theme.tokens.secondary}</span></h2>
    <div class="row">
      <div class="cell big" style="background:${theme.tokens.surface}">${spriteSvg(mascot, 9)}</div>
      <div class="cell big" style="background:${theme.tokens.surface}">${spriteSvg(mascot, 3)}</div>
      <div class="cell big" style="background:${theme.tokens.surface}">${spriteSvg(mascot, 2)}</div>
      <div class="stack">
        <div class="label">motifs</div>
        <div class="row">${motifCells}</div>
      </div>
    </div>
    <div class="label">scene (56 x 16 grid)</div>
    <div class="scene" style="background:${theme.tokens.surfaceSecondary}">${spriteSvg(scene, 10)}</div>
    <div class="label">scene, ground only</div>
    <div class="scene" style="background:${theme.tokens.surfaceSecondary}">${spriteSvg(composeScene(theme.id, { density: 'ground-only' }), 10)}</div>
  </section>`;
}).join('');

writeFileSync(
  join(here, 'preview.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>theme art preview</title>
<style>
  body { margin:0; padding:24px; background:#15171c; color:#e9ecf2; font:13px "Segoe UI", system-ui, sans-serif; }
  .theme { border-radius:14px; padding:16px 18px; margin-bottom:18px; }
  h2 { margin:0 0 10px; font-size:15px; text-transform:uppercase; letter-spacing:.08em; }
  .hint { font-weight:400; opacity:.6; text-transform:none; letter-spacing:0; }
  .row { display:flex; gap:14px; align-items:flex-end; flex-wrap:wrap; }
  .stack { display:flex; flex-direction:column; gap:6px; }
  .cell { display:inline-block; padding:6px; border-radius:8px; background:#ffffff22; line-height:0; }
  .cell.big { padding:10px; }
  .label { font-size:10px; text-transform:uppercase; letter-spacing:.1em; opacity:.55; margin-top:10px; }
  .scene { line-height:0; padding:8px; border-radius:10px; overflow:hidden; }
</style></head><body>${themeSections}</body></html>`,
  'utf8',
);

console.log('preview.html written');
