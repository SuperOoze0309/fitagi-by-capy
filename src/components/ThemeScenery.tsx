import { useMemo } from 'react';
import { PixelArt } from './PixelArt';
import { getSignatureMotif } from '../theme/motifs';
import { composeScene } from '../theme/scenery';
import { useApp } from '../state/AppContext';

/**
 * Theme scenery.
 *
 * Decorates a surface with the current theme's own motifs — grass, flowers and
 * carrots for the bunny theme; bamboo for the panda; water for the orca; paws,
 * yarn and hearts for the ragdoll. It is the difference between a theme that
 * recolours the app and one that looks like it was drawn for it.
 *
 * Three rules keep it from becoming noise:
 *
 *  - it is **decorative**: `aria-hidden`, and it never carries information that is
 *    not also in the text next to it;
 *  - it never intercepts a tap (`pointer-events: none`), because it sits under
 *    cards that do things;
 *  - it is deterministic — the same theme always draws the same scene, so it reads
 *    as part of the design rather than as random sprinkle.
 */

interface ThemeSceneryProps {
  /** `strip` sits along the bottom of a card; `inline` is a short mark beside text. */
  variant?: 'strip' | 'inline';
  className?: string;
}

export function ThemeScenery({ variant = 'strip', className }: ThemeSceneryProps) {
  const { settings } = useApp();
  const scene = useMemo(
    () => composeScene(settings.theme, { density: variant === 'strip' ? 'full' : 'ground-only' }),
    [settings.theme, variant],
  );

  if (variant === 'inline') {
    const motif = getSignatureMotif(settings.theme);
    return <PixelArt sprite={motif} size={20} className={className} />;
  }

  return (
    <div className={className ? `scenery ${className}` : 'scenery'} aria-hidden="true">
      {/* The CSS box decides the size: `width: 100%` with `height: auto` keeps the
          pixels square at any width, where a fixed square `size` would letterbox a
          56x16 sprite. */}
      <PixelArt sprite={scene} size={280} className="scenery-art" />
    </div>
  );
}
