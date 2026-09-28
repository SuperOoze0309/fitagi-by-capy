import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ExerciseEntry, SetEntry, WeightUnit, Workout } from '../domain/types';
import { nowIso } from '../domain/datetime';
import { secondsBetween } from '../domain/metrics';
import {
  createExerciseEntry,
  createSetFromPrevious,
  normalizeExerciseName,
  resequenceExercises,
  withSetWeight,
} from '../domain/workout';
import { repositories } from '../repositories';
import { applyWeightCorrections } from '../services/validation';
import { useApp } from './AppContext';

/**
 * Holds the workout currently being recorded.
 *
 * Behaviour that matters for the product:
 *  - Every edit is written to local storage (debounced 300 ms), so closing the
 *    app or refreshing the page never loses a set.
 *  - The elapsed timer is display-only state; it is recomputed from
 *    `startTime` and never persisted on every tick.
 */
interface WorkoutSessionValue {
  workout: Workout;
  elapsedSec: number;
  saving: boolean;
  /** Set id that should receive focus after a "+ Set" tap. */
  focusSetId: string | null;
  addExercise: (rawName: string) => Promise<void>;
  renameExercise: (exerciseId: string, rawName: string) => void;
  removeExercise: (exerciseId: string) => void;
  moveExercise: (exerciseId: string, direction: -1 | 1) => void;
  setExerciseNotes: (exerciseId: string, notes: string) => void;
  toggleSuperset: (exerciseId: string) => void;
  addSet: (
    exerciseId: string,
    options?: { copyPrevious?: boolean; fromSetId?: string; focus?: boolean },
  ) => void;
  updateSet: (exerciseId: string, setId: string, patch: Partial<SetEntry>) => void;
  removeSet: (exerciseId: string, setId: string) => void;
  setWorkoutNotes: (notes: string) => void;
  setHeartRate: (value: number | null) => void;
  /**
   * Finish the session. Pass `override` to save a reviewed copy instead of the live
   * session — that is how an accepted outlier correction reaches storage.
   */
  finish: (override?: Workout) => Promise<Workout>;
  /** Overwrite specific set weights, used after the user fixes an outlier. */
  applyWeightCorrections: (corrections: { setId: string; weight: number }[]) => Promise<Workout>;
  /**
   * Abandon the session and delete it.
   *
   * A draft is written to storage the moment a workout starts, so "cancel" has to
   * remove that record — otherwise walking away would leave an unfinished workout
   * on Home forever with no way to get rid of it.
   */
  discard: () => Promise<void>;
  flush: () => Promise<void>;
}

const WorkoutSessionContext = createContext<WorkoutSessionValue | null>(null);

export function WorkoutSessionProvider({
  initial,
  children,
}: {
  initial: Workout;
  children: ReactNode;
}) {
  const { settings } = useApp();
  const [workout, setWorkout] = useState<Workout>(initial);
  const [saving, setSaving] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [focusSetId, setFocusSetId] = useState<string | null>(null);

  const pendingRef = useRef<Workout | null>(null);
  const timerRef = useRef<number | null>(null);
  const latestRef = useRef<Workout>(initial);

  latestRef.current = workout;

  // Live elapsed clock.
  useEffect(() => {
    const tick = () => setElapsedSec(secondsBetween(workout.startTime, nowIso()));
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [workout.startTime]);

  const flush = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setSaving(true);
    try {
      await repositories().training.put(pending);
    } finally {
      setSaving(false);
    }
  }, []);

  /** Apply a local edit and schedule a debounced write. */
  const commit = useCallback(
    (updater: (current: Workout) => Workout) => {
      setWorkout((current) => {
        const next = { ...updater(current), updatedAt: nowIso() };
        pendingRef.current = next;
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          void flush();
        }, 300);
        return next;
      });
    },
    [flush],
  );

  // Never lose the last edit: write on unmount and when the app is backgrounded.
  useEffect(() => {
    const onHide = () => {
      if (pendingRef.current) void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (pendingRef.current) void flush();
    };
  }, [flush]);

  const updateExercise = useCallback(
    (exerciseId: string, updater: (exercise: ExerciseEntry) => ExerciseEntry) => {
      commit((current) => ({
        ...current,
        exercises: current.exercises.map((exercise) =>
          exercise.id === exerciseId ? updater(exercise) : exercise,
        ),
      }));
    },
    [commit],
  );

  const addExercise = useCallback(
    async (rawName: string) => {
      const name = normalizeExerciseName(rawName);
      if (name === '') return;
      // Alias rules are user-owned; apply them before the name ever hits storage.
      const rule = await repositories().rules.resolve(name);
      commit((current) => {
        const entry = createExerciseEntry(current.id, name, current.exercises.length);
        const normalized = rule ?? name;
        return {
          ...current,
          exercises: [
            ...current.exercises,
            {
              ...entry,
              normalizedName: normalized,
              sets: [createSetFromPrevious(undefined, settings.defaultUnit)],
            },
          ],
        };
      });
    },
    [commit, settings.defaultUnit],
  );

  const value = useMemo<WorkoutSessionValue>(
    () => ({
      workout,
      elapsedSec,
      saving,
      focusSetId,

      addExercise,

      renameExercise: (exerciseId, rawName) => {
        const name = normalizeExerciseName(rawName);
        if (name === '') return;
        updateExercise(exerciseId, (exercise) => ({
          ...exercise,
          rawName: name,
          // Keep rawName/normalizedName in sync while editing manually: the user
          // is the authority, and Phase 2 alias rules can re-suggest later.
          normalizedName: name,
        }));
      },

      removeExercise: (exerciseId) => {
        commit((current) => ({
          ...current,
          exercises: resequenceExercises(
            current.exercises.filter((exercise) => exercise.id !== exerciseId),
          ),
        }));
      },

      moveExercise: (exerciseId, direction) => {
        commit((current) => {
          const index = current.exercises.findIndex((exercise) => exercise.id === exerciseId);
          const target = index + direction;
          if (index === -1 || target < 0 || target >= current.exercises.length) return current;
          const exercises = [...current.exercises];
          [exercises[index], exercises[target]] = [exercises[target], exercises[index]];
          return { ...current, exercises: resequenceExercises(exercises) };
        });
      },

      setExerciseNotes: (exerciseId, notes) => {
        updateExercise(exerciseId, (exercise) => ({ ...exercise, notes }));
      },

      toggleSuperset: (exerciseId) => {
        commit((current) => {
          const index = current.exercises.findIndex((exercise) => exercise.id === exerciseId);
          if (index === -1) return current;
          const exercises = current.exercises.map((exercise) => ({ ...exercise }));
          const self = exercises[index];
          if (self.supersetGroup !== null) {
            const group = self.supersetGroup;
            for (const exercise of exercises) {
              if (exercise.supersetGroup === group) exercise.supersetGroup = null;
            }
            return { ...current, exercises };
          }
          const previous = exercises[index - 1];
          if (!previous) {
            // Nothing above to pair with: start a fresh superset group.
            const maxGroup = exercises.reduce(
              (max, exercise) => Math.max(max, exercise.supersetGroup ?? 0),
              0,
            );
            self.supersetGroup = maxGroup + 1;
            return { ...current, exercises };
          }
          const group =
            previous.supersetGroup ??
            exercises.reduce((max, exercise) => Math.max(max, exercise.supersetGroup ?? 0), 0) + 1;
          previous.supersetGroup = group;
          self.supersetGroup = group;
          return { ...current, exercises };
        });
      },

      addSet: (exerciseId, options) => {
        // Compose the new set outside the state updater: React may invoke an
        // updater twice (StrictMode), and id generation must happen exactly once.
        const exercise = latestRef.current.exercises.find((entry) => entry.id === exerciseId);
        if (!exercise) return;
        const source =
          options?.fromSetId !== undefined
            ? exercise.sets.find((set) => set.id === options.fromSetId)
            : exercise.sets[exercise.sets.length - 1];
        const nextSet =
          options?.copyPrevious === false
            ? createSetFromPrevious(undefined, settings.defaultUnit)
            : createSetFromPrevious(source, settings.defaultUnit);
        if (options?.focus) setFocusSetId(nextSet.id);
        updateExercise(exerciseId, (current) => ({
          ...current,
          sets: [...current.sets, nextSet],
        }));
      },

      updateSet: (exerciseId, setId, patch) => {
        updateExercise(exerciseId, (exercise) => ({
          ...exercise,
          sets: exercise.sets.map((set) => {
            if (set.id !== setId) return set;
            const merged = { ...set, ...patch };
            // `weight` and `unit` must always be written together so weightKg
            // can never drift from what the user sees.
            if ('weight' in patch || 'unit' in patch) {
              const unit: WeightUnit = patch.unit ?? set.unit;
              return withSetWeight(merged, patch.weight !== undefined ? patch.weight : set.weight, unit);
            }
            return merged;
          }),
        }));
      },

      removeSet: (exerciseId, setId) => {
        updateExercise(exerciseId, (exercise) => ({
          ...exercise,
          sets: exercise.sets.filter((set) => set.id !== setId),
        }));
      },

      setWorkoutNotes: (notes) => commit((current) => ({ ...current, notes })),
      setHeartRate: (heartRate) => commit((current) => ({ ...current, heartRate })),

      finish: async (override) => {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const current = override ?? latestRef.current;
        const endTime = nowIso();
        const finished: Workout = {
          ...current,
          endTime,
          durationSec: secondsBetween(current.startTime, endTime),
          completed: true,
          updatedAt: endTime,
        };
        pendingRef.current = null;
        const saved = await repositories().training.put(finished);
        setWorkout(saved);
        return saved;
      },

      applyWeightCorrections: async (corrections) => {
        const current = latestRef.current;
        const { workout: corrected } = applyWeightCorrections(current, corrections);
        setWorkout(corrected);
        return corrected;
      },

      discard: async () => {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        // Drop the pending debounced write first, so it cannot re-create the row
        // after the delete.
        pendingRef.current = null;
        await repositories().training.remove(latestRef.current.id);
      },

      flush,
    }),
    [workout, elapsedSec, saving, focusSetId, addExercise, commit, updateExercise, settings.defaultUnit, flush],
  );

  return (
    <WorkoutSessionContext.Provider value={value}>{children}</WorkoutSessionContext.Provider>
  );
}

export function useWorkoutSession(): WorkoutSessionValue {
  const context = useContext(WorkoutSessionContext);
  if (!context) {
    throw new Error('useWorkoutSession must be used inside WorkoutSessionProvider');
  }
  return context;
}
