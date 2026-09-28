import type { ThemeId } from '../domain/types';
import type { PixelSprite } from './pixel';
import { bunnySprite, orcaSprite, pandaSprite, ragdollSprite } from './mascots';

/**
 * Theme motifs.
 *
 * Each theme gets a small vocabulary of things that belong to it, so the app looks
 * like it was made for that theme rather than merely recoloured: a bunny theme has
 * grass, flowers and carrots; a panda theme has bamboo; an orca theme has water;
 * and the ragdoll theme is the app's own cat, so it has paws and yarn.
 *
 * They are pixel sprites like the mascots, but flat: no outline, two or three
 * tones each. A motif is 8–10px and is drawn at 14–20px on screen, which is too
 * small for the mascots' 1px outline to survive — an outline there just reads as
 * dirt. The mascots carry the character; these carry the colour.
 */

/** One theme's vocabulary. `ground` repeating along the bottom is what makes a scene. */
export interface ThemeMotifs {
  /** Tiles horizontally along the bottom edge of a scene. */
  ground: PixelSprite;
  /** Sits on the ground line, in this order. */
  accents: PixelSprite[];
  /** Smaller marks scattered in the air above the ground. */
  specks: PixelSprite[];
}

// ------------------------------------------------------------------ bunny

const grassGround: PixelSprite = {
  palette: { G: '#8ccf8f', D: '#5da868', E: '#7bc47f' },
  grid: [
    '..........',
    '...G......',
    '..GG...G..',
    '..GG..GG..',
    '.GGG..GG..',
    '.GGGGGGG..',
    '.GGGGGGGG.',
    'GGGGGGGGGG',
    'DDDDDDDDDD',
    'EEEEEEEEEE',
  ],
};

const flower: PixelSprite = {
  palette: { P: '#f06fa0', Y: '#ffd166', G: '#6cbf72' },
  grid: [
    '...PPP....',
    '..PPPPP...',
    '.PPYYYPP..',
    '.PPYYYPP..',
    '..PPPPP...',
    '...PPP....',
    '....G.....',
    '....G.....',
    '...GGG....',
    '..........',
  ],
};

const carrot: PixelSprite = {
  palette: { O: '#f08a3c', G: '#6cbf72', D: '#d1702a' },
  grid: [
    '.....GG...',
    '..G.GGG.G.',
    '..GGGGGG..',
    '...OOOO...',
    '..OOOOOO..',
    '..ODOOOO..',
    '...OOOO...',
    '...ODOO...',
    '....OO....',
    '.....O....',
  ],
};

const bunnyCloud: PixelSprite = {
  palette: { W: '#e7d7f2', S: '#d3bfe6' },
  grid: [
    '..........',
    '..........',
    '....WWW...',
    '..WWWWWW..',
    '.WWWWWWWW.',
    'WWWWWWWWWW',
    'SSSSSSSSSS',
    '..........',
    '..........',
    '..........',
  ],
};

const bunnyHeart: PixelSprite = {
  palette: { P: '#f06fa0', L: '#ffd0e2' },
  grid: [
    '..........',
    '.PP...PP..',
    'PLLP.PLLP.',
    'PLLLPPLLP.',
    'PLLLLLLLP.',
    '.PLLLLLP..',
    '..PLLLP...',
    '...PLP....',
    '....P.....',
    '..........',
  ],
};

// ------------------------------------------------------------------ panda

const bambooGround: PixelSprite = {
  palette: { B: '#b9c0c4', D: '#8a9196', N: '#6f757b' },
  grid: [
    '..........',
    '..........',
    '...B......',
    '..BBB..B..',
    '.BBBBBBBB.',
    'BBBBBBBBBB',
    'DDDDDDDDDD',
  ],
};

/** A single tall stalk. It is an accent, not the ground: repeated, it read as a fence. */
const bambooStalk: PixelSprite = {
  palette: { B: '#b9c0c4', N: '#6f757b', L: '#d7dcdf' },
  grid: [
    '...B...LL.',
    '...B..LLL.',
    '..BBB.LL..',
    '...B......',
    '...B......',
    '..NBN.....',
    '...B......',
    '...B...LL.',
    '..BBB..LL.',
    '...B......',
  ],
};

const bambooLeaf: PixelSprite = {
  palette: { G: '#a8b0b4', D: '#7b8287' },
  grid: [
    '..........',
    '......GG..',
    '....GGGG..',
    '..GGGGG...',
    '.GGGGG....',
    '.GGGG.....',
    '..GGG.....',
    '...GG.....',
    '...D......',
    '..........',
  ],
};

const pawGround: PixelSprite = {
  palette: { P: '#c9ced2', D: '#949a9f' },
  grid: [
    '..........',
    '..PP..PP..',
    '.PPPP.PPPP',
    '.PPPP.PPPP',
    '..PP..PP..',
    '...PPPP...',
    '..PPPPPP..',
    '.PPPPPPPP.',
    '..DDDDDD..',
    '..........',
  ],
};

const pandaPaw: PixelSprite = {
  palette: { P: '#3f4247', D: '#26282c' },
  grid: [
    '..........',
    '..PP...PP.',
    '.PPPP.PPPP',
    '.PPPP.PPPP',
    '..PP...PP.',
    '...PPPP...',
    '..PPPPPP..',
    '.PPPPPPPP.',
    '..DDDDDD..',
    '..........',
  ],
};

// ------------------------------------------------------------------ orca

const waveGround: PixelSprite = {
  palette: { W: '#7fd4f5', D: '#2f86b8', S: '#b6e8fb' },
  grid: [
    '..........',
    '...WW.....',
    '..WWWW..WW',
    '.WWWWWWWWW',
    'WWWWWWWWWW',
    'DDDDDDDDDD',
    'SSSSSSSSSS',
  ],
};

const orcaFish: PixelSprite = {
  palette: { B: '#123a5c', W: '#f4fbff', D: '#0b2239' },
  grid: [
    '..........',
    '.....BBB..',
    '..BBBBBBB.',
    '.BBBBBWBB.',
    'BBBBBBWBB.',
    '.BBBBBWBB.',
    '..BBBBBBB.',
    '.....BBB..',
    '..........',
    '..........',
  ],
};

const orcaBubbles: PixelSprite = {
  palette: { W: '#bfe9fb', S: '#7fd4f5' },
  grid: [
    '..........',
    '...WW.....',
    '..WWWW....',
    '...WW.....',
    '..........',
    '......SS..',
    '.....SSSS.',
    '......SS..',
    '..........',
    '..........',
  ],
};

const orcaStar: PixelSprite = {
  palette: { S: '#ffd166', W: '#fff3cf' },
  grid: [
    '..........',
    '....S.....',
    '....S.....',
    '..S.S.S...',
    '...SSS....',
    '..SSWSS...',
    '...SSS....',
    '..S...S...',
    '..........',
    '..........',
  ],
};

// ---------------------------------------------------------------- ragdoll

const ragdollGround: PixelSprite = {
  palette: { G: '#cfe0c3', D: '#a9c39a', E: '#bcd3ad' },
  grid: [
    '..........',
    '...G......',
    '..GG...G..',
    '..GG..GG..',
    '.GGG..GG..',
    '.GGGGGGG..',
    '.GGGGGGGG.',
    'GGGGGGGGGG',
    'DDDDDDDDDD',
    'EEEEEEEEEE',
  ],
};

const ragdollPaw: PixelSprite = {
  palette: { P: '#c9c2ba', D: '#a79f97', K: '#e58aa6' },
  grid: [
    '..........',
    '..PP...PP.',
    '.PKPP.PPKP',
    '.PPPP.PPPP',
    '..PP...PP.',
    '...PPPP...',
    '..PPPPPP..',
    '.PPKKPPPP.',
    '..DDDDDD..',
    '..........',
  ],
};

const yarn: PixelSprite = {
  palette: { P: '#e58aa6', D: '#c46e8b', L: '#f7c3d3' },
  grid: [
    '..........',
    '...PPPP...',
    '..PLLPPP..',
    '.PLPPPLPP.',
    '.PPPLPPDP.',
    '.PDPPPPDP.',
    '.PPDPPDPP.',
    '..PPDDPP..',
    '...PPPP...',
    '..........',
  ],
};

const ragdollHeart: PixelSprite = {
  palette: { P: '#e58aa6', L: '#f7c3d3' },
  grid: [
    '..........',
    '.PP...PP..',
    'PLLP.PLLP.',
    'PLLLPPLLP.',
    'PLLLLLLLP.',
    '.PLLLLLP..',
    '..PLLLP...',
    '...PLP....',
    '....P.....',
    '..........',
  ],
};

const catNap: PixelSprite = {
  palette: { W: '#e8e0d6', S: '#d5c9bb' },
  grid: [
    '..........',
    '..........',
    '...WWWW...',
    '.WWWWWWWW.',
    'WWWWWWWWWW',
    'SSSSSSSSSS',
    '..........',
    '..........',
    '..........',
    '..........',
  ],
};

// ------------------------------------------------------------------ table

export const MOTIFS: Record<ThemeId, ThemeMotifs> = {
  ragdoll: {
    ground: ragdollGround,
    accents: [ragdollPaw, yarn, ragdollHeart],
    specks: [catNap, ragdollHeart],
  },
  bunny: {
    ground: grassGround,
    accents: [flower, carrot, bunnyHeart],
    specks: [bunnyCloud, bunnyHeart],
  },
  panda: {
    ground: bambooGround,
    accents: [bambooStalk, pandaPaw, bambooLeaf],
    specks: [bambooLeaf, pawGround],
  },
  orca: {
    ground: waveGround,
    accents: [orcaFish, orcaBubbles, orcaStar],
    specks: [orcaBubbles, orcaStar],
  },
};

export function getMotifs(id: ThemeId): ThemeMotifs {
  return MOTIFS[id] ?? MOTIFS.ragdoll;
}

/** The theme's signature mark, used where a single glyph stands in for the theme. */
export function getSignatureMotif(id: ThemeId): PixelSprite {
  const motifs = getMotifs(id);
  return motifs.accents[0] ?? getMascotFor(id);
}

function getMascotFor(id: ThemeId): PixelSprite {
  if (id === 'panda') return pandaSprite;
  if (id === 'orca') return orcaSprite;
  if (id === 'bunny') return bunnySprite;
  return ragdollSprite;
}
