import type {
  TrainingSummary,
  SummaryKind,
  WeightUnit,
  Workout,
} from '../../domain/types';
import { localDateKey, nowIso } from '../../domain/datetime';
import { bestSet } from '../../domain/metrics';
import { exerciseGroupKey } from '../../domain/workout';
import type { Repositories } from '../../repositories';
import {
  buildDailySummary,
  buildRollupSummary,
  monthKey,
  monthWeekKeys,
  previousPeriodKey,
  weekKey,
  weekDayKeys,
  type SummaryContext,
} from './buildSummary';

/** Bounded so a very long history cannot make a page load slow. */
const CATCH_UP_DAY_LIMIT = 400;

/**
 * Summary generation, bottom-up.
 *
 *   refreshDaily(dateKey)   -> rebuilds that day, then the week, then the month
 *   refreshWeek(weekKey)    -> rebuilds that week, then the month
 *   refreshMonth(monthKey)  -> rebuilds that month
 *
 * Each layer re-reads the layer below, never the whole history, so a monthly
 * summary costs one month of daily summaries regardless of how much the user has
 * logged. Generation is local and runs with AI switched off; an LLM can only
 * rephrase afterwards (see `polishSummary`).
 */
export class SummaryService {
  constructor(private readonly repos: Repositories) {}

  /** Regenerate the daily, weekly and monthly summaries that contain `date`. */
  async refreshForDate(date: Date, unit: WeightUnit): Promise<TrainingSummary | null> {
    const dayKey = localDateKey(date);
    const daily = await this.refreshDaily(dayKey, unit);
    await this.refreshWeek(weekKey(date), unit);
    await this.refreshMonth(monthKey(date), unit);
    return daily;
  }

  /** Convenience for "a workout was just saved". */
  async refreshForWorkout(workout: Workout, unit: WeightUnit): Promise<TrainingSummary | null> {
    return this.refreshForDate(new Date(workout.startTime), unit);
  }

  async refreshDaily(dayKey: string, unit: WeightUnit): Promise<TrainingSummary | null> {
    const workouts = await this.repos.training.findByDate(dayKey);
    if (workouts.length === 0) {
      // Nothing logged: drop a stale summary rather than keep a wrong one.
      const existing = await this.repos.summaries.get('daily', dayKey);
      if (existing) await this.repos.summaries.remove(existing.id);
      return null;
    }

    const context = await this.contextFor('daily', dayKey, workouts, unit);
    const summary = buildDailySummary({
      kind: 'daily',
      periodKey: dayKey,
      workouts,
      context,
    });
    await this.repos.summaries.save(summary);
    return summary;
  }

  async refreshWeek(weekStartKey: string, unit: WeightUnit): Promise<TrainingSummary | null> {
    const dayKeys = weekDayKeys(weekStartKey);
    const dailySummaries = [];
    for (const dayKey of dayKeys) {
      const summary = await this.repos.summaries.get('daily', dayKey);
      if (summary) dailySummaries.push(summary);
    }

    const workouts = (await this.repos.training.completed()).filter((workout) =>
      dayKeys.includes(localDateKey(workout.startTime)),
    );

    if (workouts.length === 0) {
      const existing = await this.repos.summaries.get('weekly', weekStartKey);
      if (existing) await this.repos.summaries.remove(existing.id);
      return null;
    }

    const context = await this.contextFor('weekly', weekStartKey, workouts, unit);
    const summary = buildRollupSummary({
      kind: 'weekly',
      periodKey: weekStartKey,
      workouts,
      // Built from the day summaries when they exist; the prose degrades to the
      // "by period" section being empty, never to missing numbers.
      children: dailySummaries,
      context,
    });
    await this.repos.summaries.save(summary);
    return summary;
  }

  async refreshMonth(monthKeyValue: string, unit: WeightUnit): Promise<TrainingSummary | null> {
    const weekKeys = monthWeekKeys(monthKeyValue);
    const weeklySummaries = [];
    for (const key of weekKeys) {
      const summary = await this.repos.summaries.get('weekly', key);
      if (summary) weeklySummaries.push(summary);
    }

    const workouts = (await this.repos.training.completed()).filter(
      (workout) => monthKey(new Date(workout.startTime)) === monthKeyValue,
    );

    if (workouts.length === 0) {
      const existing = await this.repos.summaries.get('monthly', monthKeyValue);
      if (existing) await this.repos.summaries.remove(existing.id);
      return null;
    }

    const context = await this.contextFor('monthly', monthKeyValue, workouts, unit);
    const summary = buildRollupSummary({
      kind: 'monthly',
      periodKey: monthKeyValue,
      workouts,
      children: weeklySummaries,
      context,
    });
    await this.repos.summaries.save(summary);
    return summary;
  }

  /**
   * Rebuild everything from scratch, oldest first, so each layer has the layer
   * below available. Used after an import or a bulk edit.
   */
  async rebuildAll(unit: WeightUnit): Promise<{ daily: number; weekly: number; monthly: number }> {
    const workouts = await this.repos.training.completed();
    const dayKeys = [...new Set(workouts.map((workout) => localDateKey(workout.startTime)))].sort();

    let daily = 0;
    for (const dayKey of dayKeys) {
      if (await this.refreshDaily(dayKey, unit)) daily += 1;
    }

    const weekKeys = [...new Set(dayKeys.map((dayKey) => weekKey(parseDay(dayKey))))].sort();
    let weekly = 0;
    for (const key of weekKeys) {
      if (await this.refreshWeek(key, unit)) weekly += 1;
    }

    const monthKeys = [...new Set(dayKeys.map((dayKey) => monthKey(parseDay(dayKey))))].sort();
    let monthly = 0;
    for (const key of monthKeys) {
      if (await this.refreshMonth(key, unit)) monthly += 1;
    }

    return { daily, weekly, monthly };
  }

  /**
   * Fill in summaries for periods that should already have one.
   *
   * Generation normally happens when a workout is saved, so this only matters for
   * history that arrived another way — an import, a restore, or a build that
   * predates the summaries feature. It is deliberately cheap: it looks at the
   * current and previous week/month only, and does nothing when they are present.
   */
  async catchUp(unit: WeightUnit, now = new Date()): Promise<{
    daily: number;
    weekly: number;
    monthly: number;
  }> {
    const workouts = await this.repos.training.completed();
    if (workouts.length === 0) return { daily: 0, weekly: 0, monthly: 0 };

    const daysWithTraining = new Set(
      workouts.map((workout) => localDateKey(workout.startTime)),
    );

    let daily = 0;
    for (const dayKey of [...daysWithTraining].sort().slice(-CATCH_UP_DAY_LIMIT)) {
      if (await this.repos.summaries.get('daily', dayKey)) continue;
      if (await this.refreshDaily(dayKey, unit)) daily += 1;
    }

    // The current and previous week, plus the current and previous month: enough to
    // cover a gap without walking the whole history on every launch.
    const weekKeys = new Set([
      weekKey(now),
      weekKey(parseDay(previousPeriodKey('weekly', weekKey(now)))),
    ]);
    let weekly = 0;
    for (const key of weekKeys) {
      if (await this.repos.summaries.get('weekly', key)) continue;
      if (await this.refreshWeek(key, unit)) weekly += 1;
    }

    const currentMonth = monthKey(now);
    const monthKeys = new Set([currentMonth, previousPeriodKey('monthly', currentMonth)]);
    let monthly = 0;
    for (const key of monthKeys) {
      if (await this.repos.summaries.get('monthly', key)) continue;
      if (await this.refreshMonth(key, unit)) monthly += 1;
    }

    return { daily, weekly, monthly };
  }

  /**
   * Build the comparison context: the previous period's summary, plus this
   * exercise's best BEFORE the period (computed from real workouts, so a missing
   * summary can never hide a regression).
   */
  private async contextFor(
    kind: SummaryKind,
    periodKey: string,
    workouts: Workout[],
    unit: WeightUnit,
  ): Promise<SummaryContext> {
    const previous = await this.repos.summaries.get(kind, previousPeriodKey(kind, periodKey));

    const periodStartMs = Math.min(
      ...workouts.map((workout) => new Date(workout.startTime).getTime()),
    );
    const names = new Set(
      workouts.flatMap((workout) =>
        workout.exercises.map((exercise) =>
          exerciseGroupKey(exercise.normalizedName || exercise.rawName),
        ),
      ),
    );

    const previousBestByExercise = new Map<string, { weightKg: number; reps: number | null }>();
    const history = await this.repos.training.completed();
    for (const workout of history) {
      const startedMs = new Date(workout.startTime).getTime();
      if (startedMs >= periodStartMs) continue;
      for (const exercise of workout.exercises) {
        const key = exerciseGroupKey(exercise.normalizedName || exercise.rawName);
        // Only lifts that appear in this period are worth comparing.
        if (!names.has(key)) continue;
        const top = bestSet(exercise.sets);
        if (top?.weightKg == null) continue;
        const current = previousBestByExercise.get(key);
        if (!current || top.weightKg > current.weightKg) {
          previousBestByExercise.set(key, { weightKg: top.weightKg, reps: top.reps });
        }
      }
    }

    return { unit, previous, previousBestByExercise };
  }
}

function parseDay(dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}

/** Marker used by the UI to show a summary's freshness. */
export function summaryFreshness(summary: TrainingSummary): string {
  return summary.updatedAt ?? summary.generatedAt ?? nowIso();
}
