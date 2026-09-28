import { isNativePlatform } from '../storage';

/**
 * Moving a backup file in and out of the app.
 *
 * Everything works in the browser (dev) and on Android (production):
 *
 *  - export: on Android the JSON is written to the app cache directory and handed
 *    to the system share sheet, so the user can put it in Drive, mail it to
 *    themselves, or send it to a PC. In a browser it is a normal file download.
 *  - import: always a file picker (`<input type="file">`), which Capacitor's
 *    WebView bridges to the Android document picker.
 *
 * The Capacitor plugins are imported dynamically so the web bundle never needs
 * them and browser development keeps working with no native module.
 */
export interface ExportedFile {
  fileName: string;
  /** Where the file went, phrased for a toast. */
  location: string;
  bytes: number;
}

export async function saveTextFile(
  fileName: string,
  contents: string,
  mimeType = 'application/json',
): Promise<ExportedFile> {
  const bytes = new Blob([contents]).size;

  if (isNativePlatform()) {
    try {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
      const written = await Filesystem.writeFile({
        path: fileName,
        data: contents,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });

      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: fileName,
        text: 'FitAGI by Capy backup',
        url: written.uri,
        dialogTitle: 'Save or share your backup',
      });

      return { fileName, location: 'shared', bytes };
    } catch (error) {
      // A cancelled share sheet must not look like a failure, so fall through to
      // the browser download path before giving up.
      console.warn('[backup] native share unavailable, using download', error);
    }
  }

  downloadInBrowser(fileName, contents, mimeType);
  return { fileName, location: 'downloaded', bytes };
}

function downloadInBrowser(fileName: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the download has definitely started.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Open the system file picker and resolve with the chosen file's text. */
export function pickTextFile(accept = 'application/json,.json'): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';

    let settled = false;
    const finish = (value: { name: string; text: string } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => finish({ name: file.name, text: String(reader.result ?? '') });
      reader.onerror = () => finish(null);
      reader.readAsText(file);
    });

    // Fires when the picker is dismissed without a selection (modern browsers).
    input.addEventListener('cancel', () => finish(null));

    document.body.appendChild(input);
    input.click();
  });
}
