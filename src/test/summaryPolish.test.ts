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
import { AiService } from '@/services/ai';
import { SummaryService } from '@/services/summaries/summaryService';
import { weekKey, monthKey } from '@/services/summaries/buildSummary';
import { clearPolish, displayBody, isPolished, polishSummary } from '@/services/summaries/polish';
import type { Settings } from '@/domain/types';

const AI_ON: Settings = {
  id: 'app',
  defaultUnit: 'kg',
  aiEnabled: true,
  aiBaseUrl: 'https://api.example.test/v1',
  aiApiKey: 'sk-test',
  aiModel: 'test-model',
  aiRole: 'recorder',
  theme: 'bunny',
  language: 'system',
  aiVisionOverride: null,
  onboardedAt: '2026-01-01T00:00:00.000Z',
};

const AI_OFF: Settings = { ...AI_ON, aiEnabled: false };

/** Record a completed session at a local date. */
async function record(repos: Repositories, date: string, name = 'Squat'): Promise<void> {
  const startTime = new Date(`${date}T09:00:00`).toISOString();
  const endTime = new Date(`${date}T10:00:00`).toISOString();
  const base = createWorkout();
  const workout = await repos.training.put({ ...base, startTime, endTime, createdAt: startTime });
  const entry = createExerciseEntry(workout.id, name, 0);
  await repos.training.upsertExercise(workout.id, {
    ...entry,
    sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 5 }, 100, 'kg')],
  });
  await repos.training.complete(workout.id);
}

describe('summary catch-up', () => {
  let repos: Repositories;
  let service: SummaryService;

  beforeEach(async () => {
    resetStorageForTests();
    const bundle = await initStorage(new MemoryAdapter());
    repos = buildRepositories(bundle);
    service = new SummaryService(repos);
  });

  afterEach(() => {
    resetStorageForTests();
  });

  it('does nothing when every period already has a summary', async () => {
    await record(repos, '2026-03-02');
    await service.rebuildAll('kg');
    const before = await repos.summaries.count();

    const result = await service.catchUp('kg', new Date('2026-03-03T12:00:00'));

    assert.deepEqual(result, { daily: 0, weekly: 0, monthly: 0 });
    assert.equal(await repos.summaries.count(), before, 'no duplicates created');
  });

  it('fills in daily, weekly and monthly summaries that are missing', async () => {
    // History that arrived without summaries, e.g. from an import.
    await record(repos, '2026-03-02');
    await record(repos, '2026-03-03');
    assert.equal(await repos.summaries.count(), 0);

    const result = await service.catchUp('kg', new Date('2026-03-03T18:00:00'));

    assert.equal(result.daily, 2, 'one per training day');
    assert.ok(result.weekly >= 1, `weekly: ${result.weekly}`);
    assert.ok(result.monthly >= 1, `monthly: ${result.monthly}`);
    assert.ok(await repos.summaries.get('daily', '2026-03-02'));
    assert.ok(await repos.summaries.get('weekly', weekKey(new Date('2026-03-02T12:00:00'))));
    assert.ok(await repos.summaries.get('monthly', monthKey(new Date('2026-03-02T12:00:00'))));
  });

  it('is idempotent, so a second launch creates nothing', async () => {
    await record(repos, '2026-03-02');
    await service.catchUp('kg', new Date('2026-03-03T12:00:00'));
    const afterFirst = await repos.summaries.count();

    const second = await service.catchUp('kg', new Date('2026-03-03T12:00:00'));

    assert.deepEqual(second, { daily: 0, weekly: 0, monthly: 0 });
    assert.equal(await repos.summaries.count(), afterFirst);
  });

  it('does nothing at all when there is no history', async () => {
    const result = await service.catchUp('kg');
    assert.deepEqual(result, { daily: 0, weekly: 0, monthly: 0 });
    assert.equal(await repos.summaries.count(), 0);
  });

  it('only looks at the current and previous period, not the whole history', async () => {
    // A session long ago, plus one this week relative to the reference date.
    await record(repos, '2026-01-05');
    await record(repos, '2026-03-02');

    const result = await service.catchUp('kg', new Date('2026-03-03T12:00:00'));

    // The January day is still summarised (it is a daily gap), but the monthly
    // summaries stay bounded to the current and previous month.
    assert.equal(await repos.summaries.get('monthly', '2026-01'), null);
    assert.ok(await repos.summaries.get('monthly', '2026-03'));
    assert.ok(result.daily >= 2);
  });
});

describe('summary polish', () => {
  let repos: Repositories;
  let service: SummaryService;

  beforeEach(async () => {
    resetStorageForTests();
    const bundle = await initStorage(new MemoryAdapter());
    repos = buildRepositories(bundle);
    service = new SummaryService(repos);
  });

  afterEach(() => {
    resetStorageForTests();
  });

  function aiWith(response: { ok?: boolean; status?: number; body?: string } | Error, settings: Settings) {
    const fetchImpl = (async () => {
      if (response instanceof Error) throw response;
      return new Response(response.body ?? '{}', { status: response.status ?? 200 });
    }) as unknown as typeof fetch;
    return new AiService(repos, settings, fetchImpl);
  }

  const chatReply = (content: string) =>
    JSON.stringify({ choices: [{ message: { content } }] });

  it('leaves the summary untouched and reports why when AI is off', async () => {
    await record(repos, '2026-03-02');
    await service.rebuildAll('kg');

    const summary = (await repos.summaries.get('daily', '2026-03-02'))!;
    const result = await polishSummary(repos, aiWith({ body: '{}' }, AI_OFF), summary);

    assert.equal(result.polished, false);
    assert.equal(result.reason, 'AI is off');
    assert.equal(result.summary.llmBody, undefined);
    assert.equal(displayBody(result.summary), summary.body, 'the local body is what renders');
    assert.equal(isPolished(result.summary), false);
  });

  it('stores a rewritten body while keeping the local one', async () => {
    await record(repos, '2026-03-02');
    await service.rebuildAll('kg');
    const summary = (await repos.summaries.get('daily', '2026-03-02'))!;

    const ai = aiWith(
      { body: chatReply('You squatted a solid session today with five reps at 100 kg.') },
      AI_ON,
    );
    const result = await polishSummary(repos, ai, summary);

    assert.equal(result.polished, true);
    assert.match(result.summary.llmBody ?? '', /five reps at 100 kg/);
    assert.equal(result.summary.body, summary.body, 'the on-device body is preserved');
    assert.equal(result.summary.source, 'llm');
    assert.equal(displayBody(result.summary), result.summary.llmBody);

    const stored = await repos.summaries.get('daily', '2026-03-02');
    assert.equal(stored?.llmBody, result.summary.llmBody);
    assert.equal(stored?.body, summary.body);
  });

  it('rejects an unusable reply and keeps the local text', async () => {
    await record(repos, '2026-03-02');
    await service.rebuildAll('kg');
    const summary = (await repos.summaries.get('daily', '2026-03-02'))!;

    for (const reply of ['', '   ', 'short', 'x'.repeat(2000)]) {
      const result = await polishSummary(repos, aiWith({ body: chatReply(reply) }, AI_ON), summary);
      assert.equal(result.polished, false, `reply of length ${reply.length} must be rejected`);
      assert.equal(displayBody(result.summary), summary.body);
      assert.equal(result.summary.llmBody, undefined);
    }
  });

  it('survives a failing endpoint without losing the summary', async () => {
    await record(repos, '2026-03-02');
    await service.rebuildAll('kg');
    const summary = (await repos.summaries.get('daily', '2026-03-02'))!;

    const result = await polishSummary(repos, aiWith(new Error('fetch failed'), AI_ON), summary);

    assert.equal(result.polished, false);
    assert.match(result.reason ?? '', /Could not reach/);
    assert.equal(displayBody(result.summary), summary.body);
    assert.equal((await repos.summaries.get('daily', '2026-03-02'))?.llmBody, undefined);
  });

  it('reverts to the local text when the polish is cleared', async () => {
    await record(repos, '2026-03-02');
    await service.rebuildAll('kg');
    const summary = (await repos.summaries.get('daily', '2026-03-02'))!;
    const polished = await polishSummary(
      repos,
      aiWith({ body: chatReply('A rewritten sentence about your squat session today.') }, AI_ON),
      summary,
    );
    assert.equal(isPolished(polished.summary), true);

    const cleared = await clearPolish(repos, polished.summary);

    assert.equal(cleared.llmBody, undefined);
    assert.equal(cleared.source, 'auto');
    assert.equal(displayBody(cleared), summary.body);
    assert.equal((await repos.summaries.get('daily', '2026-03-02'))?.llmBody, undefined);
  });

  it('never sends more than the one summary it is polishing', async () => {
    await record(repos, '2026-03-02', 'Squat');
    await record(repos, '2026-03-03', 'Bench Press');
    await service.rebuildAll('kg');
    const summary = (await repos.summaries.get('daily', '2026-03-02'))!;

    let sentBody = '';
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sentBody = String(init?.body ?? '');
      return new Response(chatReply('A rewritten sentence about the squat session you logged.'), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await polishSummary(repos, new AiService(repos, AI_ON, fetchImpl), summary);

    assert.match(sentBody, /Squat/);
    assert.ok(!sentBody.includes('Bench Press'), 'other days are not included');
  });
});
