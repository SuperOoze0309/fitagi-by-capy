import type { Meal, MealItem, UserProfile } from '../../domain/types';
import { createEmptyMealItem } from '../../repositories/mealRepository';
import { newId } from '../../domain/ids';
import { nowIso } from '../../domain/datetime';
import type { ChatMessage } from './provider';
import { buildUserContext } from './userContext';
import { imagePart, looksLikeVisionRejection, type VisionCapability } from './vision';

/**
 * Photo analysis and the correction loop.
 *
 * Two things are deliberately separate here:
 *
 *  1. **The drafter** turns an image into a *proposal*. Nothing it returns is ever
 *     saved directly; the UI always shows an editable result first.
 *  2. **The reviser** applies a user correction to an existing proposal. It gets
 *     the current numbers, so "the rice was about 150 g" adjusts rather than
 *     restarts, and the user keeps everything they already fixed.
 *
 * Every figure is an estimate and is labelled as one. The prompt says so, the
 * stored `confidence` says so, and the UI repeats it.
 */

export const MEAL_ANALYSIS_SYSTEM = `You estimate the nutrition of a meal from a photo.

Return ONLY JSON, no markdown fence and no commentary, in exactly this shape:
{
  "name": "short dish name, in the language of the user's locale",
  "portion": "rough portion, e.g. \\"1 bowl\\" or \\"about 350 g\\"",
  "items": [
    {
      "name": "food or ingredient",
      "portion": "rough amount, e.g. \\"150 g\\"",
      "calories": number or null,
      "proteinG": number or null,
      "carbsG": number or null,
      "fatG": number or null
    }
  ],
  "confidence": "high" | "medium" | "low",
  "note": "one short sentence about what is uncertain"
}

Rules:
- These are ESTIMATES from a single photo. Never imply laboratory accuracy.
- Estimate portion sizes from visual cues (plate size, utensils, hands) and say so
  in "note" when the portion is a guess.
- Separate visible components into items: a plate of chicken, rice and salad is
  three items.
- Include cooking fat when it is visible (oil, butter, sauce).
- If you cannot identify any food, return an empty "items" array and explain why
  in "note".
- Numbers are per the portion shown, not per 100 g.
- Never invent a food that is not visible.`;

export const MEAL_REVISION_SYSTEM = `You revise a meal estimate after the user corrected it.

Return ONLY JSON in the same shape as before:
{
  "name": "...", "portion": "...",
  "items": [ { "name": "...", "portion": "...", "calories": null, "proteinG": null, "carbsG": null, "fatG": null } ],
  "confidence": "high" | "medium" | "low",
  "note": "what changed and why, in one short sentence"
}

Rules:
- Apply exactly what the user said. If they say it was chicken thigh, not breast,
  change the item and adjust the fat accordingly.
- If they say a portion was smaller (\\"the rice was about 150 g\\"), rescale that
  item's numbers rather than guessing new ones from scratch.
- Keep every item the user did NOT mention exactly as it was.
- Still return estimates. Never imply precision you do not have.`;

export interface AnalysisResult {
  /** The proposal. Never saved without confirmation. */
  meal: Meal;
  /** True when the endpoint itself said it cannot take images. */
  visionRejected: boolean;
  /** The model's own uncertainty line, shown as-is. */
  note: string;
}

export interface MealAiDeps {
  /** Sends a multimodal request. Injected so this is testable without a network. */
  chatWithImage: (
    messages: ChatMessage[],
    imageDataUrl: string,
  ) => Promise<{ content: string }>;
  /** Sends a text-only request, used by the correction loop. */
  chat: (messages: ChatMessage[]) => Promise<string>;
  capability: VisionCapability;
}

/**
 * Analyse a photo into a draft meal.
 *
 * Throws `VisionNotSupportedError` when the model is known to be text-only, and
 * `VisionRejectedError` when the endpoint refuses the image — two distinct cases
 * because the UI says something different for each.
 */
export async function analyseMealPhoto(
  imageDataUrl: string,
  profile: UserProfile,
  deps: MealAiDeps,
): Promise<AnalysisResult> {
  if (deps.capability.support === 'unsupported' && deps.capability.reason !== 'user-override') {
    throw new VisionNotSupportedError();
  }

  const userContext = buildUserContext(profile);
  const messages: ChatMessage[] = [
    { role: 'system', content: MEAL_ANALYSIS_SYSTEM },
    {
      role: 'user',
      content: `Estimate this meal.${userContext ? `\n\n${userContext}` : ''}`,
    },
  ];

  let content: string;
  try {
    ({ content } = await deps.chatWithImage(messages, imageDataUrl));
  } catch (error) {
    // A gateway that cannot take images often answers 400 with prose rather than
    // refusing cleanly, so the message is inspected before it is re-thrown.
    const message = error instanceof Error ? error.message : String(error);
    if (looksLikeVisionRejection(message)) throw new VisionRejectedError(message);
    throw error;
  }

  const parsed = parseAnalysis(content);
  return {
    meal: draftToMeal(parsed, imageDataUrl ? null : null),
    visionRejected: false,
    note: parsed.note,
  };
}

/**
 * Apply a user correction to an existing proposal.
 *
 * The current values are sent along, so the model adjusts a known state instead of
 * re-deriving one from the picture — which is what makes "I only ate half the
 * sauce" behave sensibly.
 */
export async function reviseMeal(
  current: Meal,
  correction: string,
  profile: UserProfile,
  deps: MealAiDeps,
): Promise<{ meal: Meal; note: string }> {
  const userContext = buildUserContext(profile);
  const messages: ChatMessage[] = [
    { role: 'system', content: MEAL_REVISION_SYSTEM },
    {
      role: 'user',
      content: [
        'Current estimate:',
        JSON.stringify(
          {
            name: current.name,
            portion: current.portion,
            items: current.items.map((item) => ({
              name: item.name,
              portion: item.portion,
              calories: item.calories,
              proteinG: item.proteinG,
              carbsG: item.carbsG,
              fatG: item.fatG,
            })),
          },
          null,
          1,
        ),
        '',
        `User correction: ${correction}`,
        userContext ? `\n${userContext}` : '',
      ].join('\n'),
    },
  ];

  const content = await deps.chat(messages);
  const parsed = parseAnalysis(content);

  // Keep the identity and provenance of the meal being corrected; only the food
  // data and the note change.
  const revised: Meal = {
    ...current,
    name: parsed.name || current.name,
    portion: parsed.portion || current.portion,
    items: parsed.items.length > 0 ? parsed.items : current.items,
    calories: parsed.calories,
    proteinG: parsed.proteinG,
    carbsG: parsed.carbsG,
    fatG: parsed.fatG,
    confidence: parsed.confidence,
    // A revised estimate is no longer purely AI: the user contributed to it.
    source: 'ai-edited',
    aiNote: parsed.note,
    updatedAt: nowIso(),
  };

  return { meal: revised, note: parsed.note };
}

/** The model is known not to accept images. */
export class VisionNotSupportedError extends Error {
  constructor() {
    super('This model does not accept images.');
  }
}

/** The endpoint refused the image even though the model name suggested it would work. */
export class VisionRejectedError extends Error {
  constructor(detail: string) {
    super(detail);
  }
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

interface ParsedAnalysis {
  name: string;
  portion: string;
  items: MealItem[];
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  confidence: Meal['confidence'];
  note: string;
}

/**
 * Parse the model's JSON.
 *
 * Tolerant about wrapping (fences, stray prose) and strict about values: a figure
 * that is not a finite number becomes `null`, so a hallucinated string cannot be
 * written into the meal as `NaN`.
 */
export function parseAnalysis(raw: string): ParsedAnalysis {
  const payload = extractJson(raw);
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;

  const items: MealItem[] = [];
  const rawItems = Array.isArray(record['items']) ? record['items'] : [];
  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const name = typeof item['name'] === 'string' ? item['name'].trim() : '';
    if (name === '') continue;
    items.push({
      ...createEmptyMealItem(),
      id: newId('item'),
      name,
      portion: typeof item['portion'] === 'string' ? item['portion'].trim() : '',
      calories: numberOrNull(item['calories']),
      proteinG: numberOrNull(item['proteinG']),
      carbsG: numberOrNull(item['carbsG']),
      fatG: numberOrNull(item['fatG']),
    });
  }

  const confidence =
    record['confidence'] === 'high' || record['confidence'] === 'medium' || record['confidence'] === 'low'
      ? record['confidence']
      : null;

  return {
    name: typeof record['name'] === 'string' ? record['name'].trim() : '',
    portion: typeof record['portion'] === 'string' ? record['portion'].trim() : '',
    items,
    // Totals come from the items, so the headline figure can never disagree with
    // the breakdown the user is about to check.
    ...sumNutrition(items),
    confidence,
    note: typeof record['note'] === 'string' ? record['note'].trim() : '',
  };
}

function sumNutrition(items: MealItem[]): {
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
} {
  const sum = (pick: (item: MealItem) => number | null): number | null => {
    let total = 0;
    let seen = false;
    for (const item of items) {
      const value = pick(item);
      if (value === null) continue;
      total += value;
      seen = true;
    }
    return seen ? Math.round(total * 10) / 10 : null;
  };

  return {
    calories: sum((item) => item.calories),
    proteinG: sum((item) => item.proteinG),
    carbsG: sum((item) => item.carbsG),
    fatG: sum((item) => item.fatG),
  };
}

/** Pull the outermost JSON object out of a reply that may be fenced or padded. */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidate = fenced ? fenced[1]! : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value * 10) / 10;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed * 10) / 10;
  }
  return null;
}

/** Turn a parsed analysis into an unsaved meal draft. */
export function draftToMeal(parsed: ParsedAnalysis, imageKey: string | null, eatenAt?: string): Meal {
  const timestamp = nowIso();
  return {
    id: newId('meal'),
    eatenAt: eatenAt ?? timestamp,
    name: parsed.name,
    portion: parsed.portion,
    items: parsed.items,
    calories: parsed.calories,
    proteinG: parsed.proteinG,
    carbsG: parsed.carbsG,
    fatG: parsed.fatG,
    notes: '',
    source: 'ai',
    confidence: parsed.confidence,
    imageKey,
    aiNote: parsed.note,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Build the multimodal message list for a photo request. */
export function imageMessages(
  systemPrompt: string,
  userPrompt: string,
  imageDataUrl: string,
): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      // The OpenAI content-array shape: text first, then the image. A data URL is
      // used because the photo never leaves the device except in this request.
      content: [{ type: 'text', text: userPrompt }, imagePart(imageDataUrl)],
    },
  ];
}
