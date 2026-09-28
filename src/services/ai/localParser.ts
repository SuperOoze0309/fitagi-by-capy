import type { WeightUnit } from '../../domain/types';
import type { ParsedExercise, ParsedSet, ParsedWorkoutDraft } from './provider';

/**
 * Offline workout parser.
 *
 * This is the fallback that makes the natural-language input useful with AI
 * switched off, and it is also the first thing tried when AI *is* on — a local
 * match costs nothing, is instant, and cannot hallucinate.
 *
 * Supported shapes (Chinese and English, mixed freely):
 *
 *   卧推 60kg 8次 4组 最后一组力竭
 *   bench 80 8 8 7 6 rir2
 *   倒蹬577lb 8次4组
 *   深蹲 100kg 5x5
 *   硬拉 140 kg 3 组 5 次
 *   引体 自重 8次3组
 *
 * Anything it cannot parse is returned as `unparsed` text rather than being
 * guessed at, and the caller keeps the raw input as a workout note.
 */

export interface LocalParseOptions {
  /** Unit to use when the text does not say. */
  defaultUnit: WeightUnit;
}

const UNIT_PATTERN = /(kg|kgs|公斤|千克|lb|lbs|磅)/i;
const FAILURE_WORDS = /(力竭|失败|fail|failure|to failure|amrap)/i;
const WARMUP_WORDS = /(热身|warmup|warm-up|warm up)/i;
const DROP_WORDS = /(递减|降重|drop\s?set|dropset|drop)/i;
const BODYWEIGHT_WORDS = /(自重|徒手|bodyweight|body weight|bw)/i;

/** Trailing "last set to failure" style qualifier. */
const LAST_SET_QUALIFIER = /(最后(一)?组|last set|最后一组)/i;

/** Exercise-name noise we should drop when it is clearly a connector. */
const CONNECTOR = /^[的和与及,，、+\s]+|[的和与及,，、+\s]+$/g;

/**
 * Parse one line of free text into exercises.
 *
 * Multi-exercise input ("卧推 60kg 8次4组，深蹲 100kg 5次5组") is split on
 * Chinese/English separators.
 */
export function parseWorkoutText(text: string, options: LocalParseOptions): ParsedWorkoutDraft {
  const source = text.trim();
  if (source === '') {
    return { exercises: [], notes: '', warnings: [], source: 'local', unparsed: '' };
  }

  const segments = splitSegments(source);
  const exercises: ParsedExercise[] = [];
  const warnings: string[] = [];
  const leftovers: string[] = [];

  for (const segment of segments) {
    const parsed = parseSegment(segment, options.defaultUnit);
    if (parsed) {
      exercises.push(parsed.exercise);
      warnings.push(...parsed.warnings);
    } else if (segment.trim() !== '') {
      leftovers.push(segment.trim());
    }
  }

  // Nothing recognizable: keep the text as a note so it is never lost.
  if (exercises.length === 0) {
    return {
      exercises: [],
      notes: source,
      warnings: ['Could not find an exercise, weight or reps in that text.'],
      source: 'local',
      unparsed: source,
    };
  }

  return {
    exercises,
    notes: leftovers.join(' '),
    warnings,
    source: 'local',
    unparsed: leftovers.join(' '),
  };
}

/** Split on separators between exercises, but never inside a number range. */
function splitSegments(text: string): string[] {
  return text
    .split(/[，,;；\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

interface SegmentResult {
  exercise: ParsedExercise;
  warnings: string[];
}

function parseSegment(segment: string, defaultUnit: WeightUnit): SegmentResult | null {
  const warnings: string[] = [];

  const unitMatch = UNIT_PATTERN.exec(segment);
  const unit: WeightUnit = unitMatch
    ? /lb|磅/i.test(unitMatch[1]!)
      ? 'lb'
      : 'kg'
    : defaultUnit;

  const isFailure = FAILURE_WORDS.test(segment);
  const isWarmup = WARMUP_WORDS.test(segment);
  const isDropSet = DROP_WORDS.test(segment);
  const isBodyweight = BODYWEIGHT_WORDS.test(segment);
  // A trailing qualifier applies to the last set only.
  const lastSetOnly = LAST_SET_QUALIFIER.test(segment);

  // Extract numbers *with* their trailing marker so we can tell 60kg from 8次
  // from a bare 8 in a rep list. Text spans already used are recorded so the rep
  // scan cannot re-read them.
  const weight = extractWeight(segment, isBodyweight);
  const groupMatch = /(\d+(?:\.\d+)?)\s*(?:组|sets?|groups?)/i.exec(segment);
  const timesGroup = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i.exec(segment);
  // Effort labels carry small numbers ("rir2", "@8") that must not be read as reps.
  const rpeMatch = /(?:rpe|@)\s*(\d+(?:\.\d+)?)/i.exec(segment);
  const rirMatch = /(?:rir)\s*(\d+(?:\.\d+)?)/i.exec(segment);
  const claimed: ClaimedRange[] = [
    claimMatch(groupMatch),
    claimMatch(timesGroup),
    claimMatch(rpeMatch),
    claimMatch(rirMatch),
    ...weight.matches,
  ].filter((range): range is ClaimedRange => range !== null);

  const repList = extractRepList(segment, claimed);
  const rpe = rpeMatch ? Number(rpeMatch[1]) : null;
  const rir = rirMatch ? Number(rirMatch[1]) : null;

  const name = extractName(segment);
  if (name === '' || (!weight.value && repList.length === 0 && !groupMatch && !timesGroup)) {
    return null;
  }

  /**
   * Turn the numbers found into one reps value per set.
   *
   * Precedence, most explicit first:
   *   1. "8次"            -> [8]
   *   2. "8 8 7 6"        -> [8, 8, 7, 6]   (a rep list, one per set)
   *   3. "5x5"            -> 5 reps, 5 sets
   *   4. "4组"            -> 4 sets with reps left blank
   *
   * A single rep value always repeats across all sets. Only blank reps are ever
   * invented: a number the user did not write is never guessed.
   */
  const statedSets = groupMatch ? Math.round(Number(groupMatch[1])) : 0;
  let reps: number[];

  if (timesGroup && repList.length === 0) {
    const perSet = Number(timesGroup[1]);
    const setCount = Math.round(Number(timesGroup[2]));
    reps = Array.from({ length: Math.max(1, setCount) }, () => perSet);
  } else if (repList.length === 1 && statedSets > 1) {
    reps = Array.from({ length: statedSets }, () => repList[0]!);
  } else if (repList.length > 0 && statedSets > repList.length) {
    // Fewer rep values than stated sets: keep every value and blank the rest.
    reps = [...repList, ...Array.from({ length: statedSets - repList.length }, () => Number.NaN)];
    warnings.push(
      `${name}: ${repList.length} rep values for ${statedSets} sets — the remaining sets were left blank.`,
    );
  } else if (repList.length > 0) {
    reps = repList;
  } else if (statedSets > 0) {
    reps = Array.from({ length: statedSets }, () => Number.NaN);
  } else {
    reps = [Number.NaN];
  }

  if (reps.length !== statedSets && statedSets > 0 && repList.length > statedSets) {
    warnings.push(`${name}: found ${repList.length} rep values but ${statedSets} sets; used all of them.`);
  }
  if (reps.length > 20) {
    warnings.push(`${name}: ${reps.length} sets looks unusually high — please check.`);
  }

  const setCount = reps.length;
  const sets: ParsedSet[] = Array.from({ length: setCount }, (_, index) => {
    const value = reps[index];
    const setReps = value === undefined || Number.isNaN(value) ? null : value;
    const isLast = index === setCount - 1;
    const applyToThisSet = !lastSetOnly || isLast;
    return {
      weight: weight.value,
      unit,
      reps: setReps,
      rpe: applyToThisSet ? rpe : null,
      rir: applyToThisSet ? rir : null,
      isFailure: isFailure && applyToThisSet,
      isWarmup,
      isDropSet,
    };
  });

  if (weight.value === null && !isBodyweight) {
    warnings.push(`${name}: no weight found — sets were created without one.`);
  }

  return { exercise: { rawName: name, sets }, warnings };
}

interface WeightMatch {
  value: number | null;
  /** Character spans consumed by the weight, so the rep scan skips them. */
  matches: ClaimedRange[];
}

/**
 * Find a weight: a number carrying a unit, or a bare number that is too large to
 * be reps (e.g. "bench 80 8 8 7 6").
 */
function extractWeight(segment: string, isBodyweight: boolean): WeightMatch {
  const withUnit = /(\d+(?:\.\d+)?)\s*(?:kg|kgs|公斤|千克|lb|lbs|磅)/i.exec(segment);
  if (withUnit) return { value: Number(withUnit[1]), matches: claimAll(claimMatch(withUnit)) };

  const beforeUnit = /(?:kg|kgs|公斤|千克|lb|lbs|磅)\s*(\d+(?:\.\d+)?)/i.exec(segment);
  if (beforeUnit) return { value: Number(beforeUnit[1]), matches: claimAll(claimMatch(beforeUnit)) };

  if (isBodyweight) return { value: null, matches: [] };

  // No unit anywhere: treat a number > 20 as the weight, because nobody logs 80
  // reps. Rep lists in practice start with the smallest number.
  const numbers = [...segment.matchAll(/\d+(?:\.\d+)?/g)];
  const candidate = numbers.find((match) => Number(match[0]) > 20);
  if (candidate && numbers.length > 1) {
    return { value: Number(candidate[0]), matches: claimAll(claimMatch(candidate)) };
  }
  return { value: null, matches: [] };
}

function claimAll(range: ClaimedRange | null): ClaimedRange[] {
  return range ? [range] : [];
}

/**
 * Collect reps: explicit "8次" values first, then a bare run of small numbers,
 * which is how "bench 80 8 8 7 6" is written.
 *
 * Numbers already claimed by the weight, the set count ("6组") and the "5x5" form
 * are excluded by position rather than by re-testing substrings, which is what
 * makes "bench 80 8 8 7 6 6组" resolve to four reps and six sets.
 */
function extractRepList(segment: string, claimed: ClaimedRange[]): number[] {
  const explicit = [...segment.matchAll(/(\d+(?:\.\d+)?)\s*(?:次|reps?|rep|下)/gi)]
    .filter((match) => !isClaimed(match.index, match[0].length, claimed))
    .map((match) => Number(match[1]));
  if (explicit.length > 0) return explicit;

  return [...segment.matchAll(/\d+(?:\.\d+)?/g)]
    .filter((match) => !isClaimed(match.index, match[0].length, claimed))
    .map((match) => Number(match[0]))
    // Rep counts are small; anything larger is a weight or a different number.
    .filter((value) => value > 0 && value <= 20);
}

interface ClaimedRange {
  start: number;
  end: number;
}

function isClaimed(start: number, length: number, claimed: ClaimedRange[]): boolean {
  const end = start + length;
  return claimed.some((range) => start < range.end && end > range.start);
}

function claimMatch(match: RegExpExecArray | null): ClaimedRange | null {
  if (!match || match.index === undefined) return null;
  return { start: match.index, end: match.index + match[0].length };
}

/** The exercise name: the text before the first number or flag word. */
function extractName(segment: string): string {
  const firstNumber = segment.search(/\d/);
  const flagIndex = searchAny(segment, [FAILURE_WORDS, WARMUP_WORDS, BODYWEIGHT_WORDS]);
  const cutoffs = [firstNumber, flagIndex].filter((index) => index >= 0);
  const end = cutoffs.length > 0 ? Math.min(...cutoffs) : segment.length;
  const name = segment.slice(0, end).replace(CONNECTOR, '').trim();
  if (name !== '') return name;

  // Text like "自重 8次3组" has the name after the flag; fall back to the text
  // between the flag and the first number.
  const afterFlag = segment.slice(flagIndex).replace(/\d.*$/, '');
  return afterFlag.replace(CONNECTOR, '').trim();
}

function searchAny(text: string, patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const index = text.search(pattern);
    if (index >= 0) return index;
  }
  return -1;
}

/** True when the text looks like a workout at all, used to enable the parse button. */
export function looksLikeWorkout(text: string): boolean {
  return /\d/.test(text) && extractName(text.split(/[，,;；\n]+/)[0] ?? '') !== '';
}
