import type { ThemeId } from '../domain/types';
import { bunnySprite, orcaSprite, pandaSprite, ragdollSprite } from './mascots';
import type { PixelSprite } from './pixel';

/**
 * Theme tokens.
 *
 * Components never reference a raw colour and never branch on the theme id; they
 * use these tokens, which are published as CSS custom properties on `:root` by
 * `applyTheme()`. Adding Theme D is therefore a new entry in `THEMES` plus a
 * mascot — no page or component changes.
 *
 * Token names are the contract. `cssVarsFor()` maps them onto the `--*` names the
 * stylesheet already uses, which is why existing CSS kept working through the
 * switch from a light/dark pair to named themes.
 */
export interface ThemeTokens {
  /** Page background. */
  background: string;
  /** Cards and sheets sitting on the background. */
  surface: string;
  /** Slightly recessed surface, e.g. an exercise header strip. */
  surfaceSecondary: string;
  /** Input and control backgrounds. */
  field: string;
  /** Hover / pressed state. */
  hover: string;
  textPrimary: string;
  textSecondary: string;
  textFaint: string;
  primary: string;
  /** Text/icon colour placed on top of `primary`. */
  onPrimary: string;
  secondary: string;
  accent: string;
  /** Translucent accent for selected rows and chart fills. */
  accentSoft: string;
  border: string;
  borderStrong: string;
  success: string;
  warning: string;
  error: string;
  /** Colour used for the browser/Android status bar. */
  statusBar: string;
}

export interface ThemeDefinition {
  id: ThemeId;
  /** Translation key for the display name, so the picker is localised. */
  nameKey: 'theme.ragdoll' | 'theme.bunny' | 'theme.panda' | 'theme.orca';
  /** Translation key for the one-line description. */
  hintKey:
    | 'theme.ragdollHint'
    | 'theme.bunnyHint'
    | 'theme.pandaHint'
    | 'theme.orcaHint';
  /** Swatch colours shown in the picker (primary, accent, background). */
  swatch: [string, string, string];
  tokens: ThemeTokens;
}

/**
 * Theme A — bunny. Soft pinks with a blue accent; light background.
 */
const BUNNY: ThemeDefinition = {
  id: 'bunny',
  nameKey: 'theme.bunny',
  hintKey: 'theme.bunnyHint',
  swatch: ['#f06fa0', '#4f7fe0', '#fff6f9'],
  tokens: {
    background: '#fff6f9',
    surface: '#ffffff',
    surfaceSecondary: '#ffe9f1',
    field: '#ffffff',
    hover: '#ffeef4',
    textPrimary: '#3a2530',
    textSecondary: '#7d6070',
    textFaint: '#a98c9a',
    primary: '#f06fa0',
    onPrimary: '#ffffff',
    secondary: '#4f7fe0',
    accent: '#4f7fe0',
    accentSoft: 'rgba(79, 127, 224, 0.14)',
    border: '#f5d9e4',
    borderStrong: '#e7bfd0',
    success: '#2f9e5f',
    warning: '#c98a1a',
    error: '#d64562',
    statusBar: '#fff6f9',
  },
};

/**
 * Theme B — panda. High-contrast black on white, deliberately monochrome.
 */
const PANDA: ThemeDefinition = {
  id: 'panda',
  nameKey: 'theme.panda',
  hintKey: 'theme.pandaHint',
  swatch: ['#1c1c1e', '#6f7276', '#ffffff'],
  tokens: {
    background: '#f4f4f6',
    surface: '#ffffff',
    surfaceSecondary: '#ececee',
    field: '#ffffff',
    hover: '#f0f0f2',
    textPrimary: '#141416',
    textSecondary: '#5c5f63',
    textFaint: '#8e9196',
    primary: '#1c1c1e',
    onPrimary: '#ffffff',
    secondary: '#6f7276',
    accent: '#3f4247',
    accentSoft: 'rgba(28, 28, 30, 0.10)',
    border: '#dededf',
    borderStrong: '#c2c3c6',
    success: '#2f8f4e',
    warning: '#a9741a',
    error: '#c0392b',
    statusBar: '#ffffff',
  },
};

/**
 * Theme C — orca. Deep ocean blues with the animal's white markings as the
 * accent, which keeps it readable in both the header and the chart.
 */
const ORCA: ThemeDefinition = {
  id: 'orca',
  nameKey: 'theme.orca',
  hintKey: 'theme.orcaHint',
  swatch: ['#0b2239', '#4fc3f7', '#f2f7fb'],
  tokens: {
    background: '#eef4fa',
    surface: '#ffffff',
    surfaceSecondary: '#dce9f5',
    field: '#ffffff',
    hover: '#e4eef8',
    textPrimary: '#0b2239',
    textSecondary: '#43617d',
    textFaint: '#7d95ab',
    primary: '#0b2239',
    onPrimary: '#ffffff',
    secondary: '#2b6ca3',
    accent: '#1f6fb2',
    accentSoft: 'rgba(31, 111, 178, 0.14)',
    border: '#cbdeed',
    borderStrong: '#a6c4da',
    success: '#1f8a5b',
    warning: '#b3760f',
    error: '#c93a3a',
    statusBar: '#0b2239',
  },
};

/**
 * Theme D — ragdoll. The app's own mascot, and the theme that matches the launcher
 * icon: warm paper white, soft grey fur, blue eyes (that is what makes a ragdoll a
 * ragdoll) and the pink of its nose and the little heart in the artwork.
 */
const RAGDOLL: ThemeDefinition = {
  id: 'ragdoll',
  nameKey: 'theme.ragdoll',
  hintKey: 'theme.ragdollHint',
  swatch: ['#7c9cbf', '#e58aa6', '#faf8f5'],
  tokens: {
    background: '#faf8f5',
    surface: '#ffffff',
    surfaceSecondary: '#f1ece6',
    field: '#ffffff',
    hover: '#f5f1ec',
    textPrimary: '#33302c',
    textSecondary: '#6f6862',
    textFaint: '#a39a92',
    primary: '#7c9cbf',
    onPrimary: '#ffffff',
    secondary: '#a89a90',
    accent: '#d97fa2',
    accentSoft: 'rgba(217, 127, 162, 0.14)',
    border: '#e7e1da',
    borderStrong: '#cec5ba',
    success: '#3f9e6b',
    warning: '#c08a2a',
    error: '#cf5a5a',
    statusBar: '#faf8f5',
  },
};

/**
 * Every theme, in picker order.
 *
 * Adding one is exactly this: a palette plus a mascot plus a motif set. Nothing in
 * a page, a component or the stylesheet knows the names of these themes.
 */
export const THEMES: ThemeDefinition[] = [RAGDOLL, BUNNY, PANDA, ORCA];

export const DEFAULT_THEME_ID: ThemeId = RAGDOLL.id;

/** The pixel mascot belonging to each theme, kept beside the palette it matches. */
export const MASCOTS: Record<ThemeId, PixelSprite> = {
  ragdoll: ragdollSprite,
  bunny: bunnySprite,
  panda: pandaSprite,
  orca: orcaSprite,
};

export function getTheme(id: ThemeId): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? RAGDOLL;
}

export function getMascot(id: ThemeId): PixelSprite {
  return MASCOTS[id] ?? bunnySprite;
}

/**
 * Map tokens onto the CSS custom properties the stylesheet uses.
 *
 * Keeping the mapping in one function is what lets the existing CSS survive: the
 * variable names never change, only the values behind them.
 */
export function cssVarsFor(theme: ThemeDefinition): Record<string, string> {
  const t = theme.tokens;
  return {
    '--bg': t.background,
    '--bg-elevated': t.surface,
    '--bg-input': t.field,
    '--bg-hover': t.hover,
    '--surface-secondary': t.surfaceSecondary,
    '--border': t.border,
    '--border-strong': t.borderStrong,
    '--text': t.textPrimary,
    '--text-muted': t.textSecondary,
    '--text-faint': t.textFaint,
    '--accent': t.accent,
    '--accent-alt': t.secondary,
    '--accent-text': t.onPrimary,
    '--accent-soft': t.accentSoft,
    '--primary': t.primary,
    '--on-primary': t.onPrimary,
    '--success': t.success,
    '--warn': t.warning,
    '--danger': t.error,
  };
}

/** Paint a theme onto the document and keep the status bar in step. */
export function applyTheme(id: ThemeId): ThemeDefinition {
  const theme = getTheme(id);
  if (typeof document === 'undefined') return theme;

  const root = document.documentElement;
  const vars = cssVarsFor(theme);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.dataset['theme'] = theme.id;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.tokens.statusBar);

  return theme;
}

/** Browser/Android chrome colour for a theme, used before React mounts. */
export function statusBarColor(id: ThemeId): string {
  return getTheme(id).tokens.statusBar;
}
