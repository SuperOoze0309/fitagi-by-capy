import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MemoryAdapter } from '@/test/MemoryAdapter';
import { initStorage, resetStorageForTests } from '@/storage';
import { buildRepositories, type Repositories } from '@/repositories';
import {
  createExerciseEntry,
  createSetFromPrevious,
  createWorkout,
  withSetWeight,
} from '@/domain/workout';
import { workoutVolumeKg } from '@/domain/metrics';
import { ContextBuilder } from '@/services/ai/contextBuilder';
import { SummaryService } from '@/services/summaries/summaryService';
import { weekKey } from '@/services/summaries/buildSummary';
import {
  OpenAiCompatibleProvider,
  normalizeBaseUrl,
  describeHttpError,
  extractContent,
} from '@/services/ai/openaiProvider';
import type { LlmConfig } from '@/services/ai/provider';

/**
 * Record a completed workout containing one exercise.
 *
 * A backdated session must set `createdAt` as well: `complete()` stamps `endTime`
 * from the clock, so a workout whose start is in the past would otherwise end up
 * with an end time before its start.
 */
async function record(
  repos: Repositories,
  name: string,
  sets: { weight: number; reps: number; rpe?: number }[],
  startedAt?: string,
) {
  const base = createWorkout();
  const workout = await repos.training.put(
    startedAt ? { ...base, startTime: startedAt, createdAt: startedAt } : base,
  );
  const exercise = createExerciseEntry(workout.id, name, 0);
  await repos.training.upsertExercise(workout.id, {
    ...exercise,
    sets: sets.map((spec) =>
      withSetWeight(
        { ...createSetFromPrevious(undefined, 'kg'), reps: spec.reps, rpe: spec.rpe ?? null },
        spec.weight,
        'kg',
      ),
    ),
  });
  return repos.training.complete(workout.id);
}

describe('context builder', () => {
  let repos: Repositories;
  let builder: ContextBuilder;

  beforeEach(async () => {
    resetStorageForTests();
    const bundle = await initStorage(new MemoryAdapter());
    repos = buildRepositories(bundle);
    builder = new ContextBuilder(repos);
  });

  afterEach(() => {
    resetStorageForTests();
  });

  it('returns empty context for a brand new install', async () => {
    const context = await builder.build();
    assert.equal(context.text, '');
    assert.deepEqual(context.sections, []);
  });

  it('includes only the last N sessions per exercise', async () => {
    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();
    // Weight rises with age, so ordering is unambiguous.
    for (let index = 6; index >= 1; index -= 1) {
      await record(repos, 'Bench Press', [{ weight: 60 + index, reps: 8 }], day(index));
    }

    const context = await builder.build({
      exerciseNames: ['Bench Press'],
      sessionsPerExercise: 3,
      includeWeekly: false,
    });

    assert.match(context.text, /### Bench Press/);
    // Count only the bullets inside the exercise section, so the other sections
    // cannot inflate the number.
    const exerciseSection = context.text.split('## Recent sessions')[1] ?? '';
    const sessionLines = exerciseSection
      .split(/\n## /)[0]!
      .split('\n')
      .filter((line) => line.startsWith('- '));
    assert.equal(sessionLines.length, 3, 'only three sessions were attached');
    // The three most recent are day(3)..day(1) => 63kg, 62kg, 61kg.
    assert.match(sessionLines[0]!, /61kg/);
    assert.match(sessionLines[2]!, /63kg/);
    assert.ok(!context.text.includes('66kg'), 'a session older than the window is excluded');
    assert.ok(context.sections.includes('exerciseSessions:3'));
  });

  it('attaches the in-progress workout when asked', async () => {
    const workout = await repos.training.put(createWorkout());
    const exercise = createExerciseEntry(workout.id, 'Squat', 0);
    await repos.training.upsertExercise(workout.id, {
      ...exercise,
      sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 5 }, 120, 'kg')],
    });

    const context = await builder.build({ workoutId: workout.id });
    assert.match(context.text, /## Current workout/);
    assert.match(context.text, /Squat: 120kgx5/);
    assert.ok(context.sections.includes('currentWorkout'));
  });

  it('summarises the last 7 days without sending every workout', async () => {
    // Fixed Wednesday reference: two days ago belongs to this calendar week
    // regardless of the runner's timezone or the day this test is executed.
    const now = new Date(2026, 0, 7, 12);
    const recent = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const old = new Date(now.getTime() - 40 * 86_400_000).toISOString();
    await record(repos, 'Row', [{ weight: 50, reps: 10 }], recent);
    await record(repos, 'Deadlift', [{ weight: 150, reps: 3 }], old);

    const context = await builder.build({ includeWeekly: true, now });
    assert.match(context.text, /## Last 7 days/);
    assert.match(context.text, /Row/);
    assert.ok(!context.text.includes('Deadlift'), 'an old session is not in the 7-day window');
    // Without a stored weekly summary the builder computes the rollup on the fly,
    // and says so. With one stored it is labelled as the saved summary instead.
    assert.ok(
      context.sections.some((section) => section === 'weeklyComputed'),
      `sections: ${context.sections.join(', ')}`,
    );
    // 50 kg x 10 reps for the one session inside the window.
    assert.match(context.text, /Total volume: 500 kg/);
  });

  it('prefers a stored summary over recomputing it', async () => {
    // A session inside the CURRENT week, so the weekly summary keyed by this week's
    // Monday actually contains it. (A session from last week is correctly excluded
    // from this week's summary, and would only be summarised by its own week.)
    const now = new Date(2026, 0, 7, 12);
    const monday = new Date(`${weekKey(now)}T09:00:00`);
    await record(repos, 'Row', [{ weight: 50, reps: 10 }], monday.toISOString());

    const service = new SummaryService(repos);
    await service.refreshForDate(now, 'kg');
    assert.ok(await repos.summaries.get('weekly', weekKey(now)), 'weekly summary stored');

    const context = await builder.build({ includeWeekly: true, now });
    assert.ok(
      context.sections.includes('weeklySaved'),
      `sections: ${context.sections.join(', ')}`,
    );
    assert.match(context.text, /saved summary/);
  });

  it('only adds the monthly rollup when requested', async () => {
    await record(repos, 'Press', [{ weight: 40, reps: 8 }]);
    const without = await builder.build({});
    assert.ok(!without.text.includes('## This month'));

    const withMonth = await builder.build({ includeMonthly: true });
    assert.ok(withMonth.text.includes('## This month'));
  });

  it('detects which exercise a question is about', async () => {
    await record(repos, 'Bench Press', [{ weight: 60, reps: 8 }]);
    await record(repos, 'Squat', [{ weight: 100, reps: 5 }]);

    assert.deepEqual(await builder.detectExerciseNames('How is my squat going?'), ['Squat']);
    assert.deepEqual(await builder.detectExerciseNames('How is my bench press going?'), [
      'Bench Press',
    ]);
    assert.deepEqual(await builder.detectExerciseNames('how am I doing overall?'), []);
  });

  it('reports its own size so the UI can disclose what is sent', async () => {
    await record(repos, 'Bench Press', [{ weight: 60, reps: 8 }]);
    const context = await builder.build({ exerciseNames: ['Bench Press'] });
    assert.equal(context.characters, context.text.length);
    assert.ok(context.characters > 0);
  });

  it('computes volume from the stored kg value, not the display unit', async () => {
    const workout = await repos.training.put(createWorkout());
    const exercise = createExerciseEntry(workout.id, 'Leg Press', 0);
    await repos.training.upsertExercise(workout.id, {
      ...exercise,
      sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'lb'), reps: 8 }, 577, 'lb')],
    });
    const stored = await repos.training.get(workout.id);
    const expected = 577 * 0.45359237 * 8;
    assert.ok(Math.abs(workoutVolumeKg(stored!) - expected) < 0.01);
  });
});

describe('openai-compatible provider', () => {
  function providerWith(
    response: { ok?: boolean; status?: number; body?: string } | Error,
    config: Partial<LlmConfig> = {},
  ) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (response instanceof Error) throw response;
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(response.body ?? '{}', {
        status: response.status ?? 200,
        statusText: response.ok === false ? 'Error' : 'OK',
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider(
      {
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-secret',
        model: 'test-model',
        ...config,
      },
      { build: async () => ({ text: '', sections: [], characters: 0 }) } as never,
      fetchImpl,
    );
    return { provider, calls };
  }

  it('is not configured without a base URL and model', () => {
    const { provider } = providerWith({ ok: true, body: '{}' }, { baseUrl: '' });
    assert.equal(provider.isConfigured(), false);
    assert.equal(provider.describeTarget(), 'AI off');
  });

  it('posts to /chat/completions with the bearer key and model', async () => {
    const { provider, calls } = providerWith({
      body: JSON.stringify({ choices: [{ message: { content: 'hello' } }] }),
    });

    const answer = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(answer, 'hello');

    const call = calls[0]!;
    assert.equal(call.url, 'https://api.example.test/v1/chat/completions');
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer sk-secret');
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    assert.equal(body['model'], 'test-model');
    assert.equal(body['stream'], false);
  });

  it('omits the Authorization header for a local server without a key', async () => {
    const { provider, calls } = providerWith(
      { body: '{"choices":[{"message":{"content":"ok"}}]}' },
      { apiKey: '', baseUrl: 'http://localhost:11434/v1' },
    );
    await provider.chat([{ role: 'user', content: 'hi' }]);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], undefined);
  });

  it('explains a rejected key instead of throwing raw HTTP', async () => {
    const { provider } = providerWith({
      ok: false,
      status: 401,
      body: JSON.stringify({ error: { message: 'Invalid API key' } }),
    });
    await assert.rejects(
      () => provider.chat([{ role: 'user', content: 'hi' }]),
      (error: unknown) =>
        error instanceof Error &&
        /rejected the API key/.test(error.message) &&
        /Invalid API key/.test(error.message),
    );
  });

  it('explains a wrong base URL', async () => {
    const { provider } = providerWith({ ok: false, status: 404, body: '' });
    await assert.rejects(
      () => provider.chat([{ role: 'user', content: 'hi' }]),
      (error: unknown) => error instanceof Error && /needs to end in \/v1/.test(error.message),
    );
  });

  it('reports a network failure in plain language', async () => {
    const { provider } = providerWith(new Error('fetch failed'));
    await assert.rejects(
      () => provider.chat([{ role: 'user', content: 'hi' }]),
      (error: unknown) =>
        error instanceof Error && /Could not reach api\.example\.test/.test(error.message),
    );
  });

  it('prefers the offline parser and never calls the model when it succeeds', async () => {
    const { provider, calls } = providerWith({ body: '{}' });
    const draft = await provider.parseWorkout('卧推 60kg 8次4组', 'kg');
    assert.equal(draft.source, 'local');
    assert.equal(draft.exercises[0]!.sets.length, 4);
    assert.equal(calls.length, 0, 'a local match costs no request');
  });

  it('falls back to the model and coerces its JSON', async () => {
    const payload = {
      exercises: [
        {
          rawName: 'whatever',
          sets: [{ weight: '42.5', unit: 'lb', reps: '10', rpe: 8, isFailure: true }],
        },
      ],
      notes: 'felt fine',
      warnings: ['check the weight'],
    };
    const { provider, calls } = providerWith({
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    });

    const draft = await provider.parseWorkout('some prose the local parser cannot read', 'kg');
    assert.equal(calls.length, 1);
    assert.equal(draft.source, 'llm');
    assert.equal(draft.exercises[0]!.sets[0]!.weight, 42.5);
    assert.equal(draft.exercises[0]!.sets[0]!.unit, 'lb');
    assert.equal(draft.exercises[0]!.sets[0]!.reps, 10);
    assert.equal(draft.exercises[0]!.sets[0]!.isFailure, true);
    assert.deepEqual(draft.warnings, ['check the weight']);
  });

  it('accepts a fenced JSON reply', async () => {
    const payload = { exercises: [{ rawName: 'x', sets: [{ weight: 10, reps: 5 }] }] };
    const { provider } = providerWith({
      body: JSON.stringify({
        choices: [{ message: { content: '```json\n' + JSON.stringify(payload) + '\n```' } }],
      }),
    });
    const draft = await provider.parseWorkout('unparseable prose here', 'kg');
    assert.equal(draft.exercises[0]!.rawName, 'x');
  });

  it('keeps the user text as a note when the model returns junk', async () => {
    const { provider } = providerWith({
      body: JSON.stringify({ choices: [{ message: { content: 'I cannot help with that.' } }] }),
    });
    const text = 'some prose the local parser cannot read';
    const draft = await provider.parseWorkout(text, 'kg');
    assert.equal(draft.exercises.length, 0);
    assert.equal(draft.notes, text);
    assert.match(draft.warnings[0] ?? '', /did not return usable structured data/);
  });

  it('drops normalization suggestions for names the user never typed', async () => {
    const payload = {
      suggestions: [
        { rawName: 'bench', suggested: 'Bench Press', reason: 'same movement' },
        { rawName: 'invented lift', suggested: 'Squat', reason: 'hallucination' },
        { rawName: 'bench', suggested: 'bench', reason: 'no-op' },
      ],
    };
    const { provider } = providerWith({
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    });

    const suggestions = await provider.normalizeExercise(['bench'], ['Bench Press']);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0]!.suggested, 'Bench Press');
    assert.equal(suggestions[0]!.fromUserRule, false);
  });

  it('returns no suggestions when AI is off', async () => {
    const { provider, calls } = providerWith({ body: '{}' }, { baseUrl: '' });
    assert.deepEqual(await provider.normalizeExercise(['bench'], []), []);
    assert.equal(calls.length, 0);
  });
});

describe('provider helpers', () => {
  it('normalizes base URLs', () => {
    assert.equal(normalizeBaseUrl('https://api.test/v1/'), 'https://api.test/v1');
    assert.equal(normalizeBaseUrl('  https://api.test/v1  '), 'https://api.test/v1');
  });

  it('describes HTTP errors for a human', () => {
    assert.match(describeHttpError(429, ''), /Rate limited/);
    assert.match(describeHttpError(500, ''), /HTTP 500/);
  });

  it('extracts content from either response shape', () => {
    assert.equal(extractContent({ choices: [{ message: { content: 'a' } }] }), 'a');
    assert.equal(extractContent({ choices: [{ text: 'b' }] }), 'b');
    assert.equal(extractContent({ choices: [] }), null);
    assert.equal(extractContent({}), null);
  });
});
