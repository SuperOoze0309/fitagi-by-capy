import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MemoryAdapter } from '@/test/MemoryAdapter';
import { initStorage, resetStorageForTests, type StorageBundle } from '@/storage';
import { buildRepositories, type Repositories } from '@/repositories';
import {
  createEmptyPlan,
  createEmptyPlanDay,
  createEmptyPlanExercise,
  createEmptyReminder,
  isValidTime,
  minutesOfDay,
  planTrainingDays,
  planWeeklySets,
} from '@/repositories/planRepository';
import {
  notificationIdFor,
  minutesUntilNext,
  notificationBody,
} from '@/services/reminders';
import {
  parsePlanProposal,
  parseReminderProposals,
  usualTrainingTimes,
} from '@/services/ai/proposals';
import { deltaFromChunk } from '@/services/ai/openaiProvider';
import { formatTimeOfDay, weekdayNames } from '@/domain/datetime';
import { DEFAULT_SETTINGS, normalizeSettings } from '@/repositories/settingsRepository';
import { LEGACY_ONBOARDED_AT } from '@/repositories/settingsRepository';

/**
 * Reminders, plans and the onboarding flag.
 *
 * The scheduling itself belongs to the operating system and cannot be tested here,
 * so what is covered is everything that decides *what* to schedule: the times, the
 * ids, the next-firing arithmetic, and the parsing of an AI proposal into records.
 */
describe('reminder scheduling arithmetic', () => {
  it('validates and orders times', () => {
    assert.equal(isValidTime('09:05'), true);
    assert.equal(isValidTime('23:59'), true);
    assert.equal(isValidTime('24:00'), false);
    assert.equal(isValidTime('7:00'), false, 'a single-digit hour is not HH:MM');
    assert.equal(isValidTime('09:60'), false);
    assert.equal(isValidTime(''), false);

    assert.equal(minutesOfDay('00:00'), 0);
    assert.equal(minutesOfDay('09:30'), 570);
    assert.equal(minutesOfDay('nonsense'), 0, 'an invalid time sorts first rather than crashing');
  });

  it('gives one reminder a stable, positive notification id', () => {
    const id = notificationIdFor('rem_abc123');
    assert.equal(id, notificationIdFor('rem_abc123'), 'the same reminder keeps its id');
    assert.notEqual(id, notificationIdFor('rem_abc124'));
    assert.ok(id > 0 && id < 2147483647, `id ${id} must fit in a 32-bit signed int`);
  });

  it('falls back to the title when a reminder has no body', () => {
    const reminder = createEmptyReminder({ title: 'Leg day', body: '   ' });
    assert.equal(notificationBody(reminder, 'fallback'), 'fallback');
    assert.equal(notificationBody({ ...reminder, body: 'Squat' }, 'fallback'), 'Squat');
  });

  it('finds the next firing time across days', () => {
    // A Wednesday, 18:00.
    const wednesday = new Date(2026, 2, 4, 18, 0);

    const later = createEmptyReminder({ time: '19:30' });
    assert.equal(minutesUntilNext(later, wednesday), 90);

    // Already past today, and it repeats every day, so it is tomorrow.
    const tomorrow = createEmptyReminder({ time: '07:00' });
    assert.equal(minutesUntilNext(tomorrow, wednesday), 13 * 60);

    // Only on Mondays: from Wednesday 18:00 the next Monday 08:00 is 4 days and
    // 14 hours away, not 5 days — the time of day is earlier than "now".
    const monday = createEmptyReminder({ time: '08:00', weekdays: [1] });
    assert.equal(minutesUntilNext(monday, wednesday), (4 * 24 + 14) * 60);

    const paused = createEmptyReminder({ time: '09:00', enabled: false });
    assert.equal(minutesUntilNext(paused, wednesday), null);
  });

  it('never returns a time in the past for a reminder due right now', () => {
    const now = new Date(2026, 2, 4, 19, 0);
    const due = createEmptyReminder({ time: '19:00' });
    const minutes = minutesUntilNext(due, now);
    assert.ok(minutes !== null && minutes > 0, `expected a future time, got ${minutes}`);
    assert.equal(minutes, 24 * 60, 'the same minute tomorrow, not zero minutes from now');
  });
});

describe('weekday labels', () => {
  it('returns seven names starting on Sunday', () => {
    for (const tag of ['en-US', 'zh-CN', 'es-ES']) {
      const names = weekdayNames(tag);
      assert.equal(names.length, 7, `${tag} should name every day`);
      assert.ok(
        names.every((name) => name.trim() !== ''),
        `${tag} produced an empty weekday name`,
      );
      // Every name must be distinct, or the picker is unusable.
      assert.equal(new Set(names).size, 7, `${tag} has duplicate weekday names`);
    }
  });

  it('renders a time of day in the locale clock', () => {
    assert.match(formatTimeOfDay('19:05', 'en-GB'), /19:05/);
    assert.notEqual(formatTimeOfDay('19:05', 'en-US'), '');
    // A malformed value comes back unchanged rather than as "Invalid Date".
    assert.equal(formatTimeOfDay('nope'), 'nope');
  });
});

describe('AI proposal parsing', () => {
  it('keeps valid reminders and drops the rest', () => {
    const proposals = parseReminderProposals(
      JSON.stringify({
        reminders: [
          { title: 'Leg day', body: 'Squat', kind: 'workout', time: '19:00', weekdays: [1, 3] },
          { title: 'Lunch', body: 'Log it', kind: 'meal', time: '12:30', weekdays: [] },
          // Below here: nothing usable.
          { title: '', time: '08:00' },
          { title: 'Bad time', time: '25:00' },
          { title: 'Unknown kind', time: '10:00', kind: 'teleport' },
          'not an object',
        ],
      }),
    );

    assert.equal(proposals.length, 3);
    assert.equal(proposals[0]?.time, '19:00');
    assert.deepEqual(proposals[0]?.weekdays, [1, 3]);
    assert.equal(proposals[1]?.weekdays.length, 0, 'an empty list means every day');
    assert.equal(proposals[2]?.kind, 'custom', 'an unknown kind falls back');
  });

  it('reads a proposal wrapped in prose or a code fence', () => {
    const fenced = '```json\n{"reminders":[{"title":"Water","time":"15:00"}]}\n```';
    assert.equal(parseReminderProposals(fenced).length, 1);

    const chatty = 'Sure! Here you go:\n{"reminders":[{"title":"Water","time":"15:00"}]}\nHope that helps.';
    assert.equal(parseReminderProposals(chatty).length, 1);
  });

  it('collapses duplicate reminders', () => {
    const proposals = parseReminderProposals(
      JSON.stringify({
        reminders: [
          { title: 'Water', time: '15:00', weekdays: [] },
          { title: 'water', time: '15:00', weekdays: [] },
        ],
      }),
    );
    assert.equal(proposals.length, 1);
  });

  it('returns nothing rather than throwing on unusable output', () => {
    assert.deepEqual(parseReminderProposals('not json at all'), []);
    assert.deepEqual(parseReminderProposals('{"reminders":"nope"}'), []);
  });

  it('fills a plan proposal out to seven days', () => {
    const plan = parsePlanProposal(
      JSON.stringify({
        name: 'Upper / lower',
        goal: 'muscleGain',
        days: [
          { weekday: 1, title: 'Upper', rest: false, exercises: [{ name: 'Bench', sets: 4, reps: '6-8' }] },
          { weekday: 3, title: 'Lower', rest: false, exercises: [{ name: 'Squat', sets: 5, reps: '5' }] },
          { weekday: 5, rest: true, exercises: [] },
        ],
      }),
    );

    assert.equal(plan.days.length, 7, 'a week is seven days, with rest days filled in');
    assert.equal(plan.name, 'Upper / lower');
    assert.equal(plan.goal, 'muscleGain');
    assert.equal(plan.days[0]?.rest, true, 'Monday was not mentioned, so it is a rest day');
    assert.equal(plan.days[1]?.exercises[0]?.sets, 4);
    assert.equal(plan.days[1]?.exercises[0]?.reps, '6-8');
    // The exercise count is clamped, not trusted.
    const wild = parsePlanProposal(
      JSON.stringify({ days: [{ weekday: 2, exercises: [{ name: 'Curl', sets: 99 }] }] }),
    );
    assert.equal(wild.days[2]?.exercises[0]?.sets, 20);
  });

  it('gives an unusable plan an empty week rather than a crash', () => {
    const plan = parsePlanProposal('nothing here');
    assert.equal(plan.days.length, 0);
    assert.equal(plan.name, '');
  });

  it('finds the times the user usually trains', () => {
    const times = usualTrainingTimes([
      '2026-03-02T19:02:00.000Z',
      '2026-03-04T18:58:00.000Z',
      '2026-03-06T19:01:00.000Z',
      '2026-03-07T07:30:00.000Z',
    ]);
    assert.ok(times.length > 0);
    // The two 19:00-ish sessions round together, so that hour leads.
    const local19 = times[0]!;
    assert.match(local19, /^\d{2}:\d{2}$/);
    assert.equal(usualTrainingTimes([]).length, 0);
  });
});

describe('streamed response chunks', () => {
  it('reads a delta out of an OpenAI-style chunk', () => {
    assert.equal(deltaFromChunk('{"choices":[{"delta":{"content":"Hel"}}]}'), 'Hel');
    // A chunk with only a role, or only a finish reason, yields nothing.
    assert.equal(deltaFromChunk('{"choices":[{"delta":{"role":"assistant"}}]}'), '');
    assert.equal(deltaFromChunk('{"choices":[{"delta":{},"finish_reason":"stop"}]}'), '');
    // A gateway streaming whole messages still works.
    assert.equal(deltaFromChunk('{"choices":[{"text":"lo"}]}'), 'lo');
    assert.equal(deltaFromChunk('not json'), null);
    assert.equal(deltaFromChunk('{"choices":[]}'), null);
  });
});

describe('reminder and plan records', () => {
  let bundle: StorageBundle;
  let repos: Repositories;

  beforeEach(async () => {
    resetStorageForTests();
    bundle = await initStorage(new MemoryAdapter());
    repos = buildRepositories(bundle);
  });

  it('normalises a reminder on the way in', async () => {
    const saved = await repos.reminders.save(
      createEmptyReminder({
        title: 'Leg day',
        time: '25:99',
        kind: 'teleport' as never,
        weekdays: [3, 1, 3, 9, -1],
      }),
    );
    assert.equal(saved.time, '19:00', 'an impossible time falls back to the default');
    assert.equal(saved.kind, 'custom');
    assert.deepEqual(saved.weekdays, [1, 3], 'weekdays are deduplicated, sorted and in range');
  });

  it('lists enabled reminders first, then by time', async () => {
    await repos.reminders.save(createEmptyReminder({ title: 'Late', time: '21:00' }));
    await repos.reminders.save(createEmptyReminder({ title: 'Early', time: '06:00' }));
    await repos.reminders.save(
      createEmptyReminder({ title: 'Paused', time: '12:00', enabled: false }),
    );

    const all = await repos.reminders.all();
    assert.deepEqual(
      all.map((reminder) => reminder.title),
      ['Early', 'Late', 'Paused'],
    );
  });

  it('keeps exactly one plan active', async () => {
    const first = await repos.plans.save({ ...createEmptyPlan(), name: 'A', active: true });
    const second = await repos.plans.save({ ...createEmptyPlan(), name: 'B', active: true });

    const all = await repos.plans.all();
    assert.equal(all.filter((plan) => plan.active).length, 1, 'two active plans is meaningless');
    assert.equal((await repos.plans.active())?.id, second.id, 'the newest activation wins');
    assert.equal((await repos.plans.get(first.id))?.active, false, 'the older one was stood down');
  });

  it('counts the work in a plan', () => {
    const plan = createEmptyPlan();
    plan.days[1] = createEmptyPlanDay(1, {
      title: 'Push',
      exercises: [
        { ...createEmptyPlanExercise('Bench'), sets: 4 },
        { ...createEmptyPlanExercise('Press'), sets: 3 },
      ],
    });
    plan.days[3] = createEmptyPlanDay(3, { rest: true });

    assert.equal(planWeeklySets(plan), 7);
    assert.equal(planTrainingDays(plan), 1);
    assert.equal(planTrainingDays(createEmptyPlan()), 0);
  });

  it('answers what the active plan has for a weekday', async () => {
    const plan = createEmptyPlan();
    plan.days[2] = createEmptyPlanDay(2, {
      title: 'Pull',
      exercises: [createEmptyPlanExercise('Row')],
    });
    await repos.plans.save({ ...plan, name: 'Split', active: true });

    assert.equal((await repos.plans.forWeekday(2))?.title, 'Pull');
    assert.equal(await repos.plans.forWeekday(4), null, 'an empty day has nothing to start');
  });

  it('survives a backup round-trip', async () => {
    await repos.reminders.save(createEmptyReminder({ title: 'Leg day', time: '19:00' }));
    await repos.plans.save({ ...createEmptyPlan(), name: 'Split', active: true });

    const { createBackup, parseBackup, applyBackup, serializeBackup, summarizeBackup } =
      await import('@/services/backup');
    const document = await createBackup(repos);
    assert.equal(document.reminders.length, 1);
    assert.equal(document.plans.length, 1);
    assert.equal(summarizeBackup(document).reminders, 1);

    const json = serializeBackup(document);
    await repos.reminders.clear();
    await repos.plans.clear();
    assert.equal(await repos.reminders.count(), 0);

    await applyBackup(parseBackup(json), { repos });
    assert.equal(await repos.reminders.count(), 1);
    assert.equal((await repos.plans.active())?.name, 'Split');
  });

  it('imports a backup that has no reminders or plans', async () => {
    const { parseBackup, BACKUP_VERSION } = await import('@/services/backup');
    // What 0.7.0 wrote: the same format version, but only the collections that
    // existed then. A missing list is not an error.
    const older = {
      format: 'fitness-agent-backup',
      version: BACKUP_VERSION,
      exportedAt: '2026-02-14T09:31:00.000Z',
      app: { name: 'FitAGI by Capy', version: '0.7.0' },
      settings: { defaultUnit: 'kg' },
      workouts: [],
      aliasRules: [],
      summaries: [],
      meals: [],
    };
    const parsed = parseBackup(JSON.stringify(older));
    assert.deepEqual(parsed.reminders, []);
    assert.deepEqual(parsed.plans, []);
  });
});

describe('onboarding flag', () => {
  it('is unset on a fresh install and set for an install that predates it', () => {
    // No stored document at all: a new install, so the walkthrough runs.
    assert.equal(normalizeSettings(undefined).onboardedAt, null);
    assert.equal(normalizeSettings(null).onboardedAt, null);

    // A stored document without the field belongs to an older build; those users
    // must not be walked through permissions they already answered.
    assert.equal(normalizeSettings({ defaultUnit: 'kg' }).onboardedAt, LEGACY_ONBOARDED_AT);

    // An explicit value is kept.
    assert.equal(
      normalizeSettings({ onboardedAt: '2026-03-04T10:00:00.000Z' }).onboardedAt,
      '2026-03-04T10:00:00.000Z',
    );
  });

  it('keeps an explicit null, which is what a fresh install stores', () => {
    // This is the shape `ensureInitialized()` writes on a new device. Treating "not a
    // string" as "old document" stamped it as legacy, and the welcome screen — which
    // is the whole point of the flag — never appeared.
    assert.equal(normalizeSettings({ defaultUnit: 'kg', onboardedAt: null }).onboardedAt, null);

    // And it stays null through a round-trip, which is what the store does.
    const written = normalizeSettings({ defaultUnit: 'kg', onboardedAt: null });
    assert.equal(normalizeSettings(JSON.parse(JSON.stringify(written))).onboardedAt, null);
  });

  it('defaults the stored settings to needing onboarding', () => {
    assert.equal(DEFAULT_SETTINGS.onboardedAt, null);
  });
});
