import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  convertWeight,
  formatClock,
  formatDuration,
  formatNumber,
  formatWeight,
  fromKg,
  kgToLb,
  lbToKg,
  parseNumberInput,
  roundDisplayWeight,
  toKg,
} from '@/domain/units';
import { exerciseVolumeKg, bestSet, countWorkingSets, estimateOneRepMaxKg, workoutVolumeKg } from '@/domain/metrics';
import { createExerciseEntry, createSetFromPrevious, createWorkout, withSetWeight } from '@/domain/workout';

/**
 * Display formatting. These numbers are what the user reads on every screen, and a
 * regression here is invisible to the type checker, so every case is pinned.
 */
describe('formatNumber', () => {
  it('keeps trailing zeros that are part of the integer', () => {
    // Regression: a naive trailing-zero strip rendered 500 as "5" and 1000 as "1",
    // which made every volume readout ten times too small.
    assert.equal(formatNumber(500, 0), '500');
    assert.equal(formatNumber(1000, 0), '1000');
    assert.equal(formatNumber(480, 0), '480');
    assert.equal(formatNumber(1380), '1380');
    assert.equal(formatNumber(60), '60');
    assert.equal(formatNumber(10, 0), '10');
    assert.equal(formatNumber(2000, 0), '2000');
  });

  it('still drops zeros from a fractional part', () => {
    assert.equal(formatNumber(62.5), '62.5');
    assert.equal(formatNumber(62.5, 0), '63');
    assert.equal(formatNumber(60.0), '60');
    assert.equal(formatNumber(1.5, 0), '2');
  });

  it('rounds to the requested decimals', () => {
    assert.equal(formatNumber(577.44, 1), '577.4');
    assert.equal(formatNumber(577.45, 1), '577.5');
    assert.equal(formatNumber(100.6, 0), '101');
  });

  it('renders nothing for a missing value', () => {
    assert.equal(formatNumber(null), '');
    assert.equal(formatNumber(undefined), '');
    assert.equal(formatNumber(Number.NaN), '');
  });
});

describe('formatWeight', () => {
  it('appends the unit and marks a missing value', () => {
    assert.equal(formatWeight(60, 'kg'), '60 kg');
    assert.equal(formatWeight(577, 'lb'), '577 lb');
    assert.equal(formatWeight(null, 'kg'), '—');
  });
});

describe('unit conversion', () => {
  it('converts between kg and lb', () => {
    assert.equal(Math.round(lbToKg(100) * 1000) / 1000, 45.359);
    assert.equal(Math.round(kgToLb(45.359237)), 100);
    assert.equal(convertWeight(60, 'kg', 'lb').toFixed(1), '132.3');
    assert.equal(convertWeight(60, 'kg', 'kg'), 60);
  });

  it('normalizes to kg for storage', () => {
    assert.equal(toKg(100, 'kg'), 100);
    assert.equal(Math.round(toKg(100, 'lb') * 1000) / 1000, 45.359);
    assert.equal(Math.round(fromKg(45.359237, 'lb')), 100);
    assert.equal(fromKg(45.359237, 'kg'), 45.359237);
  });

  it('rounds display weights to a usable step', () => {
    assert.equal(roundDisplayWeight(62.3, 'kg'), 62.5);
    assert.equal(roundDisplayWeight(62.1, 'kg'), 62);
    assert.equal(roundDisplayWeight(577.4, 'lb'), 577);
    assert.equal(roundDisplayWeight(577.6, 'lb'), 578);
  });

  it('parses typed numbers, including a comma decimal separator', () => {
    assert.equal(parseNumberInput('60'), 60);
    assert.equal(parseNumberInput('62,5'), 62.5);
    assert.equal(parseNumberInput(' 12 '), 12);
    assert.equal(parseNumberInput(''), null);
    assert.equal(parseNumberInput('abc'), null);
  });
});

describe('duration formatting', () => {
  it('formats elapsed time', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(45), '45s');
    assert.equal(formatDuration(90), '1m 30s');
    assert.equal(formatDuration(4500), '1h 15m');
  });

  it('formats a clock', () => {
    assert.equal(formatClock(0), '00:00');
    assert.equal(formatClock(75), '01:15');
    // Past an hour the clock grows a field rather than running to 61 minutes:
    // a two-hour session reading "120:00" is harder to scan at a glance.
    assert.equal(formatClock(3661), '1:01:01');
  });
});

describe('volume and 1RM', () => {
  it('computes volume in kg regardless of the display unit', () => {
    const lbSet = withSetWeight({ ...createSetFromPrevious(undefined, 'lb'), reps: 8 }, 100, 'lb');
    const exercise = { ...createExerciseEntry('w1', 'Leg Press', 0), sets: [lbSet] };
    const expected = 100 * 0.45359237 * 8;
    assert.ok(Math.abs(exerciseVolumeKg(exercise) - expected) < 0.01);

    const workout = { ...createWorkout(), exercises: [exercise] };
    assert.ok(Math.abs(workoutVolumeKg(workout) - expected) < 0.01);
  });

  it('excludes warmups from volume and working sets', () => {
    const warmup = withSetWeight(
      { ...createSetFromPrevious(undefined, 'kg'), reps: 10, isWarmup: true },
      40,
      'kg',
    );
    const work = withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 60, 'kg');
    const exercise = { ...createExerciseEntry('w1', 'Bench Press', 0), sets: [warmup, work] };
    const workout = { ...createWorkout(), exercises: [exercise] };

    assert.equal(countWorkingSets(workout), 1);
    assert.equal(workoutVolumeKg(workout), 480);
  });

  it('estimates one rep max and picks the best set', () => {
    const heavy = withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 3 }, 100, 'kg');
    const light = withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 10 }, 60, 'kg');
    assert.ok((estimateOneRepMaxKg(heavy) ?? 0) > (estimateOneRepMaxKg(light) ?? 0));
    assert.equal(bestSet([light, heavy])?.weight, 100);
    assert.equal(bestSet([]), null);
  });

  it('renders a large volume correctly through the whole chain', () => {
    // The end-to-end shape of the bug that shipped: 5 sets of 100 kg x 10 reps.
    const workout = createWorkout();
    const sets = Array.from({ length: 5 }, () =>
      withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 10 }, 100, 'kg'),
    );
    const exercise = { ...createExerciseEntry(workout.id, 'Squat', 0), sets };
    const volume = workoutVolumeKg({ ...workout, exercises: [exercise] });
    assert.equal(volume, 5000);
    assert.equal(formatNumber(volume, 0), '5000');
  });
});
