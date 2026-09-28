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
import {
  buildCsvExport,
  buildExport,
  buildMarkdownExport,
  csvCell,
  exportFileName,
  selectWorkouts,
} from '@/services/export/exportService';
import type { Workout } from '@/domain/types';

async function record(
  repos: Repositories,
  date: string,
  exercises: { name: string; sets: { weight: number | null; reps: number | null; unit?: 'kg' | 'lb'; isWarmup?: boolean; isFailure?: boolean; rpe?: number; notes?: string }[] }[],
  notes = '',
): Promise<Workout> {
  const base = createWorkout();
  const startTime = new Date(`${date}T09:00:00`).toISOString();
  // An explicit end time keeps the recorded duration deterministic: `complete()`
  // would otherwise stamp the wall clock, and a synthetic 2026 date would produce a
  // duration measured in months.
  const endTime = new Date(`${date}T10:00:00`).toISOString();
  const workout = await repos.training.put({
    ...base,
    startTime,
    endTime,
    createdAt: startTime,
    notes,
  });
  let order = 0;
  for (const spec of exercises) {
    const entry = createExerciseEntry(workout.id, spec.name, order++);
    await repos.training.upsertExercise(workout.id, {
      ...entry,
      sets: spec.sets.map((set) =>
        withSetWeight(
          {
            ...createSetFromPrevious(undefined, set.unit ?? 'kg'),
            reps: set.reps,
            rpe: set.rpe ?? null,
            isWarmup: set.isWarmup ?? false,
            isFailure: set.isFailure ?? false,
            notes: set.notes ?? '',
          },
          set.weight,
          set.unit ?? 'kg',
        ),
      ),
    });
  }
  return repos.training.complete(workout.id);
}

describe('readable exports', () => {
  let repos: Repositories;

  beforeEach(async () => {
    resetStorageForTests();
    const bundle = await initStorage(new MemoryAdapter());
    repos = buildRepositories(bundle);
  });

  afterEach(() => {
    resetStorageForTests();
  });

  it('writes a Markdown log with totals, per-exercise table and every set', async () => {
    await record(
      repos,
      '2026-03-02',
      [
        {
          name: 'Bench Press',
          sets: [
            { weight: 40, reps: 10, isWarmup: true },
            { weight: 60, reps: 8 },
            { weight: 60, reps: 7, isFailure: true, rpe: 10 },
          ],
        },
      ],
      'felt strong',
    );
    await record(repos, '2026-03-03', [{ name: 'Squat', sets: [{ weight: 100, reps: 5 }] }]);

    const result = await buildMarkdownExport(repos, { unit: 'kg' }, new Date('2026-03-04T10:00:00'));
    const text = result.contents;

    assert.equal(result.workoutCount, 2);
    assert.equal(result.setCount, 4);
    assert.equal(result.mimeType, 'text/markdown');
    assert.match(result.fileName, /^fitagi-2026-03-04\.md$/);

    assert.match(text, /^# FitAGI by Capy export/m);
    assert.match(text, /- Sessions: 2/);
    assert.match(text, /- Working sets: 3/, 'warmups are excluded from the working-set total');
    assert.match(text, /\| Exercise \| Sessions \| Best set \| e1RM \| Volume \|/);
    assert.match(text, /\| Bench Press \| 1 \| 60 kg × 8 \|/);
    assert.match(text, /### .*2.* 09:00/, 'the date is shown in the reader\'s locale');
    assert.match(text, /> felt strong/);
    assert.match(text, /\*\*Bench Press\*\*/);
    assert.match(text, /- 60 kg × 8/);
    assert.match(text, /- 60 kg × 7 _\(failure\)_ \(RPE 10\)/);
    assert.match(text, /- 40 kg × 10 _\(warmup\)_/);
    // Oldest first, so the document reads forwards.
    assert.ok(text.indexOf('Bench Press') < text.indexOf('Squat'), 'chronological order');
  });

  it('includes the day summary when one exists', async () => {
    const workout = await record(repos, '2026-03-02', [
      { name: 'Squat', sets: [{ weight: 100, reps: 5 }] },
    ]);
    const { SummaryService } = await import('@/services/summaries/summaryService');
    await new SummaryService(repos).refreshForWorkout(workout, 'kg');

    const text = (await buildMarkdownExport(repos, { unit: 'kg' })).contents;
    assert.match(text, /_Summary: Trained legs\._/);
  });

  it('writes CSV with one row per set and a header', async () => {
    await record(repos, '2026-03-02', [
      {
        name: 'Leg Press',
        sets: [
          { weight: 577, reps: 8, unit: 'lb' },
          { weight: 577, reps: 8, unit: 'lb' },
        ],
      },
    ]);

    const result = await buildCsvExport(repos, { unit: 'lb' });
    const lines = result.contents.trim().split('\n');

    assert.equal(lines.length, 3, 'header plus two sets');
    assert.match(lines[0]!, /^date,startedAt,workoutId,workoutDurationSec,exerciseOrder,exercise,/);
    assert.match(lines[0]!, /weight,unit,weightKg,reps,rpe,rir,restSec,failure,dropSet,notes$/);

    const cells = lines[1]!.split(',');
    assert.equal(cells[0], '2026-03-02');
    assert.equal(cells[5], 'Leg Press');
    assert.equal(cells[9], '577', 'the displayed weight');
    assert.equal(cells[10], 'lb', 'the unit the user chose');
    // The canonical kg value travels with it so a sheet can compare units.
    assert.equal(Number(cells[11]).toFixed(2), '261.72');
    assert.equal(cells[12], '8');
    assert.equal(cells[8], 'working');
    assert.equal(cells[16], 'false');
  });

  it('marks warmups in CSV rather than dropping them', async () => {
    await record(repos, '2026-03-02', [
      {
        name: 'Bench Press',
        sets: [
          { weight: 40, reps: 10, isWarmup: true },
          { weight: 60, reps: 8 },
        ],
      },
    ]);
    const lines = (await buildCsvExport(repos, { unit: 'kg' })).contents.trim().split('\n');
    assert.match(lines[1]!, /,warmup,/);
    assert.match(lines[2]!, /,working,/);
  });

  it('filters by date range and keeps the range in the file name', async () => {
    await record(repos, '2026-02-01', [{ name: 'Squat', sets: [{ weight: 100, reps: 5 }] }]);
    await record(repos, '2026-03-02', [{ name: 'Bench Press', sets: [{ weight: 60, reps: 8 }] }]);
    await record(repos, '2026-03-09', [{ name: 'Row', sets: [{ weight: 50, reps: 10 }] }]);

    const selected = await selectWorkouts(repos, { unit: 'kg', from: '2026-03-01', to: '2026-03-05' });
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.exercises[0]?.rawName, 'Bench Press');

    const result = await buildExport(
      repos,
      'csv',
      { unit: 'kg', from: '2026-03-01', to: '2026-03-05' },
      new Date('2026-03-10T00:00:00'),
    );
    assert.equal(result.workoutCount, 1);
    assert.match(result.fileName, /2026-03-01/);
  });

  it('produces an empty but well-formed document when there is nothing to export', async () => {
    const markdown = await buildMarkdownExport(repos, { unit: 'kg' });
    assert.equal(markdown.workoutCount, 0);
    assert.match(markdown.contents, /0 workouts/);

    const csv = await buildCsvExport(repos, { unit: 'kg' });
    assert.equal(csv.contents.trim().split('\n').length, 1, 'header only');
  });

  it('quotes CSV cells that would break a spreadsheet', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('has,comma'), '"has,comma"');
    assert.equal(csvCell('has"quote'), '"has""quote"');
    assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
    // Leading = + - @ would be executed as a formula by Excel/Sheets.
    assert.equal(csvCell('=1+1'), "'=1+1");
    assert.equal(csvCell('+SUM(A1)'), "'+SUM(A1)");
    assert.equal(csvCell('-2'), "'-2");
    assert.equal(csvCell('@import'), "'@import");
    assert.equal(csvCell('=cmd'), "'=cmd");
  });

  it('neutralises a formula typed into a set note', async () => {
    await record(repos, '2026-03-02', [
      { name: 'Squat', sets: [{ weight: 100, reps: 5, notes: '=HYPERLINK("http://x")' }] },
    ]);
    const csv = (await buildCsvExport(repos, { unit: 'kg' })).contents;
    assert.ok(!/,"?=HYPERLINK/.test(csv), 'the formula is not left executable');
    assert.match(csv, /'=HYPERLINK/);
  });

  it('names files for both formats', () => {
    const at = new Date('2026-03-04T10:00:00');
    assert.equal(exportFileName('markdown', at), 'fitagi-2026-03-04.md');
    assert.equal(exportFileName('csv', at), 'fitagi-2026-03-04.csv');
    assert.equal(exportFileName('csv', at, '2026-03-01'), 'fitagi-2026-03-01-2026-03-04.csv');
  });

  it('renders the same workout identically in both formats', async () => {
    await record(repos, '2026-03-02', [
      { name: 'Row', sets: [{ weight: 50, reps: 10 }] },
    ]);
    const markdown = await buildMarkdownExport(repos, { unit: 'kg' });
    const csv = await buildCsvExport(repos, { unit: 'kg' });
    assert.equal(markdown.workoutCount, csv.workoutCount);
    assert.equal(markdown.setCount, csv.setCount);
    assert.match(markdown.contents, /50 kg × 10/);
    assert.match(csv.contents, /,50,kg,50,10,/);
  });

  it('uses the local day for the date column', async () => {
    const late = new Date('2026-03-02T23:30:00');
    const base = createWorkout();
    const workout = await repos.training.put({
      ...base,
      startTime: late.toISOString(),
      endTime: new Date('2026-03-02T23:45:00').toISOString(),
      createdAt: late.toISOString(),
    });
    const entry = createExerciseEntry(workout.id, 'Row', 0);
    await repos.training.upsertExercise(workout.id, {
      ...entry,
      sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 10 }, 50, 'kg')],
    });
    await repos.training.complete(workout.id);

    const csv = (await buildCsvExport(repos, { unit: 'kg' })).contents;
    assert.match(csv, new RegExp(`^${localDateKey(late)},`, 'm'));
  });
});
