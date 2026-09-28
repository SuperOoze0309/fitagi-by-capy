import type { UserProfile } from '../../domain/types';
import { fromKg, formatNumber, lbToKg } from '../../domain/units';

/**
 * User context.
 *
 * The point of this module is that AI requests carry a *short summary* of who the
 * user is instead of their whole history. It is rebuilt from whatever the profile
 * actually contains, so a blank profile produces no block at all rather than a
 * page of "unknown" lines.
 *
 * Gender lives here and nowhere else: it is context for the model, never an input
 * to theming or behaviour.
 */

/** Metric values, resolved from the profile's own unit system. */
export interface ProfileMetrics {
  heightCm: number;
  weightKg: number;
  goalWeightKg: number | null;
  age: number | null;
}

/**
 * Resolve the profile into metric values.
 *
 * `unitSystem` decides how the stored numbers are *interpreted*: a user who chose
 * imperial typed feet/inches and pounds, so a stored `weightKg: 130` means 130 lb
 * for them. This is the one place that conversion happens.
 */
export function resolveMetrics(profile: UserProfile): ProfileMetrics {
  const imperial = profile.unitSystem === 'imperial';
  // In imperial mode the stored weight is pounds; in metric mode it is kilograms.
  const weightKg = profile.weightKg === null ? 0 : imperial ? lbToKg(profile.weightKg) : profile.weightKg;
  const goalWeightKg =
    profile.goalWeightKg === null ? null : imperial ? lbToKg(profile.goalWeightKg) : profile.goalWeightKg;

  return {
    // Height is always stored in centimetres; the form converts for display.
    heightCm: profile.heightCm ?? 0,
    weightKg,
    goalWeightKg,
    age: resolveAge(profile),
  };
}

/** Prefer a directly entered age; otherwise derive it from the birthday. */
export function resolveAge(profile: UserProfile, now = new Date()): number | null {
  if (profile.age !== null) return profile.age;
  if (!profile.birthday) return null;

  const born = parsePlainDate(profile.birthday);
  if (!born) return null;

  let age = now.getFullYear() - born.getFullYear();
  // This year's birthday has not happened yet, so the person is one year younger.
  const monthDiff = now.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) age -= 1;
  return age >= 0 && age <= 130 ? age : null;
}

/**
 * Parse a `YYYY-MM-DD` date input as a **local** calendar date.
 *
 * `new Date('2005-06-16')` is parsed as UTC midnight, which in a timezone behind
 * UTC becomes the previous day — an off-by-one birthday and therefore an
 * off-by-one age. Building the date from its parts avoids that entirely.
 */
export function parsePlainDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Translation keys, so the AI sees English while the UI stays localised. */
const GENDER_LABEL: Record<NonNullable<UserProfile['gender']>, string> = {
  male: 'male',
  female: 'female',
  other: 'other',
  undisclosed: 'not disclosed',
};

const GOAL_LABEL: Record<NonNullable<UserProfile['trainingGoal']>, string> = {
  fatLoss: 'fat loss',
  muscleGain: 'muscle gain',
  strength: 'strength',
  endurance: 'endurance',
  generalFitness: 'general fitness',
  maintain: 'maintain',
};

const ACTIVITY_LABEL: Record<NonNullable<UserProfile['activityLevel']>, string> = {
  sedentary: 'sedentary',
  light: 'lightly active',
  moderate: 'moderately active',
  high: 'very active',
  athlete: 'athlete',
};

/**
 * Build the profile block.
 *
 * Returns an empty string when nothing is filled in, and `buildUserContext`
 * then omits the section entirely — an AI prompt should not announce "Sex:
 * unknown" to the model, it should simply say less.
 */
export function buildProfileBlock(profile: UserProfile): string {
  const metrics = resolveMetrics(profile);
  const lines: string[] = [];
  const imperial = profile.unitSystem === 'imperial';

  if (profile.name.trim() !== '') lines.push(`Name: ${profile.name.trim()}`);
  if (profile.gender) lines.push(`Sex: ${GENDER_LABEL[profile.gender]}`);
  if (metrics.age !== null) lines.push(`Age: ${metrics.age}`);

  if (metrics.heightCm > 0) lines.push(`Height: ${formatNumber(metrics.heightCm, 1)} cm`);
  if (metrics.weightKg > 0) {
    lines.push(
      `Weight: ${formatNumber(metrics.weightKg, 1)} kg${
        imperial ? ` (${formatNumber(profile.weightKg ?? 0, 1)} lb as entered)` : ''
      }`,
    );
  }
  if (metrics.goalWeightKg !== null && metrics.goalWeightKg > 0) {
    lines.push(`Goal weight: ${formatNumber(metrics.goalWeightKg, 1)} kg`);
  }
  if (profile.trainingGoal) lines.push(`Goal: ${GOAL_LABEL[profile.trainingGoal]}`);
  if (profile.activityLevel) lines.push(`Activity level: ${ACTIVITY_LABEL[profile.activityLevel]}`);

  return lines.join('\n');
}

/**
 * The context block as it is sent to a model.
 *
 * `includeProfile: false` is used by callers that already know the profile is
 * irrelevant, and an empty profile yields an empty string so the caller can skip
 * the heading.
 */
export function buildUserContext(profile: UserProfile): string {
  const block = buildProfileBlock(profile);
  if (block === '') return '';
  return `## User profile\n${block}`;
}

/** True when at least one field is filled in. */
export function hasProfile(profile: UserProfile): boolean {
  return buildProfileBlock(profile) !== '';
}

/**
 * A one-line description used in place of a full profile when space is tight,
 * e.g. as a caption on the meal analysis sheet.
 */
export function describeWeightForDisplay(profile: UserProfile): string {
  if (profile.weightKg === null) return '';
  const imperial = profile.unitSystem === 'imperial';
  return imperial
    ? `${formatNumber(profile.weightKg, 1)} lb`
    : `${formatNumber(fromKg(profile.weightKg, 'kg'), 1)} kg`;
}
