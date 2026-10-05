import type {
  AliasRule,
  ExerciseEntry,
  Meal,
  MealItem,
  PlanDay,
  PlanExercise,
  Reminder,
  SetEntry,
  Settings,
  TrainingPlan,
  TrainingSummary,
  UserProfile,
  Workout,
} from '../domain/types';
import { APP_VERSION } from '../domain/types';
import { nowIso } from '../domain/datetime';
import { repositories, type Repositories } from '../repositories';
import { normalizeSettings as normalizeStoredSettings } from '../repositories/settingsRepository';
import { getStorage } from '../storage';

/**
 * JSON backup / restore.
 *
 * This is the single most important feature of a purely local app: if the user
 * cannot get their data out, the data is not really theirs. The format is plain,
 * readable JSON so a backup stays useful even without this app.
 *
 * Rules:
 *  - the document carries a `format` marker and a version, so a future change can
 *    migrate rather than guess;
 *  - the API key is **never** written to a backup (privacy by construction);
 *  - import is explicit and previewed before it touches anything;
 *  - raw workouts are always restored, derived summaries are optional.
 */
/**
 * The backup `format` marker is frozen.
 *
 * It is how an existing file is recognised as ours, so renaming the product must
 * not touch it: every backup a user has ever exported still carries this string.
 */
export const BACKUP_FORMAT = 'fitness-agent-backup';
export const BACKUP_VERSION = 1;

/** The product name that goes into the file's `app` block, for display only. */
export const APP_NAME = 'FitAGI by Capy';

export interface BackupDocument {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  app: { name: string; version: string };
  settings: Omit<Settings, 'aiApiKey'> & { aiApiKey?: never };
  workouts: Workout[];
  aliasRules: AliasRule[];
  summaries: TrainingSummary[];
  /** Meals added in v2. A v1 backup simply has none. */
  meals: Meal[];
  /** Reminders and plans added in v3; absent in anything older. */
  reminders: Reminder[];
  plans: TrainingPlan[];
  /** Optional profile. Never required; `null` when it was empty. */
  profile: UserProfile | null;
}

export interface BackupSummary {
  workouts: number;
  exercises: number;
  sets: number;
  aliasRules: number;
  summaries: number;
  meals: number;
  reminders: number;
  plans: number;
  exportedAt: string;
  appVersion: string;
}

/**
 * Build a backup document from everything currently stored.
 *
 * The repository set is injectable so this can be exercised directly in tests
 * against any storage adapter.
 */
export async function createBackup(repos: Repositories = repositories()): Promise<BackupDocument> {
  const [settings, workouts, aliasRules, summaries, meals, reminders, plans, profile] =
    await Promise.all([
      repos.settings.get(),
      repos.training.all(),
      repos.rules.all(),
      repos.summaries.all(),
      repos.meals.all(),
      repos.reminders.all(),
      repos.plans.all(),
      repos.profile.get(),
    ]);

  // Explicitly destructure the key out so it can never leak into the file.
  const { aiApiKey: _omitted, ...safeSettings } = settings;
  void _omitted;

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: nowIso(),
    app: { name: APP_NAME, version: APP_VERSION },
    settings: safeSettings,
    workouts,
    aliasRules,
    summaries,
    meals,
    reminders,
    plans,
    // An untouched profile is written as null rather than an all-empty object.
    profile: hasProfileContent(profile) ? profile : null,
  };
}

/** True when the user has actually filled something in. */
export function hasProfileContent(profile: UserProfile): boolean {
  return (
    profile.name.trim() !== '' ||
    profile.gender !== null ||
    profile.age !== null ||
    profile.birthday !== null ||
    profile.heightCm !== null ||
    profile.weightKg !== null ||
    profile.goalWeightKg !== null ||
    profile.trainingGoal !== null ||
    profile.activityLevel !== null
  );
}

export function serializeBackup(document: BackupDocument): string {
  return JSON.stringify(document, null, 2);
}

/** `fitagi-2026-02-14-0931.json` — sorts chronologically in a file list. */
export function backupFileName(exportedAt: string, extension = 'json'): string {
  const date = new Date(exportedAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`;
  return `fitagi-${stamp}.${extension}`;
}

export function summarizeBackup(document: BackupDocument): BackupSummary {
  let exercises = 0;
  let sets = 0;
  for (const workout of document.workouts) {
    exercises += workout.exercises.length;
    for (const exercise of workout.exercises) sets += exercise.sets.length;
  }
  return {
    workouts: document.workouts.length,
    exercises,
    sets,
    aliasRules: document.aliasRules.length,
    summaries: document.summaries.length,
    meals: document.meals.length,
    reminders: document.reminders.length,
    plans: document.plans.length,
    exportedAt: document.exportedAt,
    appVersion: document.app?.version ?? 'unknown',
  };
}

export class BackupParseError extends Error {}

/**
 * The restore itself failed. Unlike a parse error this one is about storage, and the
 * message always says what state the data was left in, because that is the only thing
 * the person reading it actually needs to know.
 */
export class BackupRestoreError extends Error {}

/**
 * Parse and validate a backup file.
 *
 * Strict: a file whose records are the wrong shape is refused with the list of
 * places that are wrong, rather than having rows filtered out on the way in. A
 * restore that silently drops a workout the user can see in their file is worse than
 * one that refuses the file — the first looks like success.
 */
export function parseBackup(text: string): BackupDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupParseError('This file is not valid JSON.');
  }

  const result = validateBackup(raw);
  if (!result.ok) {
    throw new BackupParseError(
      `This backup cannot be restored:\n${describeBackupProblems(result.problems).join('\n')}`,
    );
  }
  return result.document;
}

export type ImportMode = 'replace';

export interface ImportResult {
  summary: BackupSummary;
  settings: Settings;
}

/**
 * One problem found in an incoming file, with the path it was found at.
 *
 * Validation reports *every* problem rather than the first, because the person
 * holding the file needs to know what is wrong with it, and a restore that stops at
 * the first bad row teaches them nothing about the rest.
 */
export interface BackupProblem {
  path: string;
  message: string;
}

/** A validated backup, ready to be applied or shown as a preview. */
export interface ParsedBackup {
  ok: true;
  document: BackupDocument;
  problems: [];
}

export interface RejectedBackup {
  ok: false;
  problems: BackupProblem[];
}

/**
 * Check a file before anything is written.
 *
 * The old shape check accepted any object with an `id` and a `startTime`, which let
 * a corrupt file through: a workout whose `exercises` was missing reached the
 * preview and crashed it, a reminder with `weekdays: 7` was accepted and blew up
 * during restore — *after* the existing data had been cleared. Records are now
 * checked for the shape the app actually reads, dates have to be parseable, numbers
 * have to be numbers, and duplicate ids are refused. Problems are returned, not
 * filtered out: silently dropping a record the user can see in their file is how a
 * restore appears to succeed while losing data.
 */
export function validateBackup(input: unknown): ParsedBackup | RejectedBackup {
  const problems: BackupProblem[] = [];
  const problem = (path: string, message: string) => problems.push({ path, message });

  if (typeof input !== 'object' || input === null) {
    return { ok: false, problems: [{ path: '', message: 'The file does not contain a backup object.' }] };
  }

  const candidate = input as Partial<BackupDocument> & Record<string, unknown>;
  if (candidate.format !== BACKUP_FORMAT) {
    return {
      ok: false,
      problems: [{ path: 'format', message: `Not a ${APP_NAME} backup file.` }],
    };
  }

  const version = Number(candidate.version);
  if (!Number.isFinite(version) || version < 1) {
    return { ok: false, problems: [{ path: 'version', message: 'No usable version number.' }] };
  }
  if (version > BACKUP_VERSION) {
    return {
      ok: false,
      problems: [
        {
          path: 'version',
          message: `Written by a newer version of the app (format ${version}). Update the app first.`,
        },
      ],
    };
  }

  const collections: [keyof BackupDocument, string, boolean][] = [
    ['workouts', 'workouts', true],
    ['aliasRules', 'aliasRules', false],
    ['summaries', 'summaries', false],
    ['meals', 'meals', false],
    ['reminders', 'reminders', false],
    ['plans', 'plans', false],
  ];
  for (const [key, label, required] of collections) {
    const value = candidate[key];
    if (value === undefined && !required) continue; // absent in an older format
    if (!Array.isArray(value)) {
      problem(String(key), `${label} must be a list${required ? '' : ' when present'}.`);
    }
  }

  if (Array.isArray(candidate.workouts)) {
    candidate.workouts.forEach((workout, index) => checkWorkout(workout, `workouts[${index}]`, problem));
  }
  if (Array.isArray(candidate.meals)) {
    candidate.meals.forEach((meal, index) => checkMeal(meal, `meals[${index}]`, problem));
  }
  if (Array.isArray(candidate.reminders)) {
    candidate.reminders.forEach((reminder, index) =>
      checkReminder(reminder, `reminders[${index}]`, problem),
    );
  }
  if (Array.isArray(candidate.plans)) {
    candidate.plans.forEach((plan, index) => checkPlan(plan, `plans[${index}]`, problem));
  }
  if (Array.isArray(candidate.summaries)) {
    candidate.summaries.forEach((summary, index) =>
      checkSummary(summary, `summaries[${index}]`, problem),
    );
  }
  if (Array.isArray(candidate.aliasRules)) {
    candidate.aliasRules.forEach((rule, index) => checkAliasRule(rule, `aliasRules[${index}]`, problem));
  }
  if (candidate.profile !== null && candidate.profile !== undefined) {
    checkProfile(candidate.profile, 'profile', problem);
  }

  // Duplicate ids would make "restore reproduces the file exactly" untrue: the second
  // row silently wins, and the counts in the preview disagree with what is stored.
  for (const [key, label] of [
    ['workouts', 'workouts'],
    ['meals', 'meals'],
    ['reminders', 'reminders'],
    ['plans', 'plans'],
    ['summaries', 'summaries'],
    ['aliasRules', 'alias rules'],
  ] as const) {
    const value = candidate[key];
    if (!Array.isArray(value)) continue;
    const seen = new Set<string>();
    value.forEach((entry, index) => {
      const id = (entry as { id?: unknown })?.id;
      if (typeof id !== 'string') return;
      if (seen.has(id)) problem(`${String(key)}[${index}].id`, `Duplicate id "${id}" in ${label}.`);
      seen.add(id);
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  /*
   * Every record passed, so the records can be taken as they are. `normalizeBackup`
   * still runs for settings, which is where defaults belong.
   */
  const document: BackupDocument = {
    format: BACKUP_FORMAT,
    version,
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : nowIso(),
    app: {
      name: typeof candidate.app?.name === 'string' ? candidate.app.name : APP_NAME,
      version: typeof candidate.app?.version === 'string' ? candidate.app.version : 'unknown',
    },
    settings: normalizeBackupSettings(candidate.settings),
    workouts: candidate.workouts as Workout[],
    aliasRules: (candidate.aliasRules ?? []) as AliasRule[],
    summaries: (candidate.summaries ?? []) as TrainingSummary[],
    meals: (candidate.meals ?? []) as Meal[],
    reminders: (candidate.reminders ?? []) as Reminder[],
    plans: (candidate.plans ?? []) as TrainingPlan[],
    profile: (candidate.profile ?? null) as UserProfile | null,
  };

  return { ok: true, document, problems: [] };
}

/** Human-readable one-liners for the UI, capped so a broken file cannot flood it. */
export function describeBackupProblems(problems: BackupProblem[], limit = 12): string[] {
  const lines = problems
    .slice(0, limit)
    .map((entry) => (entry.path === '' ? entry.message : `${entry.path}: ${entry.message}`));
  if (problems.length > limit) {
    lines.push(`… and ${problems.length - limit} more.`);
  }
  return lines;
}

type ProblemReporter = (path: string, message: string) => void;

function checkWorkout(value: unknown, path: string, problem: ProblemReporter): void {
  if (typeof value !== 'object' || value === null) {
    problem(path, 'Not a workout object.');
    return;
  }
  const workout = value as Partial<Workout>;
  if (typeof workout.id !== 'string' || workout.id === '') problem(`${path}.id`, 'Missing id.');
  if (!isParseableDate(workout.startTime)) {
    problem(`${path}.startTime`, 'Missing or unparseable start time.');
  }
  if (workout.endTime != null && !isParseableDate(workout.endTime)) {
    problem(`${path}.endTime`, 'End time is not a date.');
  }
  if (!Array.isArray(workout.exercises)) {
    problem(`${path}.exercises`, 'Missing exercise list.');
    return;
  }
  workout.exercises.forEach((exercise, exerciseIndex) => {
    const exercisePath = `${path}.exercises[${exerciseIndex}]`;
    if (typeof exercise !== 'object' || exercise === null) {
      problem(exercisePath, 'Not an exercise object.');
      return;
    }
    const entry = exercise as Partial<ExerciseEntry>;
    if (typeof entry.id !== 'string' || entry.id === '') problem(`${exercisePath}.id`, 'Missing id.');
    if (typeof entry.rawName !== 'string' || entry.rawName.trim() === '') {
      problem(`${exercisePath}.rawName`, 'Missing exercise name.');
    }
    if (!Array.isArray(entry.sets)) {
      problem(`${exercisePath}.sets`, 'Missing set list.');
      return;
    }
    entry.sets.forEach((set, setIndex) => {
      const setPath = `${exercisePath}.sets[${setIndex}]`;
      if (typeof set !== 'object' || set === null) {
        problem(setPath, 'Not a set object.');
        return;
      }
      const record = set as Partial<SetEntry>;
      if (record.weight != null && !isFiniteNumber(record.weight)) {
        problem(`${setPath}.weight`, 'Weight is not a number.');
      }
      if (record.reps != null && !isFiniteNumber(record.reps)) {
        problem(`${setPath}.reps`, 'Reps is not a number.');
      }
      if (record.unit != null && record.unit !== 'kg' && record.unit !== 'lb') {
        problem(`${setPath}.unit`, 'Unit must be kg or lb.');
      }
    });
  });
}

function checkMeal(value: unknown, path: string, problem: ProblemReporter): void {
  if (typeof value !== 'object' || value === null) {
    problem(path, 'Not a meal object.');
    return;
  }
  const meal = value as Partial<Meal>;
  if (typeof meal.id !== 'string' || meal.id === '') problem(`${path}.id`, 'Missing id.');
  if (!isParseableDate(meal.eatenAt)) problem(`${path}.eatenAt`, 'Missing or unparseable time.');
  if (meal.items !== undefined && !Array.isArray(meal.items)) {
    problem(`${path}.items`, 'Items must be a list.');
    return;
  }
  (meal.items ?? []).forEach((item, itemIndex) => {
    const itemPath = `${path}.items[${itemIndex}]`;
    if (typeof item !== 'object' || item === null) {
      problem(itemPath, 'Not a meal item.');
      return;
    }
    const entry = item as Partial<MealItem>;
    if (typeof entry.name !== 'string') problem(`${itemPath}.name`, 'Missing food name.');
    for (const field of ['calories', 'proteinG', 'carbsG', 'fatG'] as const) {
      const number = entry[field];
      if (number != null && !isFiniteNumber(number)) {
        problem(`${itemPath}.${field}`, 'Not a number.');
      }
    }
  });
}

function checkReminder(value: unknown, path: string, problem: ProblemReporter): void {
  if (typeof value !== 'object' || value === null) {
    problem(path, 'Not a reminder object.');
    return;
  }
  const reminder = value as Partial<Reminder>;
  if (typeof reminder.id !== 'string' || reminder.id === '') problem(`${path}.id`, 'Missing id.');
  if (typeof reminder.time !== 'string' || !/^\d{1,2}:\d{2}$/.test(reminder.time)) {
    problem(`${path}.time`, 'Time must look like 07:30.');
  }
  if (reminder.weekdays !== undefined) {
    if (!Array.isArray(reminder.weekdays)) {
      problem(`${path}.weekdays`, 'Weekdays must be a list of numbers.');
    } else {
      reminder.weekdays.forEach((day, index) => {
        if (!Number.isInteger(day) || day < 0 || day > 6) {
          problem(`${path}.weekdays[${index}]`, 'Weekday must be 0–6.');
        }
      });
    }
  }
}

function checkPlan(value: unknown, path: string, problem: ProblemReporter): void {
  if (typeof value !== 'object' || value === null) {
    problem(path, 'Not a plan object.');
    return;
  }
  const plan = value as Partial<TrainingPlan>;
  if (typeof plan.id !== 'string' || plan.id === '') problem(`${path}.id`, 'Missing id.');
  if (typeof plan.name !== 'string') problem(`${path}.name`, 'Missing plan name.');
  if (!Array.isArray(plan.days)) {
    problem(`${path}.days`, 'Missing day list.');
    return;
  }
  plan.days.forEach((day, dayIndex) => {
    const dayPath = `${path}.days[${dayIndex}]`;
    if (typeof day !== 'object' || day === null) {
      problem(dayPath, 'Not a plan day.');
      return;
    }
    const entry = day as Partial<PlanDay>;
    if (!Number.isInteger(entry.weekday) || (entry.weekday ?? -1) < 0 || (entry.weekday ?? 7) > 6) {
      problem(`${dayPath}.weekday`, 'Weekday must be 0–6.');
    }
    if (entry.exercises !== undefined && !Array.isArray(entry.exercises)) {
      problem(`${dayPath}.exercises`, 'Exercises must be a list.');
      return;
    }
    (entry.exercises ?? []).forEach((exercise, exerciseIndex) => {
      const exercisePath = `${dayPath}.exercises[${exerciseIndex}]`;
      if (typeof exercise !== 'object' || exercise === null) {
        problem(exercisePath, 'Not a planned exercise.');
        return;
      }
      const planned = exercise as Partial<PlanExercise>;
      if (typeof planned.name !== 'string' || planned.name.trim() === '') {
        problem(`${exercisePath}.name`, 'Missing exercise name.');
      }
      if (planned.sets != null && !isFiniteNumber(planned.sets)) {
        problem(`${exercisePath}.sets`, 'Sets is not a number.');
      }
    });
  });
}

function checkSummary(value: unknown, path: string, problem: ProblemReporter): void {
  if (typeof value !== 'object' || value === null) {
    problem(path, 'Not a summary object.');
    return;
  }
  const summary = value as Partial<TrainingSummary>;
  if (typeof summary.id !== 'string' || summary.id === '') problem(`${path}.id`, 'Missing id.');
  if (summary.kind !== 'daily' && summary.kind !== 'weekly' && summary.kind !== 'monthly') {
    problem(`${path}.kind`, 'Kind must be daily, weekly or monthly.');
  }
  if (typeof summary.periodKey !== 'string' || summary.periodKey === '') {
    problem(`${path}.periodKey`, 'Missing period key.');
  }
}

function checkAliasRule(value: unknown, path: string, problem: ProblemReporter): void {
  if (typeof value !== 'object' || value === null) {
    problem(path, 'Not an alias rule.');
    return;
  }
  const rule = value as Partial<AliasRule>;
  if (typeof rule.id !== 'string' || rule.id === '') problem(`${path}.id`, 'Missing id.');
  if (typeof rule.match !== 'string' || rule.match.trim() === '') {
    problem(`${path}.match`, 'Missing match text.');
  }
  if (typeof rule.normalized !== 'string' || rule.normalized.trim() === '') {
    problem(`${path}.normalized`, 'Missing replacement name.');
  }
}

function checkProfile(value: unknown, path: string, problem: ProblemReporter): void {
  if (typeof value !== 'object' || value === null) {
    problem(path, 'Profile must be an object or null.');
    return;
  }
  const profile = value as Partial<UserProfile>;
  if (profile.name !== undefined && typeof profile.name !== 'string') {
    problem(`${path}.name`, 'Name must be text.');
  }
  if (profile.unitSystem !== undefined && profile.unitSystem !== 'metric' && profile.unitSystem !== 'imperial') {
    problem(`${path}.unitSystem`, 'Unit system must be metric or imperial.');
  }
  for (const field of ['heightCm', 'weightKg', 'goalWeightKg'] as const) {
    const number = profile[field];
    if (number != null && typeof number !== 'number') {
      problem(`${path}.${field}`, 'Must be a number or null.');
    }
  }
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isParseableDate(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  if (value.includes('NaN')) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Apply a backup to local storage.
 *
 * `replace` is the only mode: a restore is expected to reproduce the backup
 * exactly, and merging two divergent histories silently is how people lose data.
 * The caller must confirm before calling this.
 *
 * The restore is all-or-nothing in practice, and the ordering is what makes that
 * true. Every incoming collection is written **before** anything is cleared, so a
 * failed restore has not destroyed anything yet; the previous contents are read into
 * a journal and the clears happen last, one collection at a time, so a clear that
 * fails is followed by writing the journal back. The old code cleared six
 * collections and only then wrote — a single failed write left the user with an
 * empty app and no way back.
 *
 * Photos are removed by key (`image:<mealId>`) rather than read into memory, so a
 * journal never contains image data, and the deliberate rule that meals keep their
 * numbers after a restore is unchanged.
 */
export async function applyBackup(
  document: BackupDocument,
  options: { mode?: ImportMode; repos?: Repositories } = {},
): Promise<ImportResult> {
  const mode = options.mode ?? 'replace';
  if (mode !== 'replace') throw new Error(`Unsupported import mode: ${mode}`);

  /*
   * Last line of defence: a document that did not come through `parseBackup` (a
   * caller building one by hand, a future import path) is validated here, before the
   * first write. Bad input must never reach the storage layer.
   */
  const validation = validateBackup(document);
  if (!validation.ok) {
    throw new BackupParseError(
      `This backup cannot be restored:\n${describeBackupProblems(validation.problems).join('\n')}`,
    );
  }

  const repos = options.repos ?? repositories();
  const storage = getStorage();
  const current = await repos.settings.get();
  const currentProfile = await repos.profile.get();

  /*
   * The journal is read *before* the first write. Reading it later would capture a
   * half-restored database, which is worth nothing: the point of a journal is to
   * remember what the user had.
   */
  const journal = await readJournal(repos);

  try {
    // 1. Write everything, before anything is destroyed.
    await repos.training.putMany(document.workouts);
    await repos.rules.putMany(document.aliasRules);
    await repos.summaries.putMany(document.summaries);
    await repos.meals.putMany(document.meals);
    await repos.reminders.putMany(document.reminders);
    await repos.plans.putMany(document.plans);

    if (document.profile) {
      await repos.profile.save(document.profile);
    } else {
      // Replace means replace: a backup with no profile restores no profile, rather
      // than leaving the previous person's details on the device.
      await repos.profile.clear();
    }

    // 2. Remove what the incoming backup does not contain, one collection at a time.
    await removeAbsent(repos.training, document.workouts.map((row) => row.id), 'workouts');
    await removeAbsent(repos.rules, document.aliasRules.map((row) => row.id), 'alias rules');
    await removeAbsent(repos.summaries, document.summaries.map((row) => row.id), 'summaries');
    await removeAbsent(repos.meals, document.meals.map((row) => row.id), 'meals');
    await removeAbsent(repos.reminders, document.reminders.map((row) => row.id), 'reminders');
    await removeAbsent(repos.plans, document.plans.map((row) => row.id), 'plans');

    /*
     * 3. Photos. A backup never carries them, so a restored meal has none: the rows
     * that are now gone are exactly the keys that have to go too. Removed by key so
     * the image data is never read, copied or held in memory.
     */
    const keepPhotoKeys = new Set(document.meals.map((meal) => `image:${meal.id}`));
    for (const meal of journal.meals) {
      const key = `image:${meal.id}`;
      if (!keepPhotoKeys.has(key)) await storage.images.remove(key);
    }

    // A key belongs to its endpoint. A backup must not redirect an existing key.
    const sameEndpoint = sameAiEndpoint(current.aiBaseUrl, document.settings.aiBaseUrl);
    const restored: Settings = {
      ...document.settings,
      id: 'app',
      aiApiKey: sameEndpoint ? current.aiApiKey : '',
      aiEnabled: sameEndpoint && document.settings.aiEnabled,
    };
    await repos.settings.save(restored);

    storage.invalidateCaches();
    return { summary: summarizeBackup(document), settings: restored };
  } catch (error) {
    await rollback(repos, storage, { journal, previous: currentProfile });
    throw new BackupRestoreError(
      `The restore failed and the previous data was put back. Nothing was lost. (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

/** Compare URL trust scopes, retaining path and query differences. */
export function sameAiEndpoint(first: string, second: string): boolean {
  const canonical = (input: string): string | null => {
    try {
      const url = new URL(input.trim());
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
      url.pathname = url.pathname.replace(/\/+$/, '');
      return url.toString();
    } catch { return null; }
  };
  if (first.trim() === '' && second.trim() === '') return true;
  const a = canonical(first);
  return a !== null && a === canonical(second);
}

/** Everything currently stored, used to undo a partially applied restore. */
async function readJournal(repos: Repositories) {
  return {
    workouts: await repos.training.all(),
    rules: await repos.rules.all(),
    summaries: await repos.summaries.all(),
    meals: await repos.meals.all(),
    reminders: await repos.reminders.all(),
    plans: await repos.plans.all(),
  };
}

type Journal = Awaited<ReturnType<typeof readJournal>>;

/**
 * Put the database back the way it was: restore every journal row and remove the
 * rows the failed attempt introduced.
 */
async function rollback(
  repos: Repositories,
  storage: ReturnType<typeof getStorage>,
  state: { journal: Journal; previous: UserProfile | null },
): Promise<void> {
  const journal = state.journal;
  const failures: string[] = [];

  const attempt = async (label: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const restoreCollection = async <T extends { id: string }>(
    label: string,
    collection: { all(): Promise<T[]>; putMany(rows: T[]): Promise<void>; remove(id: string): Promise<void> },
    rows: T[],
  ) => {
    await attempt(label, async () => {
      await collection.putMany(rows);
      const keep = new Set(rows.map((row) => row.id));
      for (const existing of await collection.all()) {
        if (!keep.has(existing.id)) await collection.remove(existing.id);
      }
    });
  };

  await restoreCollection('workouts', repos.training, journal.workouts);
  await restoreCollection('alias rules', repos.rules, journal.rules);
  await restoreCollection('summaries', repos.summaries, journal.summaries);
  await restoreCollection('meals', repos.meals, journal.meals);
  await restoreCollection('reminders', repos.reminders, journal.reminders);
  await restoreCollection('plans', repos.plans, journal.plans);
  await attempt('profile', async () => {
    if (state.previous) await repos.profile.save(state.previous);
    else await repos.profile.clear();
  });

  storage.invalidateCaches();

  if (failures.length > 0) {
    // Both the restore and the undo failed. Say so; do not pretend otherwise.
    throw new BackupRestoreError(
      `The restore failed and putting the previous data back also failed (${failures.join('; ')}). Reopen the app before recording anything, and restore from a backup file if the app looks empty.`,
    );
  }
}

/** Remove the stored rows this backup does not contain. */
async function removeAbsent<T extends { id: string }>(
  collection: { all(): Promise<T[]>; remove(id: string): Promise<void> },
  keepIds: string[],
  label: string,
): Promise<void> {
  const keep = new Set(keepIds);
  const existing = await collection.all();
  for (const row of existing) {
    if (!keep.has(row.id)) await collection.remove(row.id);
  }
  void label;
}


// -----------------------------------------------------------------------------
// Validation helpers — defensive, because the input is a user-chosen file.
// -----------------------------------------------------------------------------

/**
 * Validate the settings block of an incoming file.
 *
 * This deliberately delegates to the repository's normaliser rather than keeping a
 * second copy of the rules. It used to have its own, and the two drifted the moment
 * a theme was added: a stored preference was accepted by one and silently reset by
 * the other.
 *
 * The returned object has no `aiApiKey` field at all, so the key cannot be
 * serialised into a file even by accident.
 */
function normalizeBackupSettings(input: unknown): Omit<Settings, 'aiApiKey'> {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Partial<Settings>;
  const { aiApiKey: _omitted, ...safe } = normalizeStoredSettings(source);
  void _omitted;
  return safe;
}

