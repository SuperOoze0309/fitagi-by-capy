import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { ThemeScenery } from '../components/ThemeScenery';
import { PixelArt } from '../components/PixelArt';
import { getMascot } from '../theme/tokens';
import { nowIso } from '../domain/datetime';
import {
  cameraPermissionState,
  notificationPermissionState,
  requestCameraPermissions,
  requestNotificationPermission,
  type PermissionState,
} from '../services/reminders';
import { reminderScheduler } from '../services/reminderScheduler';
import { useApp, useI18n } from '../state/AppContext';

/**
 * First-run permission walkthrough.
 *
 * Two permissions, in the order they matter: camera and photos (for photographing a
 * meal) and then notifications (for reminders). Both are optional and both are
 * explained before they are requested, because a permission dialog with no context is
 * how an app gets a permanent "deny".
 *
 * The screen is shown when `settings.onboardedAt` is null, which only happens on a
 * fresh install — an install that predates this screen gets a legacy stamp and is not
 * asked again.
 */
export function WelcomePage() {
  const { t } = useI18n();
  const { settings, updateSettings } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [camera, setCamera] = useState<PermissionState>('prompt');
  const [notifications, setNotifications] = useState<PermissionState>('prompt');

  useEffect(() => {
    void (async () => {
      setCamera(await cameraPermissionState());
      setNotifications(await notificationPermissionState());
    })();
  }, []);

  const finish = useCallback(async () => {
    await updateSettings({ onboardedAt: nowIso() });
    // Reminders may already exist from a restored backup; the OS schedule is empty on
    // a fresh install, so this is where the two meet.
    await reminderScheduler().sync();
    navigate('/', { replace: true });
  }, [navigate, updateSettings]);

  const askCamera = useCallback(async () => {
    setCamera(await requestCameraPermissions());
  }, []);

  const askNotifications = useCallback(async () => {
    const result = await requestNotificationPermission();
    setNotifications(result);
    if (result === 'granted') await reminderScheduler().sync();
  }, []);

  const steps = [
    {
      title: t('welcome.step1Title'),
      body: t('welcome.step1Body'),
      state: camera,
      ask: askCamera,
    },
    {
      title: t('welcome.step2Title'),
      body: t('welcome.step2Body'),
      state: notifications,
      ask: askNotifications,
    },
  ];
  const current = steps[step]!;

  return (
    <>
      <PageHeader title={t('app.name')} subtitle={t('welcome.subtitle')} />
      <main className="app-main">
        <div className="page">
          <div className="card card-hero">
            <PixelArt sprite={getMascot(settings.theme)} size={72} />
            <div className="label-strong" style={{ marginTop: 'var(--space-3)' }}>
              {t('welcome.title')}
            </div>
            <p className="small muted" style={{ margin: 'var(--space-1) 0 0' }}>
              {t('welcome.stepOf', { current: step + 1, total: steps.length })}
            </p>
            <ThemeScenery />
          </div>

          <div className="card">
            <div className="row-between">
              <span className="label-strong">{current.title}</span>
              <span className={`badge ${current.state === 'granted' ? 'live' : 'neutral'}`}>
                {current.state === 'granted' ? t('welcome.allowed') : t('welcome.denied')}
              </span>
            </div>
            <p className="small muted" style={{ margin: 'var(--space-2) 0 0' }}>
              {current.body}
            </p>
            {current.state !== 'granted' ? (
              <div className="page-actions">
                <button type="button" className="btn btn-primary btn-block" onClick={() => void current.ask()}>
                  {t('welcome.allow')}
                </button>
              </div>
            ) : null}
            {current.state === 'denied' ? (
              <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                {t('welcome.deniedHint')}
              </p>
            ) : null}
          </div>

          <div className="row" style={{ gap: 'var(--space-2)' }}>
            {step > 0 ? (
              <button type="button" className="btn" onClick={() => setStep((value) => value - 1)}>
                {t('common.back')}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary spread"
              onClick={() => {
                if (step < steps.length - 1) setStep((value) => value + 1);
                else void finish();
              }}
            >
              {step < steps.length - 1 ? t('welcome.next') : t('welcome.finish')}
            </button>
          </div>

          <button type="button" className="btn btn-ghost btn-block" onClick={() => void finish()}>
            {t('welcome.skip')}
          </button>

          <p className="small faint">{t('welcome.privacy')}</p>
          <p className="small faint">{t('welcome.changeLater')}</p>
        </div>
      </main>
    </>
  );
}
