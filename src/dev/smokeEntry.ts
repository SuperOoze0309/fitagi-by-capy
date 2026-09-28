import { installConsoleErrorCapture } from './consoleErrors';
import { PANEL_ID, runBrowserSmoke } from './browserSmoke';
import { initRepositories } from '../repositories';
import { initStorage, whenStorageReady } from '../storage';

/**
 * Smoke-test entry point.
 *
 * Loaded from index.html only when the page is opened with `?smoke=1`. It is a
 * plain module script rather than a dynamic import inside the app, which keeps test
 * code out of `main.tsx` and avoids depending on dynamic-import behaviour in dev.
 *
 * It runs concurrently with `main.tsx`'s boot, so it waits for storage and then
 * makes sure the repositories exist. `initStorage` and `initRepositories` are both
 * idempotent, so whichever entry point gets there first wins.
 */
async function main(): Promise<void> {
  installConsoleErrorCapture();
  try {
    await initStorage();
    await whenStorageReady();
    const repos = initRepositories();

    /*
     * Pin the interface language before the run starts.
     *
     * The app follows the device language by default, and the assertions are written
     * against the English catalogue, so a machine set to Chinese or Spanish would
     * fail every text assertion for a reason that has nothing to do with the app.
     * Changing the preference needs one reload because the provider reads settings
     * when it mounts; the run counter keeps the pass sequence intact.
     */
    const settings = await repos.settings.ensureInitialized();
    if (settings.language !== 'en') {
      await repos.settings.patch({ language: 'en' });
      window.location.reload();
      return;
    }

    await runBrowserSmoke();
  } catch (error) {
    publishFailure(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

function publishFailure(detail: string): void {
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('pre');
    panel.id = PANEL_ID;
    panel.style.cssText =
      'position:fixed;right:0;bottom:0;z-index:9999;margin:0;padding:6px;max-width:60vw;' +
      'max-height:40vh;overflow:auto;pointer-events:none;' +
      'background:#0f1115;color:#e8eaf0;font:11px ui-monospace,monospace;white-space:pre-wrap;';
    document.body.appendChild(panel);
  }
  panel.textContent = JSON.stringify(
    {
      passed: 0,
      failed: 1,
      note: 'smoke run threw',
      checks: [{ name: 'smoke run', ok: false, detail }],
    },
    null,
    1,
  );
  document.title = 'SMOKE:FAIL';
}

void main();
