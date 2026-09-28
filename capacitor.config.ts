import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // The appId is deliberately unchanged: it is the Android package name, and a new
  // one would install a second app and leave the existing data behind.
  appId: 'app.fitnessagent.tracker',
  appName: 'FitAGI by Capy',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    // Placeholder: the SQLite plugin is added in the Android storage step.
  },
};

export default config;
