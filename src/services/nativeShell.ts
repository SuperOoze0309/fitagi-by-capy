import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import type { ThemeId } from '../domain/types';
import { statusBarColor } from '../theme/tokens';

/**
 * The two places where the web app has to talk to the Android shell.
 *
 * Both are guarded by `Capacitor.isNativePlatform()` and by try/catch: the browser
 * build has no status bar and no hardware back button, and a plugin can be absent
 * from an older native project. Neither is allowed to break the launch path.
 */

/** Relative luminance (WCAG) of a `#rrggbb` colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 1;
  const value = Number.parseInt(match[1]!, 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/**
 * Which icon colour a status bar of `hex` needs.
 *
 * Exported and separate from the plugin call so the decision itself is unit
 * tested: it is the part that cannot be checked without a device.
 */
export function statusBarIconStyle(hex: string): 'light' | 'dark' {
  return luminance(hex) > 0.5 ? 'dark' : 'light';
}

/**
 * Paint the Android status bar to match the current theme.
 *
 * The icon style is derived from the colour rather than hardcoded per theme, so a
 * fourth theme gets a readable status bar without touching this function: a light
 * bar gets dark icons and a dark bar gets light ones.
 */
export async function applyStatusBarForTheme(theme: ThemeId): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const color = statusBarColor(theme);
  try {
    await StatusBar.setBackgroundColor({ color });
    await StatusBar.setStyle({
      // Capacitor's enum names the *background* the style is for: `Style.Light`
      // means dark text on a light bar.
      style: statusBarIconStyle(color) === 'dark' ? Style.Light : Style.Dark,
    });
  } catch (error) {
    console.warn('[native] status bar not updated', error);
  }
}

/**
 * Route the Android hardware back button through the app's own rules.
 *
 * Adding the listener takes over Capacitor's default, so all three cases are
 * handled here: a sheet closes first (the sheet already treats Escape as "close"),
 * then the router goes back, and only at the very start does the app exit.
 *
 * Returns a disposer so a hot reload or a remount does not stack listeners.
 */
export function installBackButtonHandler(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};

  let disposed = false;
  let remove: (() => void) | null = null;

  void App.addListener('backButton', () => {
    if (document.querySelector('.overlay')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return;
    }
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    void App.exitApp();
  })
    .then((handle) => {
      if (disposed) void handle.remove();
      else remove = () => void handle.remove();
    })
    .catch((error: unknown) => {
      console.warn('[native] back button not intercepted', error);
    });

  return () => {
    disposed = true;
    remove?.();
  };
}
