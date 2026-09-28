import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bunnySprite, orcaSprite, pandaSprite, ragdollSprite } from '@/theme/mascots';
import { DEFAULT_THEME_ID, THEMES, cssVarsFor, getMascot, getTheme } from '@/theme/tokens';
import { getMotifs, getSignatureMotif } from '@/theme/motifs';
import { SCENE_WIDTH, composeScene } from '@/theme/scenery';
import { DEFAULT_SETTINGS } from '@/repositories/settingsRepository';
import { statusBarIconStyle } from '@/services/nativeShell';
import type { PixelSprite } from '@/theme/pixel';

const SPRITES: [string, PixelSprite][] = [
  ['ragdoll', ragdollSprite],
  ['bunny', bunnySprite],
  ['panda', pandaSprite],
  ['orca', orcaSprite],
];

/**
 * The mascots are data, so they can be validated like data. A ragged grid or a
 * palette key with no colour renders a hole in the sprite, which is easy to miss
 * by eye and trivial to catch here.
 */
describe('pixel mascots', () => {
  it('has a sprite for every theme', () => {
    for (const theme of THEMES) {
      const sprite = getMascot(theme.id);
      assert.ok(sprite.grid.length > 0, `${theme.id} has no sprite`);
    }
  });

  it('is a well-formed grid', () => {
    for (const [name, sprite] of SPRITES) {
      assert.ok(sprite.grid.length >= 8, `${name} grid is too small to read as art`);
      const width = sprite.grid[0]!.length;
      for (const [index, row] of sprite.grid.entries()) {
        assert.equal(row.length, width, `${name} row ${index} is ${row.length}, expected ${width}`);
      }
      assert.equal(width, sprite.grid.length, `${name} should be square at this size`);
    }
  });

  it('uses only palette keys that exist', () => {
    for (const [name, sprite] of SPRITES) {
      for (const [index, row] of sprite.grid.entries()) {
        for (const char of row) {
          if (char === '.') continue;
          assert.ok(
            Object.prototype.hasOwnProperty.call(sprite.palette, char),
            `${name} row ${index} uses "${char}", which has no colour`,
          );
        }
      }
    }
  });

  it('draws something substantial rather than a few stray pixels', () => {
    for (const [name, sprite] of SPRITES) {
      const filled = sprite.grid.join('').replace(/\./g, '').length;
      assert.ok(filled > 80, `${name} only has ${filled} pixels filled`);
    }
  });

  it('outlines the silhouette rather than leaving it open', () => {
    // A pixel character reads best with a dark outline around the body, so every
    // sprite has to use the outline key for more than a stray pixel.
    for (const [name, sprite] of SPRITES) {
      const outlinePixels = sprite.grid.join('').split('L').length - 1;
      assert.ok(outlinePixels >= 20, `${name} has only ${outlinePixels} outline pixels`);
    }
  });

  it('uses colours that are valid CSS', () => {
    for (const [name, sprite] of SPRITES) {
      for (const [key, colour] of Object.entries<string>(sprite.palette)) {
        assert.match(colour, /^#[0-9a-fA-F]{3,8}$/, `${name}.${key} is not a hex colour`);
      }
    }
  });

  it('keeps the panda monochrome as specified', () => {
    // Theme B is deliberately black and white, so its palette must stay neutral.
    for (const colour of Object.values<string>(pandaSprite.palette)) {
      const hex = colour.replace('#', '');
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      assert.ok(spread <= 8, `${colour} is not neutral (spread ${spread})`);
    }
  });
});

describe('theme tokens', () => {
  it('defines every token for every theme', () => {
    const expected = [
      '--bg',
      '--bg-elevated',
      '--bg-input',
      '--bg-hover',
      '--surface-secondary',
      '--border',
      '--border-strong',
      '--text',
      '--text-muted',
      '--text-faint',
      '--accent',
      '--accent-alt',
      '--accent-text',
      '--accent-soft',
      '--primary',
      '--on-primary',
      '--success',
      '--warn',
      '--danger',
    ];
    for (const theme of THEMES) {
      const vars = cssVarsFor(theme);
      for (const name of expected) {
        assert.ok(vars[name], `${theme.id} is missing ${name}`);
      }
    }
  });

  it('ships four themes, ready for a fifth', () => {
    assert.deepEqual(
      THEMES.map((theme) => theme.id),
      ['ragdoll', 'bunny', 'panda', 'orca'],
    );
    // The app's own mascot leads, so a fresh install matches the launcher icon.
    assert.equal(DEFAULT_THEME_ID, 'ragdoll');
    // A theme is data: a new one only needs an id, a palette and a mascot.
    for (const theme of THEMES) {
      assert.ok(theme.nameKey.startsWith('theme.'));
      assert.ok(theme.hintKey.startsWith('theme.'));
      assert.equal(theme.swatch.length, 3);
    }
  });

  it('gives each theme a distinguishable primary colour', () => {
    const primaries = THEMES.map((theme) => theme.tokens.primary);
    assert.equal(new Set(primaries).size, primaries.length);
  });

  it('falls back to the default theme for an unknown id', () => {
    assert.equal(getTheme('bunny' as never).id, 'bunny');
    assert.equal(getTheme('neon' as never).id, DEFAULT_THEME_ID);
  });

  it('keeps the stored default in step with the theme list', () => {
    // The repository cannot import the theme layer, so the two defaults are written
    // out separately; this is what stops them drifting apart.
    assert.equal(DEFAULT_SETTINGS.theme, DEFAULT_THEME_ID);
    assert.ok(
      THEMES.some((theme) => theme.id === DEFAULT_SETTINGS.theme),
      'the stored default must be a theme that actually ships',
    );
  });

  it('has readable contrast between text and background in every theme', () => {
    // A quick luminance ratio check: a themed palette that puts dark text on a
    // dark background is unusable, and this catches it without a screenshot.
    const luminance = (hex: string): number => {
      const clean = hex.replace('#', '');
      const channels = [0, 2, 4].map((offset) => {
        const value = parseInt(clean.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };
    const ratio = (a: string, b: string) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light! + 0.05) / (dark! + 0.05);
    };

    for (const theme of THEMES) {
      const textOnSurface = ratio(theme.tokens.textPrimary, theme.tokens.surface);
      assert.ok(textOnSurface >= 7, `${theme.id} body text contrast is ${textOnSurface.toFixed(1)}`);
      const textOnBackground = ratio(theme.tokens.textPrimary, theme.tokens.background);
      assert.ok(textOnBackground >= 7, `${theme.id} text/background is ${textOnBackground.toFixed(1)}`);
      const mutedOnSurface = ratio(theme.tokens.textSecondary, theme.tokens.surface);
      assert.ok(mutedOnSurface >= 4, `${theme.id} muted text contrast is ${mutedOnSurface.toFixed(1)}`);
    }
  });

  it('picks status bar icons that stay readable on each theme bar', () => {
    // The status bar colour cannot be checked without a device, but the decision it
    // drives can: light bars need dark icons and dark bars need light ones. Ragdoll,
    // bunny and panda are light themes, orca is the dark one.
    const expected: Record<string, 'light' | 'dark'> = {
      ragdoll: 'dark',
      bunny: 'dark',
      panda: 'dark',
      orca: 'light',
    };
    for (const theme of THEMES) {
      const colour = theme.tokens.statusBar;
      assert.match(colour, /^#[0-9a-f]{6}$/i, `${theme.id} status bar colour is not a hex value`);
      assert.equal(statusBarIconStyle(colour), expected[theme.id], `${theme.id} status bar icons`);
    }
    assert.equal(statusBarIconStyle('#ffffff'), 'dark');
    assert.equal(statusBarIconStyle('#101319'), 'light');
    // Anything unparsable must not produce unreadable icons on a light bar.
    assert.equal(statusBarIconStyle('not-a-colour'), 'dark');
  });
});

/**
 * The scenery is data too, and it is composed at runtime, so the composition is
 * where a mistake would hide: a merged palette with a two-character key would
 * render as nothing at all rather than as something obviously wrong.
 */
describe('theme motifs and scenery', () => {
  it('gives every theme a vocabulary of its own', () => {
    for (const theme of THEMES) {
      const motifs = getMotifs(theme.id);
      assert.ok(motifs.ground.grid.length > 0, `${theme.id} has no ground`);
      assert.ok(motifs.accents.length >= 2, `${theme.id} has too few accents`);
      assert.ok(motifs.specks.length >= 1, `${theme.id} has no specks`);
      assert.ok(getSignatureMotif(theme.id).grid.length > 0);
    }
    // The motifs belong to the theme rather than being shared: a bunny scene and an
    // orca scene must not be the same drawing.
    const signatures = THEMES.map((theme) => JSON.stringify(getMotifs(theme.id).accents[0]));
    assert.equal(new Set(signatures).size, signatures.length);
  });

  it('composes a scene whose palette keys are all one character', () => {
    for (const theme of THEMES) {
      const scene = composeScene(theme.id);
      assert.equal(scene.grid.length, 16, `${theme.id} scene height`);
      for (const row of scene.grid) {
        assert.equal(row.length, SCENE_WIDTH, `${theme.id} scene row width`);
      }
      for (const [key, colour] of Object.entries(scene.palette)) {
        // A grid row is a string, so a longer key can never be addressed.
        assert.equal(key.length, 1, `${theme.id} has a multi-character palette key "${key}"`);
        assert.match(colour, /^(#[0-9a-f]{3,8}|rgba?\()/i, `${theme.id} colour ${colour}`);
      }
      // Every non-transparent cell must resolve to a colour, or it renders as a hole.
      const missing = new Set<string>();
      for (const row of scene.grid) {
        for (const key of row) {
          if (key !== '.' && !scene.palette[key]) missing.add(key);
        }
      }
      assert.deepEqual([...missing], [], `${theme.id} scene has unresolvable pixels`);
    }
  });

  it('draws the ground across the whole scene, so a strip never stops halfway', () => {
    for (const theme of THEMES) {
      const scene = composeScene(theme.id);
      const bottom = scene.grid[scene.grid.length - 1]!;
      assert.ok(
        !bottom.includes('.'),
        `${theme.id} ground has a gap at the bottom edge`,
      );
    }
  });

  it('draws a shorter scene when the specks are dropped', () => {
    const full = composeScene('bunny');
    const groundOnly = composeScene('bunny', { density: 'ground-only' });
    assert.equal(groundOnly.grid.length, full.grid.length);
    const ink = (sprite: PixelSprite) =>
      sprite.grid.join('').split('').filter((key) => key !== '.').length;
    assert.ok(
      ink(groundOnly) < ink(full),
      'dropping the specks must remove pixels, not merely recolour them',
    );
  });
});
