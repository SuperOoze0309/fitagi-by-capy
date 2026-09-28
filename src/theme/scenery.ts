import type { ThemeId } from '../domain/types';
import type { PixelSprite } from './pixel';
import { getMotifs } from './motifs';

/**
 * Compose a theme's motifs into one wide sprite.
 *
 * A scene is a row of ground tiles with a few accents standing on it. Building it
 * as a single grid rather than as a dozen separate SVGs matters: the strip is pure
 * decoration, and one SVG with a few hundred rects costs far less than twelve
 * components each with their own layout box.
 *
 * The arrangement is fixed rather than random, so the same theme always produces
 * the same scene — a scene that reshuffles on every render would be noise.
 */

/** Width of a scene, in pixels of the sprite grid. */
export const SCENE_WIDTH = 56;

/** Where each accent stands. Deterministic, and spaced so nothing overlaps. */
const ACCENT_SLOTS: { x: number; lift: number }[] = [
  { x: 3, lift: 0 },
  { x: 20, lift: 1 },
  { x: 38, lift: 0 },
];

const SPECK_SLOTS: { x: number; lift: number }[] = [
  { x: 12, lift: 9 },
  { x: 31, lift: 12 },
  { x: 47, lift: 8 },
];

/**
 * Single-character alias pool.
 *
 * A sprite grid is a string per row, so a palette key must be exactly one
 * character. Several sprites are merged into one scene, and their palettes use the
 * same letters (`G` is grass in one and green in another), so every source key is
 * remapped to its own unique character here.
 */
const ALIAS_POOL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
  '!#$%&*+<=>?@^_~|';

interface Canvas {
  width: number;
  height: number;
  rows: string[][];
  palette: Record<string, string>;
  nextAlias: number;
}

function createCanvas(width: number, height: number): Canvas {
  return {
    width,
    height,
    rows: Array.from({ length: height }, () => Array.from({ length: width }, () => '.')),
    palette: {},
    nextAlias: 0,
  };
}

/** Blit a sprite into the canvas, giving each of its palette keys a unique alias. */
function place(canvas: Canvas, sprite: PixelSprite, x: number, bottomY: number): void {
  const remap = new Map<string, string>();
  for (const [key, colour] of Object.entries(sprite.palette)) {
    const alias = ALIAS_POOL[canvas.nextAlias];
    canvas.nextAlias += 1;
    if (alias === undefined) continue;
    remap.set(key, alias);
    canvas.palette[alias] = colour;
  }

  const top = canvas.height - bottomY - sprite.grid.length;
  for (let row = 0; row < sprite.grid.length; row++) {
    const targetY = top + row;
    if (targetY < 0 || targetY >= canvas.height) continue;
    const line = sprite.grid[row]!;
    for (let column = 0; column < line.length; column++) {
      const key = line[column]!;
      if (key === '.') continue;
      const targetX = x + column;
      if (targetX < 0 || targetX >= canvas.width) continue;
      const alias = remap.get(key);
      if (!alias) continue;
      canvas.rows[targetY]![targetX] = alias;
    }
  }
}

/**
 * Build the scene for a theme.
 *
 * `density` drops the floating specks for the places where the strip is a thin
 * accent rather than part of a card.
 */
export function composeScene(
  id: ThemeId,
  options: { width?: number; density?: 'full' | 'ground-only' } = {},
): PixelSprite {
  const width = options.width ?? SCENE_WIDTH;
  const density = options.density ?? 'full';
  const motifs = getMotifs(id);

  const canvas = createCanvas(width, 16);

  // Ground: tiled edge to edge along the bottom.
  const tileWidth = motifs.ground.grid[0]?.length ?? 1;
  for (let x = 0; x < width; x += tileWidth) {
    place(canvas, motifs.ground, x, 0);
  }

  // Accents standing on the ground.
  const accents = motifs.accents;
  ACCENT_SLOTS.forEach((slot, index) => {
    const sprite = accents[index % accents.length];
    if (sprite) place(canvas, sprite, slot.x, slot.lift);
  });

  if (density === 'full') {
    const specks = motifs.specks;
    SPECK_SLOTS.forEach((slot, index) => {
      const sprite = specks[index % specks.length];
      if (sprite) place(canvas, sprite, slot.x, slot.lift);
    });
  }

  return {
    palette: canvas.palette,
    grid: canvas.rows.map((row) => row.join('')),
  };
}
