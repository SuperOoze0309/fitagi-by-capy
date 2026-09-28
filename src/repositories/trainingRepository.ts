import type { Collection } from '../storage/adapter';
import type { ExerciseEntry, Workout } from '../domain/types';
import { localDateKey, nowIso } from '../domain/datetime';
import { secondsBetween } from '../domain/metrics';
import { resequenceExercises } from '../domain/workout';

/**
 * Reads and writes workout aggregates.
 *
 * Every mutation keeps the workout's `updatedAt` fresh, and completion stamps
 * `endTime` + `durationSec` so History can render without recomputing anything.
 */
export class TrainingRepository {
  constructor(private readonly collection: Collection<Workout>) {}

  async all(): Promise<Workout[]> {
    const rows = await this.collection.all();
    return rows.sort(byStartTimeDesc);
  }

  async completed(): Promise<Workout[]> {
    return (await this.all()).filter((workout) => workout.completed);
  }

  async get(id: string): Promise<Workout | null> {
    return this.collection.get(id);
  }

  /** The in-progress workout, if the user left one open. */
  async inProgress(): Promise<Workout | null> {
    const rows = await this.collection.all();
    return rows.find((workout) => !workout.completed) ?? null;
  }

  async latestCompleted(): Promise<Workout | null> {
    return (await this.completed())[0] ?? null;
  }

  async findByDate(dateKey: string): Promise<Workout[]> {
    return (await this.completed()).filter((workout) => localDateKey(workout.startTime) === dateKey);
  }

  async count(): Promise<number> {
    return this.collection.count();
  }

  async put(workout: Workout): Promise<Workout> {
    const next: Workout = { ...workout, updatedAt: nowIso() };
    await this.collection.put(next);
    return next;
  }

  async putMany(workouts: Workout[]): Promise<void> {
    await this.collection.putMany(workouts);
  }

  async remove(id: string): Promise<void> {
    await this.collection.remove(id);
  }

  async clear(): Promise<void> {
    await this.collection.clear();
  }

  // ---------------------------------------------------------------------------
  // Aggregate helpers — small, explicit mutations instead of a generic patch API.
  // ---------------------------------------------------------------------------

  async upsertExercise(workoutId: string, exercise: ExerciseEntry): Promise<Workout> {
    return this.mutate(workoutId, (workout) => {
      const index = workout.exercises.findIndex((entry) => entry.id === exercise.id);
      const exercises =
        index === -1
          ? [...workout.exercises, exercise]
          : workout.exercises.map((entry) => (entry.id === exercise.id ? exercise : entry));
      return { ...workout, exercises: resequenceExercises(exercises) };
    });
  }

  async removeExercise(workoutId: string, exerciseId: string): Promise<Workout> {
    return this.mutate(workoutId, (workout) => ({
      ...workout,
      exercises: resequenceExercises(workout.exercises.filter((entry) => entry.id !== exerciseId)),
    }));
  }

  async moveExercise(workoutId: string, exerciseId: string, direction: -1 | 1): Promise<Workout> {
    return this.mutate(workoutId, (workout) => {
      const index = workout.exercises.findIndex((entry) => entry.id === exerciseId);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= workout.exercises.length) return workout;
      const exercises = [...workout.exercises];
      [exercises[index], exercises[target]] = [exercises[target], exercises[index]];
      return { ...workout, exercises: resequenceExercises(exercises) };
    });
  }

  /**
   * Finish the session: stamp the end time and freeze the duration.
   *
   * The end time never precedes the start time. That matters for backdated entries
   * (a workout you log the next morning) and for imported data, where stamping the
   * wall clock would otherwise produce a negative or absurd duration.
   */
  /**
   * Finish the session: stamp the end time and freeze the duration.
   *
   * The end time is the wall clock — that is what "finish" means — and the duration
   * is always non-negative. For a backdated entry (a session you log the next
   * morning) the recorded duration therefore covers the gap until you logged it; set
   * `endTime` explicitly beforehand when the real window is known, as the workout
   * detail editor does.
   */
  async complete(workoutId: string): Promise<Workout> {
    return this.mutate(workoutId, (workout) => {
      const endTime = workout.endTime ?? nowIso();
      return {
        ...workout,
        endTime,
        durationSec: secondsBetween(workout.startTime, endTime),
        completed: true,
      };
    });
  }

  /** Reopen a finished workout so it can be edited as an active session again. */
  async reopen(workoutId: string): Promise<Workout> {
    return this.mutate(workoutId, (workout) => ({
      ...workout,
      endTime: null,
      completed: false,
    }));
  }

  private async mutate(
    workoutId: string,
    updater: (workout: Workout) => Workout,
  ): Promise<Workout> {
    const current = await this.collection.get(workoutId);
    if (!current) throw new Error(`Workout ${workoutId} not found`);
    const next = { ...updater(current), updatedAt: nowIso() };
    await this.collection.put(next);
    return next;
  }
}

export function byStartTimeDesc(a: Workout, b: Workout): number {
  return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
}
