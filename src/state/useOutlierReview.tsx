import { useCallback, useState } from 'react';
import { AnomalyReviewSheet } from '../components/AnomalyReviewSheet';
import { applyWeightCorrections, findAnomalies, type AnomalyCheck } from '../services/validation';
import { repositories } from '../repositories';
import type { Workout } from '../domain/types';

/**
 * Outlier review, shared by every path that stores a workout.
 *
 * Both the structured recorder and the natural-language Quick Log can produce a
 * typo like "600kg", so both go through this hook. The contract is the one from the
 * product spec:
 *
 *  - the check never blocks saving — the caller's save runs either way;
 *  - a value is never rewritten unless the user types a replacement;
 *  - if the check itself fails, the workout still saves.
 */
export interface OutlierReview {
  /** The sheet, or null when there is nothing to review. */
  element: React.ReactNode;
  /**
   * Run the check before saving. Resolves `true` when the caller should save now,
   * or `false` when the user is being asked about outliers first (the hook will
   * invoke `save` itself once they answer).
   */
  guard: (workout: Workout, save: (workout: Workout) => void | Promise<void>) => Promise<boolean>;
}

export function useOutlierReview(): OutlierReview {
  const [pending, setPending] = useState<{
    findings: AnomalyCheck[];
    workout: Workout;
    save: (workout: Workout) => void | Promise<void>;
  } | null>(null);

  const guard = useCallback(
    async (workout: Workout, save: (workout: Workout) => void | Promise<void>) => {
      try {
        const findings = await findAnomalies(workout, repositories().exercises);
        if (findings.length > 0) {
          setPending({ findings, workout, save });
          return false;
        }
      } catch (error) {
        // A failed check must never stop the user from saving.
        console.warn('[workout] outlier check failed', error);
      }
      return true;
    },
    [],
  );

  const element = pending ? (
    <AnomalyReviewSheet
      findings={pending.findings}
      onResolve={(result) => {
        const { workout, save } = pending;
        setPending(null);
        void (async () => {
          // Corrections are applied through the shared helper, so `weightKg` is
          // always re-derived from the value the user actually accepted.
          const next =
            result.corrected.length > 0
              ? applyWeightCorrections(workout, result.corrected).workout
              : workout;
          await save(next);
        })();
      }}
      onDismiss={() => {
        const { workout, save } = pending;
        setPending(null);
        void save(workout);
      }}
    />
  ) : null;

  return { element, guard };
}
