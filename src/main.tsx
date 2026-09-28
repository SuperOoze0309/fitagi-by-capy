import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PixelArt } from './components/PixelArt';
import { AppProvider } from './state/AppContext';
import { ToastProvider } from './state/ToastContext';
import { initRepositories } from './repositories';
import { initStorage } from './storage';
import { detectSystemLocale, translate } from './i18n';
import { DEFAULT_THEME_ID, applyTheme, getMascot } from './theme/tokens';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

const root = createRoot(container);

interface SmokePanel {
  passed: number;
  failed: number;
  note: string;
  checks: { name: string; ok: boolean; detail?: string }[];
}

/**
 * Write the smoke result panel.
 *
 * Lives here (not in the smoke module) so a failed dynamic import of that module
 * still produces a diagnosable result. It is only ever called in a dev build; the
 * `#smoke-result` element is unknown to the production UI.
 *
 * It is deliberately small and pinned to a corner with `pointer-events: none`: a
 * full-screen overlay would cover the app, and since `innerText` only reports
 * rendered text, that would make the harness's own DOM assertions read the panel
 * instead of the page.
 */
function publishSmokePanel(payload: SmokePanel): void {
  let panel = document.getElementById('smoke-result');
  if (!panel) {
    panel = document.createElement('pre');
    panel.id = 'smoke-result';
    panel.style.cssText =
      'position:fixed;right:0;bottom:0;z-index:9999;margin:0;padding:6px;max-width:60vw;' +
      'max-height:40vh;overflow:auto;pointer-events:none;opacity:0.92;' +
      'background:#0f1115;color:#e8eaf0;font:11px ui-monospace,monospace;white-space:pre-wrap;';
    document.body.appendChild(panel);
  }
  panel.textContent = JSON.stringify(payload, null, 1);
}

/**
 * Paint something immediately.
 *
 * Opening the database and reading settings is asynchronous, and on a cold start
 * with a large history that is not instant. Rendering nothing until it finishes
 * makes the app look like it failed to launch, so the first frame is a minimal
 * splash — painted with the default theme, then corrected once settings load.
 */
function paintSplash(): void {
  applyTheme(DEFAULT_THEME_ID);
  root.render(
    <div className="splash">
      <PixelArt sprite={getMascot(DEFAULT_THEME_ID)} size={64} />
      <div className="small">{translate(detectSystemLocale(), 'app.opening')}</div>
    </div>,
  );
}

/**
 * The screen shown when the app cannot start at all.
 *
 * Plain DOM, because whatever failed may have taken the providers, the router or
 * React itself with it. The locale is resolved directly for the same reason.
 */
function renderFatalError(message: string): void {
  const locale = detectSystemLocale();
  const fatal = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  root.render(
    <div className="splash">
      <div className="logo" aria-hidden="true">
        ⚠️
      </div>
      <div>{fatal('errors.storageFailed')}</div>
      <div className="small faint break">{message}</div>
      <div className="small faint" style={{ marginTop: 8, maxWidth: 320, textAlign: 'center' }}>
        {fatal('errors.storageFailedBody')}
      </div>
      <button
        type="button"
        className="btn btn-sm"
        style={{ marginTop: 10 }}
        onClick={() => window.location.reload()}
      >
        {fatal('common.reload')}
      </button>
    </div>,
  );
}

/**
 * Boot sequence: splash → open storage → build repositories → render the app.
 *
 * The app renders only after storage is ready so every page can assume data access
 * is available and never has to handle a half-initialised state.
 */
async function boot(): Promise<void> {
  paintSplash();
  try {
    await initStorage();
    const repos = initRepositories();
    applyTheme((await repos.settings.ensureInitialized()).theme);
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <ToastProvider>
            <AppProvider>
              <HashRouter>
                <App />
              </HashRouter>
            </AppProvider>
          </ToastProvider>
        </ErrorBoundary>
      </StrictMode>,
    );
  } catch (error) {
    renderFatalError(error instanceof Error ? error.message : String(error));
  }
}

void boot().catch((error: unknown) => {
  // Nothing should escape boot(), but a silent unhandled rejection would leave the
  // user with a splash screen and no explanation.
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  renderFatalError(detail);

  // The smoke harness reads this panel, and only ever runs against the dev server,
  // so the production path shows the readable screen and nothing else.
  if (import.meta.env.DEV) {
    publishSmokePanel({
      passed: 0,
      failed: 1,
      note: 'boot failed',
      checks: [{ name: 'boot completed', ok: false, detail }],
    });
    document.title = 'SMOKE:FAIL';
  }
});
