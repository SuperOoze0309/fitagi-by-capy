/**
 * Pixel-sprite data model.
 *
 * Kept in its own module rather than in the renderer so that the sprite data
 * (`theme/mascots.ts`) and the theme tokens can reference the type without pulling
 * a `.tsx` file into contexts that do not compile JSX.
 */

export type Palette = Record<string, string>;

export interface PixelSprite {
  /** Rows of single-character palette keys; `.` is transparent. */
  grid: string[];
  palette: Palette;
}
