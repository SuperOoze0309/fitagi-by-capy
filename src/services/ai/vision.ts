/**
 * Model capability detection.
 *
 * There is no standard way to ask an OpenAI-compatible endpoint "do you accept
 * images?", so this is an explicit three-state answer rather than a guess dressed
 * up as a fact:
 *
 *   `supported`   — the model name matches a known multimodal family
 *   `unsupported` — the model name matches a known text-only family
 *   `unknown`     — no reliable signal
 *
 * The app must not pretend to know more than it does: for `unknown` it lets the
 * user try, and reports whatever the endpoint says. What it never does is send an
 * image to a model it *knows* cannot take one, or block image analysis behind a
 * guess.
 */
export type VisionSupport = 'supported' | 'unsupported' | 'unknown';

export interface VisionCapability {
  support: VisionSupport;
  /** Short machine-readable reason, used to pick the right message. */
  reason: 'known-multimodal' | 'known-text-only' | 'no-signal' | 'user-override';
}

/**
 * Substrings (lower-cased) that identify a family which accepts images.
 *
 * Deliberately matches families and not exact version strings, so a new point
 * release does not silently flip a working setup to "unsupported".
 */
const VISION_FAMILIES = [
  // OpenAI
  'gpt-4o',
  'gpt-4.1',
  'gpt-4-turbo',
  'gpt-4-vision',
  'gpt-5',
  'o1',
  'o3',
  'o4',
  // Anthropic via a gateway
  'claude-3',
  'claude-4',
  'claude-sonnet',
  'claude-opus',
  'claude-haiku',
  // Google
  'gemini-1.5',
  'gemini-2',
  'gemini-pro-vision',
  // Meta / open weights
  'llama-3.2-11b',
  'llama-3.2-90b',
  'llama-4',
  'llava',
  'bakllava',
  'moondream',
  'minicpm-v',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  // Chinese providers with vision models
  'glm-4v',
  'glm-4.1v',
  'internvl',
  'intern-vl',
  'yi-vl',
  'step-1v',
  'step-1o',
  // Mistral
  'pixtral',
  // Local runtimes, where the tag alone is not enough but these do accept images
  'llama3.2-vision',
  'granite3.2-vision',
  'phi-3.5-vision',
  'phi-4-multimodal',
];

/**
 * Substrings identifying families that are text-only.
 *
 * Kept short on purpose: only families that are definitely text-only belong here,
 * because a wrong entry blocks a working feature.
 */
const TEXT_ONLY_FAMILIES = [
  'deepseek-chat',
  'deepseek-coder',
  'deepseek-reasoner',
  'deepseek-v3',
  'gpt-3.5',
  'text-davinci',
  'llama-3.1',
  'llama-3-8b',
  'llama-3-70b',
  'llama-2',
  'mixtral-8x7b',
  'mistral-7b',
  'mistral-nemo',
  'qwen2.5-coder',
  'qwen2.5-7b',
  'gemma-2',
  'gemma-7b',
  'phi-3-mini',
  'phi-4-mini',
  'codellama',
];

/**
 * Decide what the current model can do.
 *
 * `override` is the user's explicit answer for endpoints the heuristic cannot
 * classify, and it always wins — the person configuring the endpoint knows more
 * than a substring table.
 */
export function detectVisionSupport(model: string, override: boolean | null = null): VisionCapability {
  if (override === true) return { support: 'supported', reason: 'user-override' };
  if (override === false) return { support: 'unsupported', reason: 'user-override' };

  const name = model.trim().toLowerCase();
  if (name === '') return { support: 'unknown', reason: 'no-signal' };

  // Vision first: "-vl" and similar markers are more specific than a base-family
  // match, so "qwen2.5-vl" is not caught by a text-only "qwen2.5" entry.
  if (VISION_FAMILIES.some((family) => name.includes(family))) {
    return { support: 'supported', reason: 'known-multimodal' };
  }
  if (TEXT_ONLY_FAMILIES.some((family) => name.includes(family))) {
    return { support: 'unsupported', reason: 'known-text-only' };
  }
  return { support: 'unknown', reason: 'no-signal' };
}

/** True when the app should refuse to attach an image at all. */
export function blocksImageInput(capability: VisionCapability): boolean {
  return capability.support === 'unsupported';
}

/** Translation key for the message shown next to the image actions. */
export function visionMessageKey(capability: VisionCapability): string {
  switch (capability.support) {
    case 'supported':
      return 'settings.visionSupported';
    case 'unsupported':
      return 'settings.visionUnsupported';
    default:
      return 'settings.visionUnknown';
  }
}

/**
 * The image part of an OpenAI-compatible request.
 *
 * The `image_url` content shape is what every compatible gateway accepts; data
 * URLs are used because the photo never leaves the device except in this request.
 */
export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export function imagePart(dataUrl: string, detail: 'auto' | 'low' | 'high' = 'auto'): ImageContentPart {
  return { type: 'image_url', image_url: { url: dataUrl, detail } };
}

/**
 * Recognise an endpoint's own complaint about images.
 *
 * A gateway that rejects the request because the model is text-only answers with
 * prose, not a status code, so the message has to be read. Returning `true` here
 * is what turns "400 Bad Request" into "this model does not accept images".
 */
export function looksLikeVisionRejection(message: string): boolean {
  const text = message.toLowerCase();
  return (
    /image|vision|multimodal|modality/.test(text) &&
    /(not support|unsupported|does not support|invalid|unexpected|unknown|only text|text-only|no vision)/.test(
      text,
    )
  );
}
