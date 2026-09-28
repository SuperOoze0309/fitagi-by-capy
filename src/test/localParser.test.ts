import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { looksLikeWorkout, parseWorkoutText } from '@/services/ai/localParser';
import type { ParsedWorkoutDraft } from '@/services/ai/provider';

function parse(text: string, unit: 'kg' | 'lb' = 'kg'): ParsedWorkoutDraft {
  return parseWorkoutText(text, { defaultUnit: unit });
}

/** Compact view of a draft, so expectations stay readable. */
function shape(draft: ParsedWorkoutDraft) {
  return draft.exercises.map((exercise) => ({
    name: exercise.rawName,
    sets: exercise.sets.map(
      (set) =>
        `${set.weight ?? '-'}${set.unit}x${set.reps ?? '-'}${set.isFailure ? 'F' : ''}${
          set.isWarmup ? 'W' : ''
        }${set.isDropSet ? 'D' : ''}${set.rpe !== null ? `@${set.rpe}` : ''}${
          set.rir !== null ? `+rir${set.rir}` : ''
        }`,
    ),
  }));
}

/**
 * The offline parser is what makes the natural-language input work with AI off, so
 * it is covered against the exact examples from the product spec.
 */
describe('offline workout parser', () => {
  it('handles the Chinese spec example: 卧推 60kg 8次 4组 最后一组力竭', () => {
    const draft = parse('卧推 60kg 8次 4组 最后一组力竭');
    assert.equal(draft.source, 'local');
    assert.deepEqual(shape(draft), [
      { name: '卧推', sets: ['60kgx8', '60kgx8', '60kgx8', '60kgx8F'] },
    ]);
    assert.deepEqual(draft.warnings, []);
    // Only the last set is flagged as failure.
    assert.equal(draft.exercises[0]!.sets.filter((set) => set.isFailure).length, 1);
  });

  it('handles the English rep-list example: bench 80 8 8 7 6 rir2', () => {
    const draft = parse('bench 80 8 8 7 6 rir2');
    assert.deepEqual(shape(draft), [
      { name: 'bench', sets: ['80kgx8+rir2', '80kgx8+rir2', '80kgx7+rir2', '80kgx6+rir2'] },
    ]);
    // RIR is a target for the whole exercise, so every set carries it.
    assert.ok(draft.exercises[0]!.sets.every((set) => set.rir === 2));
  });

  it('handles the lb spec example: 倒蹬577lb 8次4组', () => {
    const draft = parse('倒蹬577lb 8次4组');
    assert.deepEqual(shape(draft), [
      { name: '倒蹬', sets: ['577lbx8', '577lbx8', '577lbx8', '577lbx8'] },
    ]);
  });

  it('handles 5x5 notation as reps x sets', () => {
    const draft = parse('深蹲 100kg 5x5');
    assert.deepEqual(shape(draft), [
      { name: '深蹲', sets: ['100kgx5', '100kgx5', '100kgx5', '100kgx5', '100kgx5'] },
    ]);
  });

  it('handles spaced 组 and 次 markers', () => {
    const draft = parse('硬拉 140 kg 3 组 5 次');
    assert.equal(draft.exercises[0]!.rawName, '硬拉');
    assert.equal(draft.exercises[0]!.sets.length, 3);
    assert.deepEqual(
      draft.exercises[0]!.sets.map((set) => set.reps),
      [5, 5, 5],
    );
    assert.equal(draft.exercises[0]!.sets[0]!.weight, 140);
  });

  it('creates the right number of empty sets when reps are missing', () => {
    const draft = parse('腿举 200kg 4组');
    assert.equal(draft.exercises[0]!.sets.length, 4);
    assert.ok(draft.exercises[0]!.sets.every((set) => set.reps === null));
    assert.ok(draft.exercises[0]!.sets.every((set) => set.weight === 200));
  });

  it('handles bodyweight exercises', () => {
    const draft = parse('引体 自重 8次3组');
    assert.equal(draft.exercises[0]!.rawName, '引体');
    assert.equal(draft.exercises[0]!.sets.length, 3);
    assert.ok(draft.exercises[0]!.sets.every((set) => set.weight === null));
    assert.ok(draft.exercises[0]!.sets.every((set) => set.reps === 8));
  });

  it('parses warmup and drop set flags', () => {
    const draft = parse('卧推 40kg 10次 热身');
    assert.equal(draft.exercises[0]!.sets[0]!.isWarmup, true);
    const drop = parse('弯举 20kg 8次 递减');
    assert.equal(drop.exercises[0]!.sets[0]!.isDropSet, true);
  });

  it('parses RPE written as @8', () => {
    const draft = parse('卧推 60kg 8次 @8');
    assert.equal(draft.exercises[0]!.sets[0]!.rpe, 8);
  });

  it('splits multiple exercises on a separator', () => {
    const draft = parse('卧推 60kg 8次4组，深蹲 100kg 5次5组');
    assert.equal(draft.exercises.length, 2);
    assert.equal(draft.exercises[0]!.rawName, '卧推');
    assert.equal(draft.exercises[1]!.rawName, '深蹲');
    assert.equal(draft.exercises[0]!.sets.length, 4);
    assert.equal(draft.exercises[1]!.sets.length, 5);
  });

  it('uses the default unit when none is written', () => {
    assert.equal(parse('bench 60 8', 'kg').exercises[0]!.sets[0]!.unit, 'kg');
    assert.equal(parse('bench 60 8', 'lb').exercises[0]!.sets[0]!.unit, 'lb');
  });

  it('keeps unusable text as a note instead of guessing', () => {
    const draft = parse('今天状态不错，随便练了练');
    assert.equal(draft.exercises.length, 0);
    assert.equal(draft.notes, '今天状态不错，随便练了练');
    assert.match(draft.warnings[0] ?? '', /Could not find/);
  });

  it('puts trailing commentary into notes rather than dropping it', () => {
    const draft = parse('卧推 60kg 8次4组，感觉不错');
    assert.equal(draft.exercises.length, 1);
    assert.match(draft.notes, /感觉不错/);
  });

  it('warns instead of silently truncating a mismatch', () => {
    // Four rep values but the user said 6 sets: all stated reps are kept, and the
    // remaining sets are added blank rather than dropping what was written.
    const draft = parse('bench 80 8 8 7 6 6组');
    assert.equal(draft.exercises[0]!.sets.length, 6);
    assert.deepEqual(
      draft.exercises[0]!.sets.map((set) => set.reps),
      [8, 8, 7, 6, null, null],
    );
    assert.ok(draft.warnings.some((warning) => /remaining sets were left blank/.test(warning)));
  });

  it('uses every stated rep value when there are more than sets', () => {
    const draft = parse('bench 80 8 8 7 6 3组');
    assert.deepEqual(
      draft.exercises[0]!.sets.map((set) => set.reps),
      [8, 8, 7, 6],
    );
    assert.ok(draft.warnings.some((warning) => /3 sets/.test(warning)));
  });

  it('warns about an implausibly high set count', () => {
    const draft = parse('卧推 60kg 8次 99组');
    assert.ok(draft.warnings.some((warning) => /unusually high/.test(warning)));
  });

  it('never invents a weight', () => {
    const draft = parse('卧推 8次4组');
    assert.equal(draft.exercises[0]!.sets.length, 4);
    assert.ok(draft.exercises[0]!.sets.every((set) => set.weight === null));
    assert.ok(draft.warnings.some((warning) => /no weight/.test(warning)));
  });

  it('keeps the name in the user\'s own language', () => {
    assert.equal(parse('倒蹬 100kg 8次').exercises[0]!.rawName, '倒蹬');
    assert.equal(parse('Incline Bench 60kg 8次').exercises[0]!.rawName, 'Incline Bench');
  });

  it('detects whether text is worth parsing', () => {
    assert.equal(looksLikeWorkout('卧推 60kg 8次'), true);
    assert.equal(looksLikeWorkout('bench 80 8 8'), true);
    assert.equal(looksLikeWorkout('just some prose'), false);
  });
});
