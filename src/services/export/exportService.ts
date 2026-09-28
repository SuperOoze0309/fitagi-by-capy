import type { WeightUnit, Workout } from '../../domain/types';
import { formatDuration, formatNumber, fromKg } from '../../domain/units';
import { formatDate, formatTime, localDateKey } from '../../domain/datetime';
import {
  bestSet,
  countWorkingSets,
  estimateOneRepMaxKg,
  workingSets,
  workoutVolumeKg,
} from '../../domain/metrics';
import { exerciseGroupKey } from '../../domain/workout';
import type { Repositories } from '../../repositories';

/**
 * Human-readable exports.
 *
 * JSON (see `services/backup.ts`) is the format for *restoring*. Markdown and CSV
 * are the formats for *reading* — pasting a block into a note, opening the CSV in a
 * spreadsheet, or handing a month to a coach. They are deliberately not importable,
 * and the UI says so.
 */

export type ExportFormat = 'markdown' | 'csv';

export interface ExportOptions {
  unit: WeightUnit;
  /** Inclusive start / end, as local day keys. Omitted means "everything". */
  from?: string;
  to?: string;
}

export interface ExportResult {
  fileName: string;
  contents: string;
  mimeType: string;
  workoutCount: number;
  setCount: number;
}

const MIME: Record<ExportFormat, string> = {
  markdown: 'text/markdown',
  csv: 'text/csv',
};

export function exportFileName(format: ExportFormat, at: Date, suffix?: string): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const extension = format === 'markdown' ? 'md' : 'csv';
  return `fitagi-${suffix ? `${suffix}-` : ''}${stamp}.${extension}`;
}

/** Workouts inside the requested range, oldest first so a document reads forwards. */
export async function selectWorkouts(
  repos: Repositories,
  options: ExportOptions,
): Promise<Workout[]> {
  const workouts = await repos.training.completed();
  return workouts
    .filter((workout) => {
      const day = localDateKey(workout.startTime);
      if (options.from && day < options.from) return false;
      if (options.to && day > options.to) return false;
      return true;
    })
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

// -----------------------------------------------------------------------------
// Markdown
// -----------------------------------------------------------------------------

export async function buildMarkdownExport(
  repos: Repositories,
  options: ExportOptions,
  now = new Date(),
): Promise<ExportResult> {
  const workouts = await selectWorkouts(repos, options);
  const summaries = await repos.summaries.all();
  const lines: string[] = [];

  lines.push('# FitAGI by Capy export');
  lines.push('');
  lines.push(`Exported ${formatDate(now.toISOString())} · ${workouts.length} workouts`);
  if (options.from || options.to) {
    lines.push(`Range: ${options.from ?? 'start'} → ${options.to ?? 'today'}`);
  }
  lines.push('');

  // Totals first: the number a reader looks for.
  const totals = aggregateForExport(workouts);
  lines.push('## Totals');
  lines.push('');
  lines.push(`- Sessions: ${workouts.length}`);
  lines.push(`- Working sets: ${totals.workingSets}`);
  lines.push(`- Volume: ${formatNumber(fromKg(totals.volumeKg, options.unit), 0)} ${options.unit}`);
  lines.push(`- Time: ${formatDuration(totals.durationSec)}`);
  lines.push('');

  if (totals.perExercise.length > 0) {
    lines.push('## Per exercise');
    lines.push('');
    lines.push('| Exercise | Sessions | Best set | e1RM | Volume |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of totals.perExercise) {
      const best = `${formatNumber(
        Math.round(fromKg(entry.bestWeightKg, options.unit) * 2) / 2,
      )} ${options.unit} × ${entry.bestReps ?? '—'}`;
      const oneRm = `${formatNumber(fromKg(entry.bestOneRmKg, options.unit), 0)} ${options.unit}`;
      const volume = `${formatNumber(fromKg(entry.volumeKg, options.unit), 0)} ${options.unit}`;
      lines.push(`| ${entry.name} | ${entry.sessions} | ${best} | ${oneRm} | ${volume} |`);
    }
    lines.push('');
  }

  lines.push('## Workouts');
  lines.push('');

  let setCount = 0;
  for (const workout of workouts) {
    const dayKey = localDateKey(workout.startTime);
    lines.push(`### ${formatDate(workout.startTime)} · ${formatTime(workout.startTime)}`);
    lines.push('');
    lines.push(
      `Duration ${formatDuration(workout.durationSec)} · ${countWorkingSets(workout)} working sets · ${formatNumber(
        fromKg(workoutVolumeKg(workout), options.unit),
        0,
      )} ${options.unit} volume`,
    );
    lines.push('');
    if (workout.notes.trim() !== '') {
      lines.push(`> ${workout.notes.trim().replace(/\n/g, '\n> ')}`);
      lines.push('');
    }

    for (const exercise of workout.exercises) {
      const name = exercise.normalizedName || exercise.rawName;
      lines.push(`**${name}**`);
      lines.push('');
      for (const set of exercise.sets) {
        setCount += 1;
        const flags = describeSetFlags(set.isWarmup, set.isDropSet, set.isFailure);
        const weight =
          set.weight === null ? 'bodyweight' : `${formatNumber(set.weight)} ${set.unit}`;
        const reps = set.reps === null ? '—' : String(set.reps);
        const effort = [
          set.rpe !== null ? `RPE ${formatNumber(set.rpe, 1)}` : '',
          set.rir !== null ? `RIR ${set.rir}` : '',
          set.restSec !== null && set.restSec > 0 ? `rest ${set.restSec}s` : '',
        ]
          .filter((part) => part !== '')
          .join(', ');
        lines.push(
          `- ${weight} × ${reps}${flags}${effort ? ` (${effort})` : ''}${
            set.notes ? ` — ${set.notes}` : ''
          }`,
        );
      }
      if (exercise.notes.trim() !== '') lines.push(`- _${exercise.notes.trim()}_`);
      lines.push('');
    }

    const daySummary = summaries.find(
      (summary) => summary.kind === 'daily' && summary.periodKey === dayKey,
    );
    if (daySummary) {
      lines.push(`_Summary: ${daySummary.title}_`);
      lines.push('');
    }
  }

  return {
    fileName: exportFileName('markdown', now, options.from),
    contents: `${lines.join('\n').trimEnd()}\n`,
    mimeType: MIME.markdown,
    workoutCount: workouts.length,
    setCount,
  };
}

function describeSetFlags(isWarmup: boolean, isDropSet: boolean, isFailure: boolean): string {
  const flags = [isWarmup ? 'warmup' : '', isDropSet ? 'drop set' : '', isFailure ? 'failure' : '']
    .filter((flag) => flag !== '')
    .join(', ');
  return flags === '' ? '' : ` _(${flags})_`;
}

// -----------------------------------------------------------------------------
// CSV
// -----------------------------------------------------------------------------

/**
 * One row per set — the shape a spreadsheet pivot wants.
 *
 * `weightKg` is exported alongside the displayed weight and unit so a sheet can
 * compare across units without doing the conversion itself.
 */
export async function buildCsvExport(
  repos: Repositories,
  options: ExportOptions,
  now = new Date(),
): Promise<ExportResult> {
  const workouts = await selectWorkouts(repos, options);
  const rows: string[][] = [];
  let setCount = 0;

  for (const workout of workouts) {
    let exerciseIndex = 0;
    for (const exercise of workout.exercises) {
      const name = exercise.normalizedName || exercise.rawName;
      let setIndex = 0;
      for (const set of exercise.sets) {
        setCount += 1;
        rows.push([
          localDateKey(workout.startTime),
          new Date(workout.startTime).toISOString(),
          workout.id,
          String(workout.durationSec),
          String(exerciseIndex),
          name,
          exercise.rawName,
          String(setIndex),
          set.isWarmup ? 'warmup' : 'working',
          set.weight === null ? '' : formatNumber(set.weight),
          set.weight === null ? '' : set.unit,
          set.weightKg === null ? '' : String(Number(set.weightKg.toFixed(4))),
          set.reps === null ? '' : String(set.reps),
          set.rpe === null ? '' : formatNumber(set.rpe, 1),
          set.rir === null ? '' : String(set.rir),
          set.restSec === null ? '' : String(set.restSec),
          set.isFailure ? 'true' : 'false',
          set.isDropSet ? 'true' : 'false',
          set.notes,
        ]);
        setIndex += 1;
      }
      exerciseIndex += 1;
    }
  }

  const header = [
    'date',
    'startedAt',
    'workoutId',
    'workoutDurationSec',
    'exerciseOrder',
    'exercise',
    'exerciseAsTyped',
    'setOrder',
    'setType',
    'weight',
    'unit',
    'weightKg',
    'reps',
    'rpe',
    'rir',
    'restSec',
    'failure',
    'dropSet',
    'notes',
  ];

  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));

  return {
    fileName: exportFileName('csv', now, options.from),
    contents: `${lines.join('\n')}\n`,
    mimeType: MIME.csv,
    workoutCount: workouts.length,
    setCount,
  };
}

/**
 * Quote a CSV cell.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a quote so a spreadsheet treats
 * user-entered text as text rather than as a formula (CSV injection).
 */
export function csvCell(value: string): string {
  const risky = /^[=+\-@\t\r]/.test(value);
  const safe = risky ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

// -----------------------------------------------------------------------------
// Shared aggregation
// -----------------------------------------------------------------------------

interface ExerciseTotals {
  name: string;
  sessions: number;
  workingSets: number;
  volumeKg: number;
  bestWeightKg: number;
  bestReps: number | null;
  bestOneRmKg: number;
}

function aggregateForExport(workouts: Workout[]): {
  workingSets: number;
  volumeKg: number;
  durationSec: number;
  perExercise: ExerciseTotals[];
} {
  const perExercise = new Map<string, ExerciseTotals>();
  let workingSetTotal = 0;
  let volumeKg = 0;
  let durationSec = 0;

  for (const workout of workouts) {
    durationSec += workout.durationSec;
    workingSetTotal += countWorkingSets(workout);
    volumeKg += workoutVolumeKg(workout);

    for (const exercise of workout.exercises) {
      const name = exercise.normalizedName || exercise.rawName;
      if (name === '') continue;
      const key = exerciseGroupKey(name);
      const entry =
        perExercise.get(key) ??
        {
          name,
          sessions: 0,
          workingSets: 0,
          volumeKg: 0,
          bestWeightKg: 0,
          bestReps: null,
          bestOneRmKg: 0,
        };

      entry.sessions += 1;
      entry.workingSets += workingSets(exercise.sets).length;
      entry.volumeKg += exercise.sets.reduce(
        (sum, set) =>
          sum + (set.isWarmup || set.weightKg === null || set.reps === null ? 0 : set.weightKg * set.reps),
        0,
      );

      const top = bestSet(exercise.sets);
      if (top?.weightKg != null && top.weightKg > entry.bestWeightKg) {
        entry.bestWeightKg = top.weightKg;
        entry.bestReps = top.reps;
      }
      const oneRm = top ? estimateOneRepMaxKg(top) : null;
      if (oneRm !== null && oneRm > entry.bestOneRmKg) entry.bestOneRmKg = oneRm;

      perExercise.set(key, entry);
    }
  }

  return {
    workingSets: workingSetTotal,
    volumeKg,
    durationSec,
    // Heaviest first: the lifts a reader cares about.
    perExercise: [...perExercise.values()].sort((a, b) => b.volumeKg - a.volumeKg),
  };
}

/** Build the requested format. */
export async function buildExport(
  repos: Repositories,
  format: ExportFormat,
  options: ExportOptions,
  now = new Date(),
): Promise<ExportResult> {
  return format === 'csv'
    ? buildCsvExport(repos, options, now)
    : buildMarkdownExport(repos, options, now);
}
