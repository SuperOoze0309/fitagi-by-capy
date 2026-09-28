import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MemoryAdapter } from '@/test/MemoryAdapter';
import { initStorage, resetStorageForTests } from '@/storage';
import { buildRepositories } from '@/repositories';
import { EMPTY_PROFILE } from '@/repositories/settingsRepository';
import { createEmptyMeal } from '@/repositories/mealRepository';
import {
  detectVisionSupport,
  blocksImageInput,
  looksLikeVisionRejection,
  visionMessageKey,
} from '@/services/ai/vision';
import {
  analyseMealPhoto,
  reviseMeal,
  parseAnalysis,
  VisionNotSupportedError,
  type MealAiDeps,
} from '@/services/ai/mealAnalysis';
import { buildProfileBlock, buildUserContext, resolveAge, resolveMetrics } from '@/services/ai/userContext';
import type { ChatMessage } from '@/services/ai/provider';
import { estimateBytes, formatBytes } from '@/services/imageInput';
import type { UserProfile } from '@/domain/types';

/**
 * Vision capability.
 *
 * The product rule is that the app must not pretend to know more than it does:
 * a guess must not block a working setup, and a known text-only model must not
 * silently receive an image.
 */
describe('vision capability detection', () => {
  it('recognises known multimodal families', () => {
    for (const model of [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1-mini',
      'claude-3-5-sonnet',
      'gemini-2.0-flash',
      'qwen2.5-vl-7b',
      'llava:13b',
      'pixtral-12b',
      'glm-4v',
      'llama3.2-vision',
    ]) {
      assert.equal(detectVisionSupport(model).support, 'supported', model);
    }
  });

  it('recognises known text-only families', () => {
    for (const model of ['deepseek-chat', 'deepseek-reasoner', 'gpt-3.5-turbo', 'llama-3.1-8b']) {
      assert.equal(detectVisionSupport(model).support, 'unsupported', model);
    }
  });

  it('prefers a vision marker over a text-only base family', () => {
    // "qwen2.5-vl" must not be caught by any text-only "qwen2.5" entry.
    assert.equal(detectVisionSupport('qwen2.5-vl-72b').support, 'supported');
    assert.equal(detectVisionSupport('llama-3.2-11b-vision').support, 'supported');
  });

  it('says "unknown" when there is no signal instead of guessing', () => {
    assert.equal(detectVisionSupport('my-local-model').support, 'unknown');
    assert.equal(detectVisionSupport('').support, 'unknown');
    // An unknown model is not blocked: the user is allowed to try.
    assert.equal(blocksImageInput(detectVisionSupport('my-local-model')), false);
  });

  it('lets an explicit user answer win', () => {
    assert.equal(detectVisionSupport('deepseek-chat', true).support, 'supported');
    assert.equal(detectVisionSupport('gpt-4o', false).support, 'unsupported');
    assert.equal(detectVisionSupport('gpt-4o', false).reason, 'user-override');
  });

  it('maps each capability to its own message', () => {
    assert.equal(visionMessageKey(detectVisionSupport('gpt-4o')), 'settings.visionSupported');
    assert.equal(visionMessageKey(detectVisionSupport('deepseek-chat')), 'settings.visionUnsupported');
    assert.equal(visionMessageKey(detectVisionSupport('unknown-model')), 'settings.visionUnknown');
  });

  it('recognises an endpoint refusing an image in prose', () => {
    // A gateway that cannot take images answers 400 with text, not a status code.
    assert.equal(
      looksLikeVisionRejection('This model does not support image input, modality not allowed'),
      true,
    );
    assert.equal(looksLikeVisionRejection('invalid request: unexpected image_url'), true);
    // A genuine rate limit must not be misread as a vision problem.
    assert.equal(looksLikeVisionRejection('Rate limit exceeded'), false);
    assert.equal(looksLikeVisionRejection('Invalid API key'), false);
  });
});

describe('user context', () => {
  it('produces nothing for an empty profile', () => {
    assert.equal(buildProfileBlock(EMPTY_PROFILE), '');
    assert.equal(buildUserContext(EMPTY_PROFILE), '', 'no heading for an empty profile');
  });

  it('includes only the fields that are filled in', () => {
    const block = buildProfileBlock({
      ...EMPTY_PROFILE,
      gender: 'male',
      age: 21,
      heightCm: 173,
      weightKg: 130,
      trainingGoal: 'fatLoss',
    });

    assert.match(block, /Sex: male/);
    assert.match(block, /Age: 21/);
    assert.match(block, /Height: 173 cm/);
    assert.match(block, /Weight: 130 kg/);
    assert.match(block, /Goal: fat loss/);
    // A field the user left blank is omitted rather than announced as unknown.
    assert.ok(!block.includes('Activity level'));
    assert.ok(!block.includes('Name:'));
  });

  it('formats the block the way the spec asks for', () => {
    const block = buildProfileBlock({
      ...EMPTY_PROFILE,
      gender: 'male',
      age: 21,
      heightCm: 173,
      weightKg: 130,
      trainingGoal: 'fatLoss',
    });
    assert.equal(
      block,
      ['Sex: male', 'Age: 21', 'Height: 173 cm', 'Weight: 130 kg', 'Goal: fat loss'].join('\n'),
    );
  });

  it('derives an age from a birthday when no age was entered', () => {
    const now = new Date('2026-06-15T12:00:00');
    assert.equal(resolveAge({ ...EMPTY_PROFILE, birthday: '2005-06-14' }, now), 21);
    assert.equal(
      resolveAge({ ...EMPTY_PROFILE, birthday: '2005-06-16' }, now),
      20,
      'a birthday later this year has not happened yet',
    );
    // An explicit age always wins over the birthday.
    assert.equal(resolveAge({ ...EMPTY_PROFILE, age: 30, birthday: '2005-06-14' }, now), 30);
    assert.equal(resolveAge(EMPTY_PROFILE, now), null);
  });

  it('interprets stored numbers according to the chosen unit system', () => {
    const metric = resolveMetrics({ ...EMPTY_PROFILE, unitSystem: 'metric', weightKg: 130 });
    assert.equal(metric.weightKg, 130);

    // A user on imperial typed pounds, so the stored number is pounds.
    const imperial = resolveMetrics({ ...EMPTY_PROFILE, unitSystem: 'imperial', weightKg: 130 });
    assert.equal(Math.round(imperial.weightKg * 100) / 100, 58.97);
    // Height stays in centimetres in both systems.
    assert.equal(resolveMetrics({ ...EMPTY_PROFILE, heightCm: 173 }).heightCm, 173);
  });

  it('never mentions a theme or any presentation', () => {
    const block = buildProfileBlock({ ...EMPTY_PROFILE, gender: 'female', name: 'Sam' });
    assert.ok(!/theme|colour|color|style/i.test(block));
  });
});

describe('meal analysis', () => {
  beforeEach(async () => {
    resetStorageForTests();
    const bundle = await initStorage(new MemoryAdapter());
    // Repositories are initialised so the shared `aiService` path can be used by
    // the callers under test; these tests drive the pure functions directly.
    buildRepositories(bundle);
  });

  it('parses the model JSON into a draft meal', () => {
    const parsed = parseAnalysis(
      JSON.stringify({
        name: 'Chicken rice bowl',
        portion: '1 bowl',
        items: [
          { name: 'Chicken breast', portion: '150 g', calories: 248, proteinG: 46, carbsG: 0, fatG: 5 },
          { name: 'White rice', portion: '200 g', calories: 260, proteinG: 5, carbsG: 56, fatG: 1 },
        ],
        confidence: 'medium',
        note: 'Portion estimated from the bowl size.',
      }),
    );

    assert.equal(parsed.name, 'Chicken rice bowl');
    assert.equal(parsed.items.length, 2);
    // Totals come from the items, so the headline can never disagree with them.
    assert.equal(parsed.calories, 508);
    assert.equal(parsed.proteinG, 51);
    assert.equal(parsed.confidence, 'medium');
  });

  it('accepts a fenced reply and rejects nonsense values', () => {
    const fenced = parseAnalysis(
      '```json\n' +
        JSON.stringify({
          name: 'Salad',
          items: [{ name: 'Lettuce', calories: 'not a number', proteinG: -4 }],
        }) +
        '\n```',
    );
    assert.equal(fenced.items.length, 1);
    assert.equal(fenced.items[0]?.calories, null, 'a non-numeric figure is dropped');
    assert.equal(fenced.items[0]?.proteinG, null, 'a negative figure is dropped');
    assert.equal(fenced.calories, null, 'so the total is unknown rather than NaN');
  });

  it('skips items with no name instead of writing blank rows', () => {
    const parsed = parseAnalysis(JSON.stringify({ items: [{ calories: 100 }, { name: 'Rice' }] }));
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0]?.name, 'Rice');
  });

  it('handles a reply that is not JSON at all', () => {
    const parsed = parseAnalysis('I could not identify any food in this photo.');
    assert.equal(parsed.items.length, 0);
    assert.equal(parsed.calories, null);
  });

  it('refuses to send an image to a model known to be text-only', async () => {
    let called = false;
    const deps: MealAiDeps = {
      capability: detectVisionSupport('deepseek-chat'),
      chat: async () => '',
      chatWithImage: async () => {
        called = true;
        return { content: '{}' };
      },
    };

    await assert.rejects(
      () => analyseMealPhoto('data:image/jpeg;base64,AAAA', EMPTY_PROFILE, deps),
      VisionNotSupportedError,
    );
    assert.equal(called, false, 'the request is never attempted');
  });

  it('analyses a photo when the model supports images', async () => {
    let sentImage = '';
    const deps: MealAiDeps = {
      capability: detectVisionSupport('gpt-4o'),
      chat: async () => '',
      chatWithImage: async (_messages: ChatMessage[], image: string) => {
        sentImage = image;
        return {
          content: JSON.stringify({
            name: 'Omelette',
            items: [{ name: 'Eggs', portion: '2', calories: 140, proteinG: 12 }],
            confidence: 'high',
            note: 'Assumed two eggs.',
          }),
        };
      },
    };

    const result = await analyseMealPhoto('data:image/jpeg;base64,BBBB', EMPTY_PROFILE, deps);

    assert.equal(sentImage, 'data:image/jpeg;base64,BBBB', 'the photo is what was sent');
    assert.equal(result.meal.name, 'Omelette');
    assert.equal(result.meal.source, 'ai');
    assert.equal(result.meal.calories, 140);
    assert.equal(result.note, 'Assumed two eggs.');
  });

  it('turns an endpoint refusal into a vision-specific error', async () => {
    const deps: MealAiDeps = {
      capability: detectVisionSupport('some-unknown-model'),
      chat: async () => '',
      chatWithImage: async () => {
        throw new Error('HTTP 400: this model does not support image input');
      },
    };

    // An unknown model is allowed to try, and the endpoint's own answer is
    // translated into the vision message rather than shown as a raw API error.
    await assert.rejects(
      () => analyseMealPhoto('data:image/jpeg;base64,CCCC', EMPTY_PROFILE, deps),
      /does not support image input/,
    );
  });

  it('applies a correction and marks the meal as user-edited', async () => {
    const current = {
      ...createEmptyMeal(),
      name: 'Chicken bowl',
      source: 'ai' as const,
      items: [
        { id: 'i1', name: 'Chicken breast', portion: '150 g', calories: 248, proteinG: 46, carbsG: 0, fatG: 5 },
        { id: 'i2', name: 'White rice', portion: '200 g', calories: 260, proteinG: 5, carbsG: 56, fatG: 1 },
      ],
      calories: 508,
      proteinG: 51,
      carbsG: 56,
      fatG: 6,
    };

    const deps: MealAiDeps = {
      capability: detectVisionSupport('gpt-4o'),
      chat: async () =>
        JSON.stringify({
          name: 'Chicken bowl',
          items: [
            { name: 'Chicken thigh', portion: '150 g', calories: 320, proteinG: 38, carbsG: 0, fatG: 18 },
            { name: 'White rice', portion: '150 g', calories: 195, proteinG: 4, carbsG: 42, fatG: 1 },
          ],
          confidence: 'medium',
          note: 'Switched to thigh and reduced the rice.',
        }),
      chatWithImage: async () => ({ content: '{}' }),
    };

    const result = await reviseMeal(current, 'It was chicken thigh, and the rice was 150 g.', EMPTY_PROFILE, deps);

    assert.equal(result.meal.items[0]?.name, 'Chicken thigh');
    assert.equal(result.meal.items[1]?.portion, '150 g');
    assert.equal(result.meal.calories, 515, 'totals follow the revised items');
    assert.equal(result.meal.source, 'ai-edited', 'a revised estimate is no longer purely AI');
    assert.equal(result.meal.id, current.id, 'the meal identity is preserved');
    assert.match(result.note, /thigh/);
  });

  it('keeps the previous items when a revision returns nothing usable', async () => {
    const current = {
      ...createEmptyMeal(),
      name: 'Bowl',
      source: 'ai' as const,
      items: [
        { id: 'i1', name: 'Rice', portion: '200 g', calories: 260, proteinG: 5, carbsG: 56, fatG: 1 },
      ],
      calories: 260,
    };

    const deps: MealAiDeps = {
      capability: detectVisionSupport('gpt-4o'),
      chat: async () => 'I could not do that.',
      chatWithImage: async () => ({ content: '{}' }),
    };

    const result = await reviseMeal(current, 'make it smaller', EMPTY_PROFILE, deps);
    assert.equal(result.meal.items.length, 1, 'the user keeps what they already had');
    assert.equal(result.meal.items[0]?.name, 'Rice');
    assert.equal(result.meal.name, 'Bowl');
  });

  it('sends the current numbers so a correction adjusts rather than restarts', async () => {
    const current = {
      ...createEmptyMeal(),
      name: 'Bowl',
      source: 'ai' as const,
      items: [{ id: 'i1', name: 'Rice', portion: '200 g', calories: 260, proteinG: 5, carbsG: 56, fatG: 1 }],
      calories: 260,
    };

    let sent = '';
    const deps: MealAiDeps = {
      capability: detectVisionSupport('gpt-4o'),
      chat: async (messages: ChatMessage[]) => {
        sent = messages.map((message) => JSON.stringify(message.content)).join('\n');
        return JSON.stringify({ name: 'Bowl', items: current.items, note: 'ok' });
      },
      chatWithImage: async () => ({ content: '{}' }),
    };

    await reviseMeal(current, 'the rice was 150 g', EMPTY_PROFILE, deps);

    // The message body is JSON-encoded, so the assertion looks for the values
    // rather than the quoted key names.
    assert.match(sent, /200 g/, 'the current portion is sent');
    assert.match(sent, /Rice/, 'and the current items');
    assert.match(sent, /the rice was 150 g/, 'so is the correction');
  });

  it('includes the profile in the analysis request when it is filled in', async () => {
    let sent = '';
    const profile: UserProfile = {
      ...EMPTY_PROFILE,
      gender: 'male',
      age: 21,
      heightCm: 173,
      weightKg: 130,
      trainingGoal: 'fatLoss',
    };

    const deps: MealAiDeps = {
      capability: detectVisionSupport('gpt-4o'),
      chat: async () => '',
      chatWithImage: async (messages: ChatMessage[]) => {
        sent = messages.map((message) => JSON.stringify(message.content)).join('\n');
        return { content: '{"name":"x","items":[]}' };
      },
    };

    await analyseMealPhoto('data:image/jpeg;base64,DDDD', profile, deps);

    assert.match(sent, /Sex: male/);
    assert.match(sent, /Weight: 130 kg/);
  });
});

describe('image sizing helpers', () => {
  it('estimates the stored size of a data URL', () => {
    // Base64 is 4 characters per 3 bytes, which is what the stored string costs.
    const oneKbOfBase64 = `data:image/jpeg;base64,${'A'.repeat(1368)}`;
    const bytes = estimateBytes(oneKbOfBase64);
    assert.ok(Math.abs(bytes - 1026) <= 2, `expected about 1026 bytes, got ${bytes}`);
  });

  it('formats sizes for a human', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  });
});
