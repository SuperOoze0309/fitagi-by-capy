import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Settings, UserProfile } from '../domain/types';
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '../repositories/settingsRepository';
import { repositories } from '../repositories';
import { getStorage } from '../storage';
import {
  CATALOGUES,
  createTranslator,
  detectSystemLocale,
  isLocale,
  type Locale,
  type Translator,
} from '../i18n';
import { applyTheme } from '../theme/tokens';
import { setActiveLocale } from '../i18n/runtime';
import { applyStatusBarForTheme, installBackButtonHandler } from '../services/nativeShell';
import { reminderScheduler } from '../services/reminderScheduler';

interface AppContextValue {
  settings: Settings;
  profile: UserProfile;
  /**
   * False until the stored preferences have been read.
   *
   * Screens that branch on a preference must wait for this: before it flips, the
   * context still holds `DEFAULT_SETTINGS`, and a default is not a decision the user
   * made. The onboarding gate is the case that matters — it is `null` by default, so
   * without this the welcome branch renders on every boot.
   */
  ready: boolean;
  storageLabel: string;
  storageKind: 'indexeddb' | 'sqlite';
  /** Update preferences and apply them immediately. */
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  updateProfile: (patch: Partial<UserProfile>) => Promise<void>;
  reloadSettings: () => Promise<void>;
  /** The locale actually in effect, after resolving `system`. */
  locale: Locale;
  /** `t`, `tPlural` and the Intl tag for this locale. */
  i18n: Translator;
  /** Switch language; the change is visible without a reload. */
  setLanguage: (preference: Settings['language']) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

/**
 * App-wide state: preferences, the resolved language, and the profile.
 *
 * Pages read everything else from the repositories per screen, which keeps page
 * code obvious. What lives here is only what many screens need *and* what must
 * react instantly when it changes — the theme, the language and the profile.
 */
export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [profile, setProfile] = useState<UserProfile>(EMPTY_PROFILE);
  /** False until the stored preferences have been read, so effects can wait. */
  const [ready, setReady] = useState(false);
  const [storageInfo, setStorageInfo] = useState<{
    label: string;
    kind: 'indexeddb' | 'sqlite';
  }>({ label: '', kind: 'indexeddb' });

  /**
   * The resolved locale.
   *
   * `system` is resolved on every render rather than stored, so a device-language
   * change is picked up without a migration, and a user who explicitly chose a
   * language keeps it forever.
   */
  const locale: Locale = useMemo(() => {
    if (isLocale(settings.language)) return settings.language;
    return detectSystemLocale();
  }, [settings.language]);

  const i18n = useMemo(() => createTranslator(locale), [locale]);

  const reloadSettings = useCallback(async () => {
    const repos = repositories();
    const [loadedSettings, loadedProfile] = await Promise.all([
      repos.settings.ensureInitialized(),
      repos.profile.get(),
    ]);
    setSettings(loadedSettings);
    setProfile(loadedProfile);
    setReady(true);
  }, []);

  useEffect(() => {
    void reloadSettings();
    const storage = getStorage();
    setStorageInfo({ label: storage.adapter.label, kind: storage.adapter.kind });
  }, [reloadSettings]);

  // The theme is applied straight to the document, so a change is instant and no
  // component has to re-render to pick it up. On Android the status bar follows it.
  useEffect(() => {
    applyTheme(settings.theme);
    void applyStatusBarForTheme(settings.theme);
  }, [settings.theme]);

  // The hardware back button closes a sheet before it leaves the screen it is on.
  useEffect(() => installBackButtonHandler(), []);

  /**
   * Re-assert the reminder schedule once the app is up.
   *
   * The operating system owns the schedule and the app owns the list, so they drift
   * on their own: a reboot that dropped the alarms, a permission granted since the
   * reminders were created, a restore from a backup. One rebuild on launch is
   * cheaper than tracking every way they can diverge, and it is idempotent.
   */
  useEffect(() => {
    if (!ready) return;
    void reminderScheduler()
      .sync()
      .catch((error: unknown) => console.warn('[reminders] initial sync failed', error));
  }, [ready]);

  // Keep the document language in step for screen readers and font selection,
  // and mirror it for the crash screen, which renders outside this provider.
  useEffect(() => {
    setActiveLocale(locale);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  /**
   * Apply a preference change on the spot, then persist it.
   *
   * The local state is merged on the same tick instead of waiting for the write to
   * return: the settings screen writes on every keystroke, and reading the value
   * back a moment later makes a text field feel like it is fighting the typist.
   * The store remains authoritative — that is what a reload reads — and its own
   * patch queue keeps a burst of edits from overwriting one another.
   */
  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    await repositories().settings.patch(patch);
  }, []);

  const setLanguage = useCallback(
    async (preference: Settings['language']) => {
      await updateSettings({ language: preference });
    },
    [updateSettings],
  );

  const updateProfile = useCallback(async (patch: Partial<UserProfile>) => {
    setProfile((current) => ({ ...current, ...patch }));
    await repositories().profile.patch(patch);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      settings,
      profile,
      ready,
      storageLabel: storageInfo.label,
      storageKind: storageInfo.kind,
      updateSettings,
      updateProfile,
      reloadSettings,
      locale,
      i18n,
      setLanguage,
    }),
    [
      settings,
      profile,
      ready,
      storageInfo,
      updateSettings,
      updateProfile,
      reloadSettings,
      locale,
      i18n,
      setLanguage,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}

/**
 * Translation helper for components.
 *
 * `const { t } = useI18n()` — the returned translator is memoised per locale, so
 * an unchanged language re-renders nothing.
 */
export function useI18n(): Translator & { locale: Locale } {
  const { i18n, locale } = useApp();
  return useMemo(() => ({ ...i18n, locale }), [i18n, locale]);
}

/** Locale-aware date and number formatting. */
export function useIntl(): string {
  const { locale } = useApp();
  return CATALOGUES[locale].intlTag;
}
