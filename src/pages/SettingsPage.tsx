import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ConfirmDialog } from '../components/Sheet';
import { Field, PageHeader, Segmented, Switch } from '../components/ui';
import { PixelArt } from '../components/PixelArt';
import type { Settings } from '../domain/types';
import { APP_VERSION } from '../domain/types';
import { LOCALES, LOCALE_LABELS, type Locale, type MessageKey } from '../i18n';
import { THEMES, getMascot } from '../theme/tokens';
import { detectVisionSupport, visionMessageKey } from '../services/ai/vision';
import { notificationPermissionState, type PermissionState } from '../services/reminders';
import { repositories } from '../repositories';
import { useApp, useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';

/**
 * Settings.
 *
 * The three pickers here are deliberately independent, because they answer three
 * unrelated questions: what unit to show, how the app looks, and what language it
 * speaks. In particular the theme picker changes colours and the mascot only —
 * gender lives on the profile screen and is AI context, never presentation.
 */
export function SettingsPage() {
  const { settings, storageLabel, updateSettings } = useApp();
  const { t, locale } = useI18n();
  const toast = useToast();
  const [confirmReset, setConfirmReset] = useState(false);
  /** Shown next to the reminders link, so the state is visible where it matters. */
  const [notificationNote, setNotificationNote] = useState<PermissionState>('prompt');

  useEffect(() => {
    void notificationPermissionState().then(setNotificationNote);
  }, []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    void updateSettings({ [key]: value } as Partial<Settings>);
  };

  const capability = detectVisionSupport(settings.aiModel, settings.aiVisionOverride);

  return (
    <>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <main className="app-main">
        <div className="page">
          <div className="section-title">
            <span>{t('settings.language')}</span>
          </div>
          <div className="card">
            <Field label={t('settings.language')} htmlFor="language" hint={t('settings.languageHint')}>
              <Segmented
                ariaLabel={t('settings.language')}
                value={settings.language}
                options={[
                  { value: 'system', label: t('app.followSystem') },
                  ...LOCALES.map((code) => ({ value: code, label: LOCALE_LABELS[code] })),
                ]}
                onChange={(value) => void updateSettings({ language: value })}
              />
            </Field>
            <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
              {t('settings.language')}: {LOCALE_LABELS[locale]}
            </p>
          </div>

          <div className="section-title">
            <span>{t('settings.units')}</span>
          </div>
          <div className="card">
            <div className="row-between row-wrap">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t('settings.defaultUnit')}</div>
                <div className="small muted">{t('settings.defaultUnitHint')}</div>
              </div>
              <Segmented
                ariaLabel={t('settings.defaultUnit')}
                value={settings.defaultUnit}
                options={[
                  { value: 'kg', label: 'kg' },
                  { value: 'lb', label: 'lb' },
                ]}
                onChange={(value) => set('defaultUnit', value)}
              />
            </div>
          </div>

          <div className="section-title">
            <span>{t('settings.appearance')}</span>
          </div>
          <div className="card">
            <div style={{ fontWeight: 600 }}>{t('settings.theme')}</div>
            <p className="small muted" style={{ margin: 'var(--space-1) 0 var(--space-3)' }}>
              {t('settings.themeHint')}
            </p>
            <div className="theme-options">
              {THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  className="theme-option"
                  data-active={theme.id === settings.theme}
                  aria-pressed={theme.id === settings.theme}
                  aria-label={t(theme.nameKey)}
                  onClick={() => set('theme', theme.id)}
                >
                  <PixelArt
                    sprite={getMascot(theme.id)}
                    size={48}
                    title={t('theme.mascotAlt', { name: t(theme.nameKey) })}
                  />
                  <span className="theme-name">{t(theme.nameKey)}</span>
                  <span className="theme-hint">{t(theme.hintKey)}</span>
                  <span className="theme-swatch" aria-hidden="true">
                    {theme.swatch.map((colour) => (
                      <span key={colour} style={{ background: colour }} />
                    ))}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="section-title">
            <span>{t('settings.aiSection')}</span>
          </div>
          <div className="card">
            <div className="row-between">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t('settings.enableAi')}</div>
                <div className="small muted">{t('settings.enableAiHint')}</div>
              </div>
              <Switch
                label={t('settings.enableAi')}
                checked={settings.aiEnabled}
                onChange={(checked) => set('aiEnabled', checked)}
              />
            </div>

            {settings.aiEnabled ? (
              <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
                <Field label={t('settings.baseUrl')} htmlFor="ai-base-url" hint={t('settings.baseUrlHint')}>
                  <input
                    id="ai-base-url"
                    className="input"
                    placeholder="https://api.openai.com/v1"
                    value={settings.aiBaseUrl}
                    onChange={(event) => set('aiBaseUrl', event.target.value)}
                  />
                </Field>
                <Field label={t('settings.apiKey')} htmlFor="ai-key" hint={t('settings.apiKeyHint')}>
                  <input
                    id="ai-key"
                    className="input"
                    type="password"
                    placeholder="sk-…"
                    value={settings.aiApiKey}
                    onChange={(event) => set('aiApiKey', event.target.value)}
                  />
                </Field>
                <Field label={t('settings.model')} htmlFor="ai-model">
                  <input
                    id="ai-model"
                    className="input"
                    placeholder={t('settings.modelPlaceholder')}
                    value={settings.aiModel}
                    onChange={(event) => set('aiModel', event.target.value)}
                  />
                </Field>

                {/*
                  Vision support is reported as a capability, not enforced as a
                  rule: "unknown" lets the user try, and only a model the app is
                  confident about being text-only is flagged.
                */}
                <div className="card" style={{ background: 'var(--surface-secondary)' }}>
                  <div className="row-between">
                    <div style={{ fontWeight: 600 }}>{t('settings.visionSupport')}</div>
                    <span
                      className={
                        capability.support === 'supported'
                          ? 'badge live'
                          : capability.support === 'unsupported'
                            ? 'badge warn'
                            : 'badge neutral'
                      }
                    >
                      {capability.support}
                    </span>
                  </div>
                  <p className="small muted" style={{ margin: 'var(--space-1) 0 0' }}>
                    {t(visionMessageKey(capability) as MessageKey)}
                  </p>
                  <div className="row-between" style={{ marginTop: 'var(--space-2)' }}>
                    <div className="small">{t('settings.visionOverride')}</div>
                    <Switch
                      label={t('settings.visionOverride')}
                      checked={settings.aiVisionOverride === true}
                      onChange={(checked) => set('aiVisionOverride', checked ? true : null)}
                    />
                  </div>
                  <p className="small faint" style={{ margin: 'var(--space-1) 0 0' }}>
                    {t('settings.visionOverrideHint')}
                  </p>
                </div>

                <div className="row-between row-wrap">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{t('settings.defaultRole')}</div>
                    <div className="small muted">{t('settings.defaultRoleHint')}</div>
                  </div>
                  <Segmented
                    ariaLabel={t('settings.defaultRole')}
                    value={settings.aiRole}
                    options={[
                      { value: 'recorder', label: t('ai.roleRecorder') },
                      { value: 'reminder', label: t('ai.roleReminder') },
                      { value: 'coach', label: t('ai.roleCoach') },
                    ]}
                    onChange={(value) => set('aiRole', value)}
                  />
                </div>

                <div className="banner">{t('settings.aiPrivacy')}</div>
              </div>
            ) : null}
          </div>

          <div className="section-title">
            <span>{t('settings.dataSection')}</span>
          </div>
          <div className="card">
            <div className="row-between">
              <div style={{ fontWeight: 600 }}>{t('settings.storageEngine')}</div>
              <span className="badge neutral">{storageLabel || '…'}</span>
            </div>
            <p className="small muted" style={{ margin: 'var(--space-2) 0 0' }}>
              {t('settings.storageNote')}
            </p>
          </div>

          {/*
            Plans and reminders are in the navigation, but the bottom bar only has
            five slots and reminders is not one of them — on a phone this is the only
            way to reach it.
          */}
          <div className="card">
            <div className="row-between">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t('settings.plansLink')}</div>
                <div className="small muted">{t('settings.plansHint')}</div>
              </div>
              <Link className="btn btn-sm" to="/plans">
                {t('common.open')}
              </Link>
            </div>
          </div>

          <div className="card">
            <div className="row-between">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t('settings.remindersLink')}</div>
                <div className="small muted">
                  {notificationNote === 'granted'
                    ? t('reminders.permissionGranted')
                    : t('settings.remindersHint')}
                </div>
              </div>
              <Link className="btn btn-sm" to="/reminders">
                {t('common.open')}
              </Link>
            </div>
          </div>

          <div className="card">
            <div className="row-between">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t('settings.profileLink')}</div>
                <div className="small muted">{t('settings.profileHint')}</div>
              </div>
              <Link className="btn btn-sm" to="/profile">
                {t('common.open')}
              </Link>
            </div>
          </div>

          <div className="card">
            <div className="row-between">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t('settings.backup')}</div>
                <div className="small muted">{t('settings.backupHint')}</div>
              </div>
              <Link className="btn btn-sm" to="/data">
                {t('common.open')}
              </Link>
            </div>
          </div>

          <div className="card">
            <div className="row-between">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t('settings.summariesLink')}</div>
                <div className="small muted">{t('settings.summariesHint')}</div>
              </div>
              <Link className="btn btn-sm" to="/summaries">
                {t('common.open')}
              </Link>
            </div>
          </div>

          <div className="card">
            <div className="row-between">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{t('settings.rulesLink')}</div>
                <div className="small muted">{t('settings.rulesHint')}</div>
              </div>
              <Link className="btn btn-sm" to="/rules">
                {t('common.manage')}
              </Link>
            </div>
          </div>

          <div className="section-title">
            <span>{t('settings.danger')}</span>
          </div>
          <div className="card">
            <button
              type="button"
              className="btn btn-danger btn-block"
              onClick={() => setConfirmReset(true)}
            >
              {t('settings.deleteAll')}
            </button>
            <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
              {t('settings.deleteAllHint')}
            </p>
          </div>

          <div className="section-title">
            <span>{t('settings.about')}</span>
          </div>
          <div className="card">
            <div className="row-between">
              <span>{t('settings.version')}</span>
              <span className="mono small">{APP_VERSION}</span>
            </div>
            <div className="row-between" style={{ marginTop: 'var(--space-2)' }}>
              <span>{t('settings.license')}</span>
              <span className="small">{t('settings.licenseValue')}</span>
            </div>
            <p className="small muted" style={{ margin: 'var(--space-3) 0 0' }}>
              {t('settings.privacy')}
            </p>
          </div>
        </div>
      </main>

      {confirmReset ? (
        <ConfirmDialog
          title={t('settings.deleteAllTitle')}
          message={t('settings.deleteAllBody')}
          confirmLabel={t('settings.deleteAllConfirm')}
          danger
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            setConfirmReset(false);
            void (async () => {
              const repos = repositories();
              await repos.training.clear();
              await repos.rules.clear();
              await repos.summaries.clear();
              await repos.meals.clear();
              await repos.profile.clear();
              toast.show(t('settings.deletedToast'));
              window.location.hash = '#/';
              window.location.reload();
            })();
          }}
        />
      ) : null}
    </>
  );
}

/** Kept for the language picker's "follow the device" option. */
export type { Locale };
