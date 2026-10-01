import type { Collection, KeyValueStore } from '../storage/adapter';
import type {
  Settings,
  SummaryKind,
  ThemeId,
  TrainingSummary,
  UserProfile,
} from '../domain/types';
import { nowIso } from '../domain/datetime';

export const SETTINGS_KEY = 'app';
export const PROFILE_KEY = 'userProfile';

export const DEFAULT_SETTINGS: Settings = {
  id: 'app',
  defaultUnit: 'kg',
  // AI stays off until the user configures an endpoint: with AI disabled every
  // core feature still works, which is the product's central promise.
  aiEnabled: false,
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: '',
  aiRole: 'recorder',
  // Kept in step with `DEFAULT_THEME_ID` by a test rather than by an import: the
  // repository layer has no business depending on the theme layer.
  theme: 'ragdoll',
  // Follow the device until the user picks a language explicitly.
  language: 'system',
  aiVisionOverride: null,
  // Null until the first-run permission walkthrough has been completed.
  onboardedAt: null,
};

/** Every field optional: the app must work with a completely empty profile. */
export const EMPTY_PROFILE: UserProfile = {
  id: 'profile',
  name: '',
  gender: null,
  age: null,
  birthday: null,
  heightCm: null,
  weightKg: null,
  goalWeightKg: null,
  unitSystem: 'metric',
  trainingGoal: null,
  activityLevel: null,
  updatedAt: '',
};

const THEME_IDS: ThemeId[] = ['ragdoll', 'bunny', 'panda', 'orca'];

/**
 * Normalise a stored settings document.
 *
 * This is the migration point for preferences. Data written by an older build can
 * be missing `theme`, `language` or `aiVisionOverride`, and can still carry the
 * pre-theme `colorScheme` field — so every field is resolved explicitly instead of
 * being merged blindly, and an unknown value falls back rather than propagating.
 */
export function normalizeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const source = stored ?? {};

  // `colorScheme` was the old light/dark preference. There is no direct mapping to
  // a themed palette, so the user simply gets the default theme rather than a
  // broken value; their choice of colours was cosmetic and no data is at risk.
  const theme: ThemeId = THEME_IDS.includes(source.theme as ThemeId)
    ? (source.theme as ThemeId)
    : DEFAULT_SETTINGS.theme;

  const language =
    source.language === 'system' ||
    source.language === 'zh-CN' ||
    source.language === 'en' ||
    source.language === 'es'
      ? source.language
      : DEFAULT_SETTINGS.language;

  const unit = source.defaultUnit === 'lb' ? 'lb' : 'kg';
  const role =
    source.aiRole === 'reminder' || source.aiRole === 'coach' || source.aiRole === 'recorder'
      ? source.aiRole
      : DEFAULT_SETTINGS.aiRole;

  return {
    id: 'app',
    defaultUnit: unit,
    aiEnabled: source.aiEnabled === true,
    aiBaseUrl: typeof source.aiBaseUrl === 'string' ? source.aiBaseUrl : '',
    aiApiKey: typeof source.aiApiKey === 'string' ? source.aiApiKey : '',
    aiModel: typeof source.aiModel === 'string' ? source.aiModel : '',
    aiRole: role,
    theme,
    language,
    aiVisionOverride:
      source.aiVisionOverride === true || source.aiVisionOverride === false
        ? source.aiVisionOverride
        : null,
    /*
     * Three cases, and they are not distinguishable by type alone:
     *
     *  - a real timestamp: the walkthrough has been completed;
     *  - the key exists and is null: a fresh install that has not completed it yet —
     *    this is what `ensureInitialized` itself writes, so treating "not a string" as
     *    "old document" made the flag skip straight to the legacy stamp and the
     *    welcome screen never appeared;
     *  - the key is absent: a document written before onboarding existed, whose owner
     *    already answered the permission prompts on a previous launch.
     */
    onboardedAt:
      typeof source.onboardedAt === 'string'
        ? source.onboardedAt
        : 'onboardedAt' in source
          ? null
          : stored === null || stored === undefined
            ? null
            : LEGACY_ONBOARDED_AT,
  };
}

/**
 * Stamp given to an install that predates onboarding.
 *
 * Any fixed non-null value ends the walkthrough; the epoch is honest about the fact
 * that it did not really happen.
 */
export const LEGACY_ONBOARDED_AT = '1970-01-01T00:00:00.000Z';

/** App preferences. Stored as one document; not in localStorage. */
export class SettingsRepository {
  /**
   * Serialises read-modify-write cycles.
   *
   * A patch is a read, a merge and a write, and the UI fires one per keystroke and
   * per toggle. Two of them overlapping both read the same snapshot and the second
   * write silently drops the first change — typing a base URL and then a model name
   * lost the URL. Chaining the patches means each one starts from the previous
   * result, so a burst of edits is applied in order.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: KeyValueStore) {}

  async get(): Promise<Settings> {
    return normalizeSettings(await this.store.get<Partial<Settings>>(SETTINGS_KEY));
  }

  async save(settings: Settings): Promise<Settings> {
    const next = normalizeSettings(settings);
    await this.store.set(SETTINGS_KEY, next);
    return next;
  }

  patch(patch: Partial<Settings>): Promise<Settings> {
    const run = this.queue.then(async () => {
      const current = await this.get();
      return this.save({ ...current, ...patch });
    });
    // The chain must survive a failed write, or every later patch would reject.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Ensure defaults exist so Settings always renders something sensible.
   *
   * When the stored document is missing fields, the normalised version is written
   * back — that is what completes a migration rather than re-deriving defaults on
   * every read.
   */
  async ensureInitialized(): Promise<Settings> {
    const stored = await this.store.get<Partial<Settings>>(SETTINGS_KEY);
    const normalized = normalizeSettings(stored);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(normalized)) {
      await this.store.set(SETTINGS_KEY, normalized);
    }
    return normalized;
  }
}

/** The user's optional details. One document; never required. */
export class ProfileRepository {
  /** See `SettingsRepository.queue`: the same lost-update race applies here. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: KeyValueStore) {}

  async get(): Promise<UserProfile> {
    return normalizeProfile(await this.store.get<Partial<UserProfile>>(PROFILE_KEY));
  }

  async save(profile: UserProfile): Promise<UserProfile> {
    const next = normalizeProfile({ ...profile, updatedAt: nowIso() });
    await this.store.set(PROFILE_KEY, next);
    return next;
  }

  patch(patch: Partial<UserProfile>): Promise<UserProfile> {
    const run = this.queue.then(async () => {
      const current = await this.get();
      return this.save({ ...current, ...patch });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Remove the profile entirely.
   *
   * It used to write an empty profile stamped with the current time, which is a
   * different thing: the store then held a profile that had just been "updated",
   * and a restore that carried no profile left a fresh timestamp behind instead of
   * the state the file describes. Deleting the row is what "no profile" means; a
   * read then returns the shared empty profile.
   */
  async clear(): Promise<UserProfile> {
    await this.store.remove(PROFILE_KEY);
    return EMPTY_PROFILE;
  }
}

const GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;
const GOALS = [
  'fatLoss',
  'muscleGain',
  'strength',
  'endurance',
  'generalFitness',
  'maintain',
] as const;
const ACTIVITY = ['sedentary', 'light', 'moderate', 'high', 'athlete'] as const;

/**
 * Normalise a stored profile.
 *
 * Missing or nonsensical values become `null` rather than 0 or NaN, because a
 * percentile of "0 kg bodyweight" would quietly corrupt every AI request.
 */
export function normalizeProfile(stored: Partial<UserProfile> | null | undefined): UserProfile {
  const source = stored ?? {};

  return {
    id: 'profile',
    name: typeof source.name === 'string' ? source.name : '',
    gender: GENDERS.includes(source.gender as (typeof GENDERS)[number])
      ? (source.gender as UserProfile['gender'])
      : null,
    age: positiveOrNull(source.age, 1, 130),
    birthday: typeof source.birthday === 'string' && source.birthday !== '' ? source.birthday : null,
    heightCm: positiveOrNull(source.heightCm, 30, 280),
    weightKg: positiveOrNull(source.weightKg, 10, 500),
    goalWeightKg: positiveOrNull(source.goalWeightKg, 10, 500),
    unitSystem: source.unitSystem === 'imperial' ? 'imperial' : 'metric',
    trainingGoal: GOALS.includes(source.trainingGoal as (typeof GOALS)[number])
      ? (source.trainingGoal as UserProfile['trainingGoal'])
      : null,
    activityLevel: ACTIVITY.includes(source.activityLevel as (typeof ACTIVITY)[number])
      ? (source.activityLevel as UserProfile['activityLevel'])
      : null,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
}

function positiveOrNull(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return Math.round(value * 10) / 10;
}

/**
 * Derived summaries: daily, weekly and monthly.
 *
 * They live in their own collection — never inside the workout records — so that
 * deleting a summary can never touch the raw training data it was derived from.
 * The SQLite schema mirrors `kind` so all three share one table.
 */
export class SummaryRepository {
  constructor(private readonly collection: Collection<TrainingSummary>) {}

  async all(): Promise<TrainingSummary[]> {
    const rows = await this.collection.all();
    // Newest period first; daily is the finest granularity so it sorts within a key.
    return rows.sort((a, b) => b.periodKey.localeCompare(a.periodKey));
  }

  async ofKind(kind: SummaryKind): Promise<TrainingSummary[]> {
    const rows = await this.all();
    return rows.filter((row) => row.kind === kind);
  }

  async get(kind: SummaryKind, periodKey: string): Promise<TrainingSummary | null> {
    const rows = await this.collection.all();
    return rows.find((row) => row.kind === kind && row.periodKey === periodKey) ?? null;
  }

  async latest(kind: SummaryKind): Promise<TrainingSummary | null> {
    const rows = await this.ofKind(kind);
    return rows[0] ?? null;
  }

  async save(summary: TrainingSummary): Promise<TrainingSummary> {
    await this.collection.put(summary);
    return summary;
  }

  /** Bulk write for a restore, so a long history is not one round trip per day. */
  async putMany(summaries: TrainingSummary[]): Promise<void> {
    if (summaries.length === 0) return;
    await this.collection.putMany(summaries);
  }

  async remove(id: string): Promise<void> {
    await this.collection.remove(id);
  }

  async clear(): Promise<void> {
    await this.collection.clear();
  }

  async count(): Promise<number> {
    return this.collection.count();
  }
}
