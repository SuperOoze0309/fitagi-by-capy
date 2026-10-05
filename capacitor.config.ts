import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // The appId is deliberately unchanged: it is the Android package name, and a new
  // one would install a second app and leave the existing data behind.
  appId: 'app.fitnessagent.tracker',
  appName: 'FitAGI by Capy',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    // `webContentsDebuggingEnabled` is deliberately not set. Left out, Capacitor turns
    // WebView inspection on for debuggable builds only; forcing it to `true` would let
    // anyone with a USB cable open chrome://inspect on a release APK and read the local
    // database and the stored API key.
  },
  plugins: {
    // Placeholder: the SQLite plugin is added in the Android storage step.
  },
};

export default config;
