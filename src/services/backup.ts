import type {
  AliasRule,
  Meal,
  Reminder,
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
 * Parse and validate a backup file.
 *
 * Validation is intentionally strict about shape and forgiving about extras: a
 * backup written by a newer build must fail loudly rather than silently drop
 * fields the user expects to be restored.
 */
export function parseBackup(text: string): BackupDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupParseError('This file is not valid JSON.');
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new BackupParseError('This file does not contain a backup object.');
  }

  const candidate = raw as Partial<BackupDocument> & Record<string, unknown>;
  if (candidate.format !== BACKUP_FORMAT) {
    throw new BackupParseError(`This file is not a ${APP_NAME} backup.`);
  }

  const version = Number(candidate.version);
  if (!Number.isFinite(version) || version < 1) {
    throw new BackupParseError('This backup has no usable version number.');
  }
  if (version > BACKUP_VERSION) {
    throw new BackupParseError(
      `This backup was written by a newer version of the app (format ${version}). Update the app first.`,
    );
  }

  if (!Array.isArray(candidate.workouts)) {
    throw new BackupParseError('This backup has no workouts list.');
  }

  return {
    format: BACKUP_FORMAT,
    version,
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : nowIso(),
    app: {
      name: typeof candidate.app?.name === 'string' ? candidate.app.name : APP_NAME,
      version: typeof candidate.app?.version === 'string' ? candidate.app.version : 'unknown',
    },
    settings: normalizeBackupSettings(candidate.settings),
    workouts: candidate.workouts.filter(isWorkout),
    aliasRules: Array.isArray(candidate.aliasRules) ? candidate.aliasRules.filter(isAliasRule) : [],
    summaries: Array.isArray(candidate.summaries) ? candidate.summaries.filter(isSummary) : [],
    // Absent in a v1 backup, which is not an error: the user simply had no meals.
    meals: Array.isArray(candidate.meals) ? candidate.meals.filter(isMeal) : [],
    // Same for reminders and plans, which arrived in v3.
    reminders: Array.isArray(candidate.reminders)
      ? candidate.reminders.filter(isReminder)
      : [],
    plans: Array.isArray(candidate.plans) ? candidate.plans.filter(isPlan) : [],
    profile: isProfile(candidate.profile) ? candidate.profile : null,
  };
}

export type ImportMode = 'replace';

export interface ImportResult {
  summary: BackupSummary;
  settings: Settings;
}

/**
 * Apply a backup to local storage.
 *
 * `replace` is the only mode: a restore is expected to reproduce the backup
 * exactly, and merging two divergent histories silently is how people lose data.
 * The caller must confirm before calling this.
 */
export async function applyBackup(
  document: BackupDocument,
  options: { mode?: ImportMode; repos?: Repositories } = {},
): Promise<ImportResult> {
  const mode = options.mode ?? 'replace';
  if (mode !== 'replace') throw new Error(`Unsupported import mode: ${mode}`);

  const repos = options.repos ?? repositories();
  const storage = getStorage();
  const current = await repos.settings.get();

  await repos.training.clear();
  await repos.rules.clear();
  await repos.summaries.clear();
  await repos.meals.clear();
  await repos.reminders.clear();
  await repos.plans.clear();

  await repos.training.putMany(document.workouts);
  for (const rule of document.aliasRules) await repos.rules.save(rule);
  for (const summary of document.summaries) await repos.summaries.save(summary);
  await repos.meals.putMany(document.meals);
  await repos.reminders.putMany(document.reminders);
  await repos.plans.putMany(document.plans);

  // Photos are deliberately not part of a backup: they would multiply its size and
  // they are not the record. A restored meal keeps its numbers and loses its image.
  if (document.profile) await repos.profile.save(document.profile);

  // Keep the key that is already on this device: it is never part of a backup.
  const restored: Settings = {
    ...document.settings,
    id: 'app',
    aiApiKey: current.aiApiKey,
  };
  await repos.settings.save(restored);

  storage.invalidateCaches();

  return { summary: summarizeBackup(document), settings: restored };
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

function isWorkout(value: unknown): value is Workout {
  if (typeof value !== 'object' || value === null) return false;
  const workout = value as Partial<Workout>;
  return typeof workout.id === 'string' && typeof workout.startTime === 'string';
}

/** A meal is kept when it has an id and a timestamp; unknown extras are ignored. */
function isMeal(value: unknown): value is Meal {
  if (typeof value !== 'object' || value === null) return false;
  const meal = value as Partial<Meal>;
  return typeof meal.id === 'string' && typeof meal.eatenAt === 'string';
}

/** A reminder needs an id and a time; the repository re-normalises the rest. */
function isReminder(value: unknown): value is Reminder {
  if (typeof value !== 'object' || value === null) return false;
  const reminder = value as Partial<Reminder>;
  return typeof reminder.id === 'string' && typeof reminder.time === 'string';
}

/** A plan needs an id and a name; a week with no days is normalised on the way in. */
function isPlan(value: unknown): value is TrainingPlan {
  if (typeof value !== 'object' || value === null) return false;
  const plan = value as Partial<TrainingPlan>;
  return (
    typeof plan.id === 'string' && typeof plan.name === 'string' && Array.isArray(plan.days)
  );
}

/**
 * A profile is only accepted if it looks like one. Anything else becomes `null`
 * rather than being coerced, so a malformed file cannot write nonsense into the
 * live profile.
 */
function isProfile(value: unknown): value is UserProfile {
  if (typeof value !== 'object' || value === null) return false;
  const profile = value as Partial<UserProfile>;
  return profile.id === 'profile' || typeof profile.name === 'string';
}

function isAliasRule(value: unknown): value is AliasRule {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Partial<AliasRule>;
  return (
    typeof rule.id === 'string' &&
    typeof rule.match === 'string' &&
    typeof rule.normalized === 'string'
  );
}

function isSummary(value: unknown): value is TrainingSummary {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as Partial<TrainingSummary>;
  return (
    typeof summary.id === 'string' &&
    typeof summary.periodKey === 'string' &&
    (summary.kind === 'daily' || summary.kind === 'weekly' || summary.kind === 'monthly')
  );
}
