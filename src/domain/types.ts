/**
 * Core domain model.
 *
 * Design rule: "structure what is certain, keep the fuzzy parts as text."
 * We deliberately do not model every fitness semantic up front.
 */

export type WeightUnit = 'kg' | 'lb';

export type DistanceUnit = 'm' | 'km' | 'mi';

/** Shown on the About screen and stamped into every backup file. */
export const APP_VERSION = '0.9.0';

/** ISO-8601 UTC timestamp, e.g. 2026-02-14T09:31:00.000Z */
export type IsoTimestamp = string;

export interface SetEntry {
  id: string;
  /** Weight as the user typed it (display value), in `unit`. */
  weight: number | null;
  /** Weight normalized to kilograms for comparison/analytics. Derived, never a source of truth. */
  weightKg: number | null;
  /** Unit the weight was entered in. Preserved so history is never rewritten. */
  unit: WeightUnit;
  reps: number | null;
  durationSec: number | null;
  distance: number | null;
  distanceUnit: DistanceUnit | null;
  restSec: number | null;
  rpe: number | null;
  rir: number | null;
  isFailure: boolean;
  isWarmup: boolean;
  isDropSet: boolean;
  notes: string;
}

export interface ExerciseEntry {
  id: string;
  workoutId: string;
  /** Exactly what the user typed, e.g. "bench" or "倒蹬". */
  rawName: string;
  /** Resolved display/canonical name after alias rules, e.g. "卧推". */
  normalizedName: string;
  /** Position inside the workout, 0-based, contiguous after reorder. */
  order: number;
  notes: string;
  sets: SetEntry[];
  /** Sets sharing the same non-null value are performed as a superset. */
  supersetGroup: number | null;
}

export interface Workout {
  id: string;
  startTime: IsoTimestamp;
  /** null while the workout is still in progress. */
  endTime: IsoTimestamp | null;
  /**
   * Seconds. Derived from start/end when completed; while in progress it is a
   * live elapsed value. Kept on the record so history stays stable even if a
   * user later edits timestamps.
   */
  durationSec: number;
  notes: string;
  /** Optional; usually filled from a wearable/manual entry. */
  heartRate: number | null;
  exercises: ExerciseEntry[];
  /** false = training session currently being recorded. */
  completed: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * Derived data. Deleting a summary must never touch the raw workouts it came from.
 *
 * Summaries also chain: daily summaries are built from workouts, weekly summaries
 * from daily summaries, monthly from weekly. That is what keeps a month's summary
 * cheap — it never re-reads every workout, and it is never the whole month's JSON
 * handed to a model.
 */
export type SummaryKind = 'daily' | 'weekly' | 'monthly';

export interface SummaryHighlight {
  label: string;
  value: string;
}

export interface SummaryChange {
  exercise: string;
  text: string;
  direction: 'up' | 'down' | 'same';
}

export interface TrainingSummary {
  id: string;
  kind: SummaryKind;
  /**
   * Period key. Daily: YYYY-MM-DD. Weekly: YYYY-MM-DD of that week's Monday.
   * Monthly: YYYY-MM.
   */
  periodKey: string;
  /** Ready to render headline, e.g. "Legs and shoulders." */
  title: string;
  /** Plain-text body. Generated locally; an LLM may only rephrase it. */
  body: string;
  bullets: string[];
  highlights: SummaryHighlight[];
  changes: SummaryChange[];
  workoutIds: string[];
  /** How many sessions the period covered, including nested periods. */
  sessionCount: number;
  totalVolumeKg: number;
  totalDurationSec: number;
  source: 'auto' | 'llm';
  /** Set only when an LLM rewrote `body`. */
  llmBody?: string;
  generatedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type AiRole = 'recorder' | 'reminder' | 'coach';

/**
 * Visual themes.
 *
 * A theme is presentation only: colours, a pixel mascot and a set of motifs.
 * Adding one means adding a token set and a mascot — never touching a page. The
 * `ThemeId` union is the only place a theme is enumerated.
 */
export type ThemeId = 'ragdoll' | 'bunny' | 'panda' | 'orca';

/** Legacy light/dark preference, kept so older installs keep working. */
export type ColorScheme = 'system' | 'light' | 'dark';

export interface Settings {
  id: 'app';
  /** Unit used for new entries and for display. */
  defaultUnit: WeightUnit;
  /** false → the AI tab shows a configuration hint instead of a chat box. */
  aiEnabled: boolean;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  aiRole: AiRole;
  /** Visual theme. Independent of gender, units and everything else. */
  theme: ThemeId;
  /** UI language. `system` follows the device on first launch. */
  language: LanguagePreference;
  /** Legacy field from before themes existed; migrated into `theme` on read. */
  colorScheme?: ColorScheme;
  /**
   * User override for endpoints whose image support the app cannot infer.
   * `null` = let the model-name heuristic decide.
   */
  aiVisionOverride: boolean | null;
  /**
   * When the first-run permission walkthrough was completed.
   *
   * `null` on a fresh install, which is what brings the welcome screen up. A
   * timestamp rather than a boolean so "when did they agree to this" stays
   * answerable without another migration.
   */
  onboardedAt: IsoTimestamp | null;
}

/** `system` means "follow the device", which is the first-launch default. */
export type LanguagePreference = 'system' | 'zh-CN' | 'en' | 'es';

export type Gender = 'male' | 'female' | 'other' | 'undisclosed';

export type UnitSystem = 'metric' | 'imperial';

export type TrainingGoal =
  | 'fatLoss'
  | 'muscleGain'
  | 'strength'
  | 'endurance'
  | 'generalFitness'
  | 'maintain';

export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'high' | 'athlete';

/**
 * Optional user details.
 *
 * Every field is nullable: the app must be fully usable with none of it filled in.
 * `gender` exists solely to give the AI accurate context — it never influences the
 * theme, colours, icons or behaviour, and the two are stored side by side only
 * because they are both preferences.
 */
export interface UserProfile {
  id: 'profile';
  name: string;
  gender: Gender | null;
  /** Either an age or a birthday is enough; both are optional. */
  age: number | null;
  birthday: string | null;
  heightCm: number | null;
  weightKg: number | null;
  goalWeightKg: number | null;
  unitSystem: UnitSystem;
  trainingGoal: TrainingGoal | null;
  activityLevel: ActivityLevel | null;
  updatedAt: IsoTimestamp;
}

// -----------------------------------------------------------------------------
// Meals
// -----------------------------------------------------------------------------

/** Where a meal's numbers came from. */
export type MealSource = 'manual' | 'ai' | 'ai-edited';

/** One food inside a meal. A photo analysis usually produces several. */
export interface MealItem {
  id: string;
  name: string;
  portion: string;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

/**
 * A logged meal.
 *
 * Nutrition figures from a photo are **estimates**, which is why `source` and
 * `confidence` are stored: the UI must never present them as measured values.
 */
export interface Meal {
  id: string;
  /** When the food was eaten (user-editable), ISO-8601 UTC. */
  eatenAt: IsoTimestamp;
  /** Display title, e.g. "Chicken rice bowl". */
  name: string;
  /** Free-text portion for the whole meal, e.g. "1 bowl". */
  portion: string;
  items: MealItem[];
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  notes: string;
  source: MealSource;
  /** `high` / `medium` / `low` when the AI reported how sure it was. */
  confidence: 'high' | 'medium' | 'low' | null;
  /** Key of the stored image, if a photo was attached. */
  imageKey: string | null;
  /** The AI's own wording, kept for reference and shown in the detail view. */
  aiNote: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** A user-owned rename rule, e.g. { match: "bench", normalized: "卧推" }. */
export interface AliasRule {
  id: string;
  /** Lower-cased literal the rule matches against a raw exercise name. */
  match: string;
  normalized: string;
  createdAt: IsoTimestamp;
}

// ------------------------------------------------------------------ reminders

/**
 * What a reminder is about.
 *
 * It drives the label, the icon and where the notification opens, so a reminder is
 * never just a string: "log your meal" and "leg day" should take you to different
 * screens.
 */
export type ReminderKind = 'workout' | 'meal' | 'water' | 'weighIn' | 'rest' | 'custom';

/**
 * A scheduled local notification.
 *
 * The schedule is deliberately simple — a time of day plus a set of weekdays — because
 * that is what a training and food log actually needs ("weekdays at 19:00"). Anything
 * more expressive would be a cron editor in a gym app.
 */
export interface Reminder {
  id: string;
  title: string;
  body: string;
  kind: ReminderKind;
  /** `0` is Sunday, matching `Date.getDay()`. Empty means every day. */
  weekdays: number[];
  /** Local time of day, `"HH:MM"` in 24-hour form. */
  time: string;
  enabled: boolean;
  /** Whether the user typed it or accepted an AI proposal. */
  source: 'manual' | 'ai';
  /**
   * The id the operating system scheduled, so it can be cancelled or replaced.
   * `null` when the reminder has never been handed to the OS (permission refused,
   * browser, or not yet synced).
   */
  notificationId: number | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

// -------------------------------------------------------------- training plans

/** One prescribed exercise inside a plan day. */
export interface PlanExercise {
  id: string;
  /** Free text, matching how exercises are logged: there is no exercise library. */
  name: string;
  sets: number;
  /**
   * Text rather than a number: a prescription is "8-10" or "AMRAP" as often as it is
   * "5", and forcing it into a number would lose the intent.
   */
  reps: string;
  /** Optional target, always stored in kg so a unit switch never rewrites the plan. */
  targetWeightKg: number | null;
  notes: string;
}

/**
 * One day of a plan.
 *
 * A day belongs to a weekday, and a rest day is a real entry rather than an absent
 * one: "Thursday is rest" is a plan decision, and leaving the day out would make it
 * look like an oversight.
 */
export interface PlanDay {
  id: string;
  /** `0` is Sunday. */
  weekday: number;
  title: string;
  rest: boolean;
  exercises: PlanExercise[];
}

/** A weekly training plan. One plan is active at a time. */
export interface TrainingPlan {
  id: string;
  name: string;
  goal: TrainingGoal | null;
  days: PlanDay[];
  active: boolean;
  source: 'manual' | 'ai';
  notes: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
