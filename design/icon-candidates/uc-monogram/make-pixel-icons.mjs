/**
 * Generate the pixel-art icon candidates.
 *
 * The arm is rasterised from the same skeleton the vector candidates use, so the
 * pixel versions are the same drawing at a different resolution rather than a
 * separate guess: for every cell centre the distance to the arm's centre line is
 * compared with the arm's thickness, which gives a clean shape with a one-pixel
 * outline in the app's mascot style.
 *
 * Usage: node design/icon-candidates/make-pixel-icons.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- geometry

/**
 * The arm, in a 0..1 square, matching the vector candidates: two limbs joined by
 * a round elbow, with the upper arm drawn heavier.
 */
const ARM = [
  [0.136, 0.297],
  [0.136, 0.712],
  [0.454, 0.896],
  [0.772, 0.712],
  [0.772, 0.297],
];
const ARM_WIDTH = 0.185;
const UPPER_ARM_WIDTH = 0.277;

/** The fist: a thick ring with a wedge cut out, opening down-left into the fold. */
const FIST = { cx: 0.772, cy: 0.233, r: 0.162, gapFrom: 101, gapTo: 179 };
const FIST_WIDTH = 0.168;

const distanceToSegment = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const distanceToPolyline = (px, py, points) => {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    best = Math.min(best, distanceToSegment(px, py, points[i], points[i + 1]));
  }
  return best;
};

const angleOf = (px, py, cx, cy) => {
  const deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
};

const distanceToRing = (px, py, { cx, cy, r, gapFrom, gapTo }) => {
  const angle = angleOf(px, py, cx, cy);
  const inGap = gapFrom < gapTo ? angle > gapFrom && angle < gapTo : angle > gapFrom || angle < gapTo;
  const radial = Math.abs(Math.hypot(px - cx, py - cy) - r);
  if (!inGap) return radial;
  // Inside the gap the nearest ink is one of the two open ends.
  const ends = [gapFrom, gapTo].map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  });
  return Math.min(...ends.map(([ex, ey]) => Math.hypot(px - ex, py - ey)));
};

/**
 * How deep inside the arm a point is.
 *
 * Positive means "inside the ink", negative means "outside by that much", so a
 * single comparison produces both the fill and its outline.
 */
function inkDepth(x, y) {
  const d = Math.min(
    distanceToPolyline(x, y, ARM) - ARM_WIDTH / 2,
    distanceToSegment(x, y, ARM[0], ARM[1]) - UPPER_ARM_WIDTH / 2,
    distanceToRing(x, y, FIST) - FIST_WIDTH / 2,
  );
  return -d;
}

// ------------------------------------------------------------------ render

function render(size, palette) {
  const outline = 1.15 / size; // one pixel, with a little tolerance
  const cells = [];

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = (column + 0.5) / size;
      const y = (row + 0.5) / size;
      const depth = inkDepth(x, y);

      if (depth >= 0) {
        // Shade the lower-right of the mass so it does not read flat.
        const shaded = depth < 0.028;
        cells.push({ column, row, fill: shaded ? palette.shade : palette.fill });
      } else if (depth > -outline) {
        cells.push({ column, row, fill: palette.outline });
      }
    }
  }

  const rects = cells
    .map(({ column, row, fill }) => `  <rect x="${column}" y="${row}" width="1" height="1" fill="${fill}"/>`)
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="512" height="512" shape-rendering="crispEdges" role="img" aria-label="UCFit pixel arm icon">
  <rect width="${size}" height="${size}" fill="${palette.background}"/>
${rects}
</svg>
`;
}

const VARIANTS = [
  {
    file: 'e-pixel-16.svg',
    size: 16,
    palette: {
      background: '#ffe6f1',
      fill: '#ffffff',
      shade: '#ff9ec9',
      outline: '#3a2340',
    },
  },
  {
    file: 'f-pixel-24.svg',
    size: 24,
    palette: {
      background: '#ffffff',
      fill: '#f2f2f0',
      shade: '#c9c9c6',
      outline: '#17181c',
    },
  },
];

for (const { file, size, palette } of VARIANTS) {
  writeFileSync(join(here, file), render(size, palette), 'utf8');
  console.log(`${file} written (${size}x${size})`);
}
