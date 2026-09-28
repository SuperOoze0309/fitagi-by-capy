import type { PixelSprite } from './pixel';

/**
 * The mascots, drawn as 16×16 pixel grids.
 *
 * Palette keys: `L` outline, `B` body, `D` shading, `W` highlight/white,
 * `P` accent (nose, blush, inner ear), `E` eye, `S` secondary accent.
 *
 * They are deliberately simple and slightly chunky: the app is a training tool,
 * not a children's game, so the mascot is a small mark rather than an illustration.
 */

/** Theme A — bunny. Pink body, blue inner ears. */
export const bunnySprite: PixelSprite = {
  palette: {
    L: '#5a3448',
    B: '#f6b7cf',
    D: '#e28cb0',
    W: '#fff4f8',
    P: '#f06fa0',
    E: '#3a2530',
    S: '#6f9cea',
  },
  grid: [
    '................',
    '...LL......LL...',
    '..LSSL....LSSL..',
    '..LSSL....LSSL..',
    '..LBPL....LPBL..',
    '..LBBLLLLLLBBL..',
    '.LBBBBBBBBBBBBL.',
    '.LBBBBBBBBBBBBL.',
    '.LBBEBBBBBBEBBL.',
    '.LBBEBBBBBBEBBL.',
    '.LBBBBBWBBBBBBL.',
    '.LBBBPBBBBPBBBL.',
    '..LBBBBBBBBBBL..',
    '...LBBBBBBBBL...',
    '....LLBBBBLL....',
    '.....LWWWWL.....',
  ],
};

/** Theme B — panda. Black and white, monochrome by design. */
export const pandaSprite: PixelSprite = {
  palette: {
    L: '#141416',
    B: '#ffffff',
    D: '#dcdcde',
    W: '#ffffff',
    P: '#9a9a9e',
    E: '#141416',
    S: '#3f4247',
  },
  grid: [
    '................',
    '..LLL......LLL..',
    '.LSSSLL..LLSSSL.',
    '.LSSSSLLLLSSSSL.',
    '.LSSBBBBBBBBSSL.',
    '..LBBBBBBBBBBL..',
    '.LBBLLLLLLLLBBL.',
    '.LBLLLEELLEELLBL',
    '.LBLLLEELLEELLBL',
    '.LBBLLLLLLLLBBL.',
    '.LBBBBLEEBBBBBBL',
    '.LBBBBBBBBBBBBL.',
    '.LBPBBBBBBBBPBL.',
    '..LBBBBBBBBBBL..',
    '...LLLBBBBLLL...',
    '.....LLLLLL.....',
  ],
};

/** Theme C — orca. Deep navy body with the white eye patch and belly. */
export const orcaSprite: PixelSprite = {
  palette: {
    L: '#061527',
    B: '#123a5c',
    D: '#0b2239',
    W: '#f4fbff',
    P: '#7fd4f5',
    E: '#061527',
    S: '#1f6fb2',
  },
  grid: [
    '.......LL.......',
    '.......LL.......',
    '......LBBL......',
    '......LBBL......',
    '.....LBBBBL.....',
    '..LLLBBBBBBLLL..',
    '.LBBBBBBBBBBBBL.',
    '.LBBWWBBBBBBBBL.',
    '.LBBWEBBBBBBBBL.',
    '.LBBWWBBBBBBBBL.',
    '.LBBBBBBBBBBBBL.',
    '.LBBWWWWWWWWBBL.',
    '.LBWWWWWWWWWWBL.',
    '..LWWWWWWWWWWL..',
    '...LLWWWWWWLL...',
    '.....LLLLLL.....',
  ],
};

/**
 * Theme D — ragdoll. The app's own mascot: a colourpoint cat with grey ears and
 * mask, a white muzzle, blue eyes and a pink nose, drawn the same 16×16 way as
 * the other three so the whole set stays one family.
 *
 * `E` is the eye colour rather than an outline here, because the blue eyes are what
 * makes a ragdoll a ragdoll; the muzzle is `W` and the mask `D`.
 */
export const ragdollSprite: PixelSprite = {
  palette: {
    L: '#4b4550',
    B: '#d6cfc8',
    D: '#a79f97',
    W: '#fdfbf8',
    P: '#e58aa6',
    E: '#5f8fbf',
    S: '#efe9e3',
  },
  grid: [
    '................',
    '..LL........LL..',
    '.LDDL......LDDL.',
    '.LDPL......LPDL.',
    '.LDDDLLLLLLDDDL.',
    '.LBBBBBBBBBBBBL.',
    '.LBDDBBBBBBDDBL.',
    'LBBDEEBBBBEEDBBL',
    'LBBDEEBBBBEEDBBL',
    'LBBBDBBWBBDBBBBL',
    'LBBBBWWPPWWBBBBL',
    '.LBBBBWWWWBBBBL.',
    '..LBBBWLLWBBBL..',
    '...LBBBBBBBBL...',
    '....LLBBBBLL....',
    '......LLLL......',
  ],
};
