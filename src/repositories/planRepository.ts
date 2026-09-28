import type { Collection } from '../storage/adapter';
import type { PlanDay, PlanExercise, Reminder, ReminderKind, TrainingPlan } from '../domain/types';
import { nowIso } from '../domain/datetime';
import { newId } from '../domain/ids';

/**
 * Reminders and training plans.
 *
 * Both are small, user-owned documents with the same shape of lifecycle as
 * everything else in the app: one JSON document per record, stored on the device,
 * never on a server.
 */

const REMINDER_KINDS: ReminderKind[] = ['workout', 'meal', 'water', 'weighIn', 'rest', 'custom'];

/** `HH:MM`, 24-hour. Anything else is rejected rather than stored. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

/** Minutes since midnight, for sorting and for "next reminder" arithmetic. */
export function minutesOfDay(time: string): number {
  const match = TIME_PATTERN.exec(time);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function createEmptyReminder(patch: Partial<Reminder> = {}): Reminder {
  const timestamp = nowIso();
  return {
    id: newId('rem'),
    title: '',
    body: '',
    kind: 'workout',
    weekdays: [],
    time: '19:00',
    enabled: true,
    source: 'manual',
    notificationId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...patch,
  };
}

export class ReminderRepository {
  constructor(private readonly collection: Collection<Reminder>) {}

  /** Enabled first, then by time of day, so the list reads like a day. */
  async all(): Promise<Reminder[]> {
    const rows = await this.collection.all();
    return rows.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return minutesOfDay(a.time) - minutesOfDay(b.time);
    });
  }

  async get(id: string): Promise<Reminder | null> {
    return this.collection.get(id);
  }

  async count(): Promise<number> {
    return this.collection.count();
  }

  /**
   * Save a reminder, normalised.
   *
   * Normalising here rather than at every call site means a reminder that came from
   * an AI proposal, a backup file or the editor all end up valid: an unknown kind
   * falls back, a malformed time is replaced, and weekday numbers are deduplicated
   * and sorted so "Mon, Wed" and "Wed, Mon" are the same record.
   */
  async save(reminder: Reminder): Promise<Reminder> {
    const next: Reminder = {
      ...reminder,
      kind: REMINDER_KINDS.includes(reminder.kind) ? reminder.kind : 'custom',
      time: isValidTime(reminder.time) ? reminder.time : '19:00',
      weekdays: [...new Set(reminder.weekdays.filter((day) => day >= 0 && day <= 6))].sort(),
      updatedAt: nowIso(),
    };
    await this.collection.put(next);
    return next;
  }

  async putMany(reminders: Reminder[]): Promise<void> {
    // The same normalisation as `save`, so a restored backup cannot introduce a
    // reminder the OS scheduler would reject.
    const normalised = reminders.map((reminder) => ({
      ...reminder,
      kind: REMINDER_KINDS.includes(reminder.kind) ? reminder.kind : 'custom',
      time: isValidTime(reminder.time) ? reminder.time : '19:00',
      weekdays: [...new Set((reminder.weekdays ?? []).filter((day) => day >= 0 && day <= 6))].sort(),
    }));
    await this.collection.putMany(normalised as Reminder[]);
  }

  async remove(id: string): Promise<void> {
    await this.collection.remove(id);
  }

  async clear(): Promise<void> {
    await this.collection.clear();
  }
}

// ------------------------------------------------------------------- plans

export function createEmptyPlanExercise(name = ''): PlanExercise {
  return { id: newId('pe'), name, sets: 3, reps: '8-10', targetWeightKg: null, notes: '' };
}

export function createEmptyPlanDay(weekday: number, patch: Partial<PlanDay> = {}): PlanDay {
  return {
    id: newId('pd'),
    weekday,
    title: '',
    rest: false,
    exercises: [],
    ...patch,
  };
}

/** A plan with all seven days present, so the editor is a week rather than a list. */
export function createEmptyPlan(): TrainingPlan {
  const timestamp = nowIso();
  return {
    id: newId('plan'),
    name: '',
    goal: null,
    days: Array.from({ length: 7 }, (_, weekday) => createEmptyPlanDay(weekday)),
    active: false,
    source: 'manual',
    notes: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Total prescribed sets across a week — the one number that makes plans comparable. */
export function planWeeklySets(plan: TrainingPlan): number {
  return plan.days.reduce(
    (total, day) => total + day.exercises.reduce((sum, exercise) => sum + exercise.sets, 0),
    0,
  );
}

export function planTrainingDays(plan: TrainingPlan): number {
  return plan.days.filter((day) => !day.rest && day.exercises.length > 0).length;
}

export class PlanRepository {
  constructor(private readonly collection: Collection<TrainingPlan>) {}

  async all(): Promise<TrainingPlan[]> {
    const rows = await this.collection.all();
    // Active plan first, then newest.
    return rows.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  async get(id: string): Promise<TrainingPlan | null> {
    return this.collection.get(id);
  }

  async active(): Promise<TrainingPlan | null> {
    return (await this.all()).find((plan) => plan.active) ?? null;
  }

  /** The active plan's entry for a weekday, if that day is not a rest day. */
  async forWeekday(weekday: number): Promise<PlanDay | null> {
    const plan = await this.active();
    if (!plan) return null;
    const day = plan.days.find((entry) => entry.weekday === weekday);
    if (!day || day.rest || day.exercises.length === 0) return null;
    return day;
  }

  async count(): Promise<number> {
    return this.collection.count();
  }

  /**
   * Save a plan.
   *
   * Exactly one plan is active: activating one deactivates the rest, here rather
   * than in the page, because "which plan am I on" has to have a single answer for
   * the Home card and the workout prefill to agree.
   */
  async save(plan: TrainingPlan): Promise<TrainingPlan> {
    const next: TrainingPlan = { ...plan, updatedAt: nowIso() };
    if (next.active) {
      for (const other of await this.collection.all()) {
        if (other.id !== next.id && other.active) {
          await this.collection.put({ ...other, active: false, updatedAt: nowIso() });
        }
      }
    }
    await this.collection.put(next);
    return next;
  }

  async putMany(plans: TrainingPlan[]): Promise<void> {
    await this.collection.putMany(plans);
  }

  async remove(id: string): Promise<void> {
    await this.collection.remove(id);
  }

  async clear(): Promise<void> {
    await this.collection.clear();
  }
}
