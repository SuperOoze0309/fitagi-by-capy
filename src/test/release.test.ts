import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { APP_VERSION } from '@/domain/types';

/** Read a file from the repository root; `npm test` always runs from there. */
function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * The version is written in four places that no compiler connects, and it had already
 * drifted: the 0.9.0 APK reported itself to Android as "1.0" and the lockfile still
 * said 0.8.0. These checks make a release that disagrees with itself a failing build
 * instead of something a user notices on the About screen or in the system settings.
 */
describe('release metadata', () => {
  it('uses one version in package.json, the lockfile, the app and the Android build', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const lock = JSON.parse(read('package-lock.json')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    const gradle = read('android/app/build.gradle');
    const versionName = /^\s*versionName\s+"([^"]+)"/m.exec(gradle)?.[1];
    const versionCode = /^\s*versionCode\s+(\d+)/m.exec(gradle)?.[1];

    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.equal(APP_VERSION, pkg.version, 'APP_VERSION in src/domain/types.ts');
    assert.equal(lock.version, pkg.version, 'package-lock.json "version"');
    assert.equal(lock.packages[''].version, pkg.version, 'package-lock.json root package');
    assert.equal(versionName, pkg.version, 'versionName in android/app/build.gradle');
    // 0.9.0 was published with versionCode 1; anything not above it cannot be installed
    // as an update on Android.
    assert.ok(Number(versionCode) >= 2, `versionCode ${versionCode} must be above the 0.9.0 build`);
  });

  it('does not force WebView debugging on in release builds', () => {
    // Capacitor enables inspection for debuggable builds when the key is absent. An
    // explicit `true` also opens a release APK to chrome://inspect over USB, which
    // exposes the local database and the stored API key.
    const config = read('capacitor.config.ts');
    assert.doesNotMatch(config, /^\s*webContentsDebuggingEnabled\s*:\s*true/m);
  });

  it('keeps the frozen Android package name', () => {
    const gradle = read('android/app/build.gradle');
    assert.match(gradle, /applicationId\s+"app\.fitnessagent\.tracker"/);
    assert.match(read('capacitor.config.ts'), /appId:\s*'app\.fitnessagent\.tracker'/);
  });
});
