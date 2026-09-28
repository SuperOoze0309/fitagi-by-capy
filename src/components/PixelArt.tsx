import type { CSSProperties } from 'react';
import type { PixelSprite } from '../theme/pixel';

export type { Palette, PixelSprite } from '../theme/pixel';

/**
 * Pixel-art renderer.
 *
 * The mascots are drawn as character grids rather than hand-written `<rect>`
 * lists: a sprite stays editable in code, diffs sensibly, needs no binary asset
 * and no base64 blob, and ships as part of the bundle. `.` means transparent.
 *
 * `shapeRendering="crispEdges"` keeps the pixels sharp at every size, which is the
 * whole point of the style.
 */
interface PixelArtProps {
  sprite: PixelSprite;
  /** Rendered size in CSS pixels; the sprite scales to fit. */
  size?: number;
  /** Accessible label. Omit for decorative use. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function PixelArt({ sprite, size = 32, title, className, style }: PixelArtProps) {
  const rows = sprite.grid;
  const height = rows.length;
  const width = Math.max(...rows.map((row) => row.length));

  const rects: { x: number; y: number; fill: string; key: string }[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const key = row[x]!;
      if (key === '.' || key === ' ') continue;
      const fill = sprite.palette[key];
      if (!fill) continue;
      rects.push({ x, y, fill, key: `${x}-${y}` });
    }
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className}
      style={style}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {rects.map((rect) => (
        <rect key={rect.key} x={rect.x} y={rect.y} width={1} height={1} fill={rect.fill} />
      ))}
    </svg>
  );
}
