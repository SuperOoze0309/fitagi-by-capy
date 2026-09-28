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
import { localDateKey } from '@/domain/datetime';
import { SummaryService } from '@/services/summaries/summaryService';
import {
  aggregate,
  buildDailySummary,
  buildRollupSummary,
  describeFocus,
  describeMainLifts,
  monthKey,
  monthWeekKeys,
  previousPeriodKey,
  weekDayKeys,
  weekKey,
} from '@/services/summaries/buildSummary';
import type { Workout } from '@/domain/types';

/** Record a completed session at a given local date. */
async function record(
  repos: Repositories,
  date: string,
  exercises: { name: string; sets: { weight: number; reps: number; rpe?: number }[] }[],
): Promise<Workout> {
  const base = createWorkout();
  const startTime = new Date(`${date}T09:00:00`).toISOString();
  const workout = await repos.training.put({ ...base, startTime, createdAt: startTime });
  let order = 0;
  for (const spec of exercises) {
    const entry = createExerciseEntry(workout.id, spec.name, order++);
    await repos.training.upsertExercise(workout.id, {
      ...entry,
      sets: spec.sets.map((set) =>
        withSetWeight(
          { ...createSetFromPrevious(undefined, 'kg'), reps: set.reps, rpe: set.rpe ?? null },
          set.weight,
          'kg',
        ),
      ),
    });
  }
  return repos.training.complete(workout.id);
}

/** A Monday, so week-key maths in tests is unambiguous. */
const MONDAY = '2026-03-02';
const TUESDAY = '2026-03-03';
const NEXT_MONDAY = '2026-03-09';

describe('summary building blocks', () => {
  it('names the focus of a session from the user\'s own exercise names', () => {
    const workout = { ...createWorkout(), exercises: [] };
    const withNames = (names: string[]) => ({
      ...workout,
      exercises: names.map((name, index) => ({ ...createExerciseEntry(workout.id, name, index) })),
    });

    assert.deepEqual(describeFocus([withNames(['Bench Press', 'Overhead Press'])]), [
      'chest',
      'shoulders',
    ]);
    assert.deepEqual(describeFocus([withNames(['深蹲', '腿举'])]), ['legs']);
    assert.deepEqual(describeFocus([withNames(['Pull Up', 'Barbell Row'])]), ['back']);
    // A bare "press" must not read as chest work.
    assert.deepEqual(describeFocus([withNames(['Leg Press'])]), ['legs']);
    assert.deepEqual(describeFocus([withNames(['Overhead Press'])]), ['shoulders']);
    // An unrecognised name simply does not name the day.
    assert.deepEqual(describeFocus([withNames(['Mystery Machine'])]), []);
  });

  it('collapses identical sets into a "weight x reps x sets" line', () => {
    const workout = createWorkout();
    const entry = createExerciseEntry(workout.id, 'Leg Press', 0);
    const sets = Array.from({ length: 4 }, () =>
      withSetWeight({ ...createSetFromPrevious(undefined, 'lb'), reps: 8 }, 577, 'lb'),
    );
    const lines = describeMainLifts([{ ...workout, exercises: [{ ...entry, sets }] }], 4);
    assert.deepEqual(lines, ['Leg Press: 577lb × 8 × 4']);
  });

  it('lists differing sets individually instead of inventing a pattern', () => {
    const workout = createWorkout();
    const entry = createExerciseEntry(workout.id, 'Bench Press', 0);
    const sets = [8, 8, 7, 6].map((reps) =>
      withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps }, 60, 'kg'),
    );
    const lines = describeMainLifts([{ ...workout, exercises: [{ ...entry, sets }] }], 4);
    assert.deepEqual(lines, ['Bench Press: 60kg×8, 60kg×8, 60kg×7, 60kg×6']);
  });

  it('aggregates sessions, sets, volume and per-lift bests', () => {
    const totals = aggregate([
      {
        ...createWorkout(),
        durationSec: 3600,
        exercises: [
          {
            ...createExerciseEntry('w', 'Bench Press', 0),
            sets: [
              withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 60, 'kg'),
              withSetWeight(
                { ...createSetFromPrevious(undefined, 'kg'), reps: 10, isWarmup: true },
                40,
                'kg',
              ),
            ],
          },
        ],
      },
    ]);

    assert.equal(totals.sessionCount, 1);
    assert.equal(totals.workingSets, 1, 'warmups are not working sets');
    assert.equal(totals.volumeKg, 480);
    assert.equal(totals.durationSec, 3600);
    assert.equal(totals.bestByExercise.get('bench press')?.weightKg, 60);
  });

  it('computes period keys and their neighbours', () => {
    assert.equal(weekKey(new Date('2026-03-02T12:00:00')), MONDAY, 'a Monday is its own week start');
    assert.equal(weekKey(new Date('2026-03-08T12:00:00')), MONDAY, 'Sunday belongs to that week');
    assert.equal(weekKey(new Date('2026-03-09T12:00:00')), NEXT_MONDAY);
    assert.equal(monthKey(new Date('2026-03-02T12:00:00')), '2026-03');
    assert.equal(previousPeriodKey('daily', TUESDAY), MONDAY);
    assert.equal(previousPeriodKey('weekly', NEXT_MONDAY), MONDAY);
    assert.equal(previousPeriodKey('monthly', '2026-03'), '2026-02');
    assert.equal(previousPeriodKey('monthly', '2026-01'), '2025-12');
    assert.equal(weekDayKeys(MONDAY).length, 7);
    assert.equal(weekDayKeys(MONDAY)[0], MONDAY);
  });

  it('covers a month that starts mid-week without dropping those sessions', () => {
    // 2026-03-01 is a Sunday, so the first week of March starts in February.
    const weeks = monthWeekKeys('2026-03');
    assert.ok(weeks.includes('2026-02-23'), `weeks: ${weeks.join(', ')}`);
    assert.ok(weeks.includes('2026-03-30'));
  });
});

describe('daily summaries', () => {
  it('describes what was trained, with the numbers', () => {
    const workout = {
      ...createWorkout(),
      durationSec: 4500,
      exercises: [
        {
          ...createExerciseEntry('w', 'Leg Press', 0),
          sets: Array.from({ length: 4 }, () =>
            withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 100, 'kg'),
          ),
        },
        {
          ...createExerciseEntry('w', 'Overhead Press', 1),
          sets: Array.from({ length: 4 }, () =>
            withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 30, 'kg'),
          ),
        },
      ],
    };

    const summary = buildDailySummary({
      kind: 'daily',
      periodKey: MONDAY,
      workouts: [workout],
      context: { unit: 'kg' },
    });

    assert.equal(summary.kind, 'daily');
    assert.equal(summary.periodKey, MONDAY);
    assert.match(summary.title, /legs/i);
    assert.match(summary.body, /Leg Press: 100kg × 8 × 4/);
    assert.match(summary.body, /Overhead Press: 30kg × 8 × 4/);
    assert.match(summary.body, /Working sets|working sets/);
    assert.deepEqual(
      summary.highlights.map((highlight) => highlight.label),
      ['Sessions', 'Working sets', 'Volume', 'Time'],
    );
    assert.equal(summary.source, 'auto');
    assert.equal(summary.sessionCount, 1);
  });

  it('states a clear improvement versus previous history', () => {
    const workout = {
      ...createWorkout(),
      exercises: [
        {
          ...createExerciseEntry('w', 'Bench Press', 0),
          sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 65, 'kg')],
        },
      ],
    };

    const summary = buildDailySummary({
      kind: 'daily',
      periodKey: MONDAY,
      workouts: [workout],
      context: {
        unit: 'kg',
        previousBestByExercise: new Map([['bench press', { weightKg: 60, reps: 8 }]]),
      },
    });

    assert.equal(summary.changes.length, 1);
    assert.equal(summary.changes[0]?.direction, 'up');
    assert.match(summary.changes[0]?.text ?? '', /\+5kg/);
    assert.match(summary.body, /Changes:/);
  });

  it('stays quiet about a change too small to matter', () => {
    const workout = {
      ...createWorkout(),
      exercises: [
        {
          ...createExerciseEntry('w', 'Bench Press', 0),
          sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 60, 'kg')],
        },
      ],
    };

    const summary = buildDailySummary({
      kind: 'daily',
      periodKey: MONDAY,
      workouts: [workout],
      context: {
        unit: 'kg',
        previousBestByExercise: new Map([['bench press', { weightKg: 60, reps: 8 }]]),
      },
    });

    assert.deepEqual(summary.changes, [], 'no noise for an unchanged lift');
  });

  it('reports a first-ever lift as such rather than as a gain', () => {
    const workout = {
      ...createWorkout(),
      exercises: [
        {
          ...createExerciseEntry('w', 'Front Squat', 0),
          sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 5 }, 80, 'kg')],
        },
      ],
    };
    const summary = buildDailySummary({
      kind: 'daily',
      periodKey: MONDAY,
      workouts: [workout],
      context: { unit: 'kg' },
    });
    assert.match(summary.changes[0]?.text ?? '', /first logged/);
  });

  it('handles a day with a workout but no sets without inventing numbers', () => {
    const summary = buildDailySummary({
      kind: 'daily',
      periodKey: MONDAY,
      workouts: [{ ...createWorkout(), durationSec: 600 }],
      context: { unit: 'kg' },
    });
    assert.equal(summary.sessionCount, 1);
    assert.equal(summary.totalVolumeKg, 0);
    assert.match(summary.title, /session/i);
  });
});

describe('weekly and monthly rollups', () => {
  const weeklyWorkout = (weights: number[], name = 'Squat'): Workout => ({
    ...createWorkout(),
    durationSec: 3600,
    exercises: [
      {
        ...createExerciseEntry('w', name, 0),
        sets: weights.map((weight) =>
          withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 5 }, weight, 'kg'),
        ),
      },
    ],
  });

  it('summarises a week from its days and compares to the previous week', () => {
    const previous = buildRollupSummary({
      kind: 'weekly',
      periodKey: MONDAY,
      workouts: [weeklyWorkout([100, 100, 100])],
      children: [],
      context: { unit: 'kg' },
    });

    const summary = buildRollupSummary({
      kind: 'weekly',
      periodKey: NEXT_MONDAY,
      workouts: [weeklyWorkout([110, 110, 110]), weeklyWorkout([110, 110])],
      children: [
        {
          ...previous,
          id: 'child-1',
          kind: 'daily',
          periodKey: NEXT_MONDAY,
          title: 'Trained legs.',
          workoutIds: ['w-child'],
        },
      ],
      context: { unit: 'kg', previous },
    });

    assert.equal(summary.kind, 'weekly');
    assert.equal(summary.sessionCount, 2);
    assert.match(summary.body, /Sessions \+1 vs previous week \(1\)/);
    assert.match(summary.body, /Volume \+/);
    assert.match(summary.body, /By period:/);
    assert.match(summary.body, /- 2026-03-09: Trained legs\./);
    assert.ok(summary.workoutIds.includes('w-child'), 'inherits its days workout ids');
  });

  it('compresses a month from weekly summaries, not from every workout', () => {
    const week1 = buildRollupSummary({
      kind: 'weekly',
      periodKey: '2026-03-02',
      workouts: [weeklyWorkout([100])],
      children: [],
      context: { unit: 'kg' },
    });

    const month = buildRollupSummary({
      kind: 'monthly',
      periodKey: '2026-03',
      workouts: [weeklyWorkout([100]), weeklyWorkout([105])],
      children: [week1],
      context: { unit: 'kg', previous: null },
    });

    assert.equal(month.kind, 'monthly');
    assert.equal(month.sessionCount, 2);
    assert.match(month.body, /this month/i);
    assert.match(month.body, /- 2026-03-02:/);
    // No previous month means no trend lines rather than made-up ones.
    assert.ok(!month.body.includes('vs previous month'));
  });

  it('says so plainly when a period has no training', () => {
    const summary = buildRollupSummary({
      kind: 'weekly',
      periodKey: MONDAY,
      workouts: [],
      children: [],
      context: { unit: 'kg' },
    });
    assert.equal(summary.sessionCount, 0);
    assert.match(summary.title, /No training this week/);
  });
});

describe('summary service', () => {
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

  it('generates daily, weekly and monthly summaries from one saved workout', async () => {
    const workout = await record(repos, MONDAY, [
      { name: 'Squat', sets: [{ weight: 100, reps: 5 }] },
    ]);

    await service.refreshForWorkout(workout, 'kg');

    const daily = await repos.summaries.get('daily', MONDAY);
    const weekly = await repos.summaries.get('weekly', MONDAY);
    const monthly = await repos.summaries.get('monthly', monthKey(new Date(`${MONDAY}T09:00:00`)));

    assert.ok(daily, 'daily summary created');
    assert.ok(weekly, 'weekly summary created');
    assert.ok(monthly, 'monthly summary created');
    assert.equal(daily.sessionCount, 1);
    assert.equal(weekly.sessionCount, 1);
    assert.equal(monthly.sessionCount, 1);
    // Layered: the weekly summary names its day, the monthly names its week.
    assert.match(weekly!.body, new RegExp(`- ${MONDAY}:`));
    assert.match(monthly!.body, new RegExp(`- ${MONDAY}:`));
  });

  it('replaces rather than duplicates when a day is regenerated', async () => {
    const first = await record(repos, MONDAY, [{ name: 'Squat', sets: [{ weight: 100, reps: 5 }] }]);
    await service.refreshForWorkout(first, 'kg');
    const before = await repos.summaries.count();

    await service.refreshDaily(MONDAY, 'kg');
    await service.refreshDaily(MONDAY, 'kg');

    assert.equal(await repos.summaries.count(), before, 'no duplicate rows');
  });

  it('drops a stale summary when the day is emptied', async () => {
    const workout = await record(repos, MONDAY, [{ name: 'Squat', sets: [{ weight: 100, reps: 5 }] }]);
    await service.refreshForWorkout(workout, 'kg');
    assert.ok(await repos.summaries.get('daily', MONDAY));

    await repos.training.remove(workout.id);
    await service.refreshDaily(MONDAY, 'kg');

    assert.equal(await repos.summaries.get('daily', MONDAY), null, 'stale summary removed');
  });

  it('deleting a summary never touches the workouts it came from', async () => {
    const workout = await record(repos, MONDAY, [{ name: 'Squat', sets: [{ weight: 100, reps: 5 }] }]);
    await service.refreshForWorkout(workout, 'kg');

    const summaries = await repos.summaries.all();
    for (const summary of summaries) await repos.summaries.remove(summary.id);

    assert.equal(await repos.summaries.count(), 0);
    assert.equal(await repos.training.count(), 1, 'the workout is untouched');
    assert.equal((await repos.training.get(workout.id))?.exercises[0]?.rawName, 'Squat');
  });

  it('rebuilds everything from history, oldest layer first', async () => {
    await record(repos, MONDAY, [{ name: 'Squat', sets: [{ weight: 100, reps: 5 }] }]);
    await record(repos, TUESDAY, [{ name: 'Bench Press', sets: [{ weight: 60, reps: 8 }] }]);
    await record(repos, NEXT_MONDAY, [{ name: 'Squat', sets: [{ weight: 105, reps: 5 }] }]);

    const result = await service.rebuildAll('kg');

    assert.equal(result.daily, 3);
    assert.equal(result.weekly, 2, 'two distinct weeks');
    assert.equal(result.monthly, 1, 'all three days are in one month');
    const monthly = await repos.summaries.get('monthly', '2026-03');
    assert.equal(monthly?.sessionCount, 3);
    assert.match(monthly!.body, /- 2026-03-02:/);
    assert.match(monthly!.body, /- 2026-03-09:/);
  });

  it('writes summaries for a day in the local calendar, not UTC', async () => {
    // 23:30 local would be the next day in some timezones; the key must follow the
    // user's own day, which is what `findByDate` and the UI both use.
    const late = new Date(`${TUESDAY}T23:30:00`);
    const base = createWorkout();
    const workout = await repos.training.put({
      ...base,
      startTime: late.toISOString(),
      createdAt: late.toISOString(),
    });
    await repos.training.complete(workout.id);

    await service.refreshForDate(late, 'kg');
    assert.ok(await repos.summaries.get('daily', localDateKey(late)));
  });
});
