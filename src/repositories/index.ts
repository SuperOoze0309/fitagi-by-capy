import { TrainingRepository } from './trainingRepository';
import { ExerciseRepository } from './exerciseRepository';
import { RuleRepository } from './ruleRepository';
import { ProfileRepository, SettingsRepository, SummaryRepository } from './settingsRepository';
import { MealRepository } from './mealRepository';
import { PlanRepository, ReminderRepository } from './planRepository';
import { getStorage, type StorageBundle } from '../storage';

/**
 * Single entry point to every repository.
 *
 * Pages import `repositories` and call methods directly — no global store, no
 * dependency injection container, no caching library. Repositories are stateless
 * wrappers around storage, so constructing them fresh is cheap.
 */
export interface Repositories {
  training: TrainingRepository;
  exercises: ExerciseRepository;
  rules: RuleRepository;
  settings: SettingsRepository;
  summaries: SummaryRepository;
  profile: ProfileRepository;
  meals: MealRepository;
  reminders: ReminderRepository;
  plans: PlanRepository;
}

let instance: Repositories | null = null;

/**
 * Build the repository set for a storage bundle.
 *
 * Everything is derived from the bundle's live scope, so a caller that swaps the
 * bundle (a test, or a future "switch storage engine" action) always gets handles
 * pointing at the current database rather than a closed one.
 */
export function buildRepositories(storage: StorageBundle): Repositories {
  const training = new TrainingRepository(storage.workouts);
  const kv = storage.scope.kv('settings');
  return {
    training,
    exercises: new ExerciseRepository(training),
    rules: new RuleRepository(storage.rules),
    settings: new SettingsRepository(kv),
    summaries: new SummaryRepository(storage.summaries),
    profile: new ProfileRepository(storage.scope.kv('profile')),
    meals: new MealRepository(storage.meals, storage.images),
    reminders: new ReminderRepository(storage.reminders),
    plans: new PlanRepository(storage.plans),
  };
}

export function initRepositories(): Repositories {
  if (instance) return instance;
  instance = buildRepositories(getStorage());
  return instance;
}

export function repositories(): Repositories {
  if (!instance) throw new Error('Repositories not initialised. Call initRepositories() first.');
  return instance;
}

/** Forget the singleton so a test can start from a clean slate. */
export function resetRepositoriesForTests(): void {
  instance = null;
}
