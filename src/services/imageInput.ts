export type ImageSource = 'camera' | 'gallery';

export interface PickedImage {
  dataUrl: string;
  width: number;
  height: number;
  /** Approximate size of the encoded data URL, in bytes. */
  bytes: number;
}

/**
 * Longest edge of a stored meal photo.
 *
 * 1280 px is enough for a model to judge what is on a plate while keeping a
 * compressed image well under a megabyte, which matters because the photo is kept
 * on the device *and* sent as a base64 data URL in the analysis request.
 */
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.72;

/**
 * Open the system picker and return a compressed image.
 *
 * `capture="environment"` asks a phone for the rear camera; a desktop browser
 * ignores it and shows a file dialog, so one code path serves both. Returns `null`
 * when the user cancels, which is not an error.
 */
export function pickImage(source: ImageSource): Promise<PickedImage | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (source === 'camera') input.setAttribute('capture', 'environment');
    input.style.display = 'none';

    let settled = false;
    const finish = (value: PickedImage | null) => {
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
      void compressImage(file)
        .then(finish)
        .catch(reject);
    });

    // Dismissing the picker without choosing fires `cancel` in modern browsers.
    input.addEventListener('cancel', () => finish(null));

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Downscale and re-encode an image file.
 *
 * Uses a canvas rather than shipping an image library: the platform already has
 * a decoder and a JPEG encoder, and the result is a data URL that can be stored
 * and sent without a second conversion step.
 */
export async function compressImage(file: File, maxEdge = MAX_EDGE): Promise<PickedImage> {
  const dataUrl = await readAsDataUrl(file);
  const image = await loadImage(dataUrl);

  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not process the image on this device.');
  context.drawImage(image, 0, 0, width, height);

  const compressed = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return { dataUrl: compressed, width, height, bytes: estimateBytes(compressed) };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read that image.'));
    image.src = src;
  });
}

/** Base64 payload size, which is what the stored string actually costs. */
export function estimateBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.round((base64.length * 3) / 4);
}

/** Human-readable size for the "photo stored" line. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
