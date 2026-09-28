import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AddExerciseSheet } from '../components/AddExerciseSheet';
import { ConfirmDialog, Sheet } from '../components/Sheet';
import { RenameExerciseSheet } from '../components/RenameExerciseSheet';
import { ExerciseCard } from '../components/ExerciseCard';
import { EmptyState, PageHeader } from '../components/ui';
import { formatClock, formatDuration } from '../domain/units';
import { createWorkout } from '../domain/workout';
import type { Workout } from '../domain/types';
import { repositories } from '../repositories';
import type { ExerciseSuggestion } from '../repositories/exerciseRepository';
import { SummaryService } from '../services/summaries/summaryService';
import { useApp, useI18n } from '../state/AppContext';
import { useOutlierReview } from '../state/useOutlierReview';
import { useToast } from '../state/ToastContext';
import { WorkoutSessionProvider, useWorkoutSession } from '../state/WorkoutSessionContext';

/**
 * Route entry: resolve the workout (existing draft, finished workout, or a brand
 * new one) and hand it to the session provider.
 */
export function WorkoutPage() {
  const { workoutId } = useParams<{ workoutId: string }>();
  const navigate = useNavigate();
  const [workout, setWorkout] = useState<Workout | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const training = repositories().training;
      const existing = workoutId ? await training.get(workoutId) : await training.inProgress();
      if (cancelled) return;
      const resolved = existing ?? createWorkout();
      if (!existing) await training.put(resolved);
      if (cancelled) return;
      setWorkout(resolved);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [workoutId]);

  if (!ready || !workout) {
    return (
      <div className="splash">
        <div className="logo">🏋️</div>
        <div className="small">
          <SplashNote />
        </div>
      </div>
    );
  }

  return (
    <WorkoutSessionProvider initial={workout} key={workout.id}>
      <WorkoutEditor onLeave={() => navigate('/')} />
    </WorkoutSessionProvider>
  );
}

/** The loading line, split out so the splash can translate without a hook above it. */
function SplashNote() {
  const { t } = useI18n();
  return <>{t('workout.preparing')}</>;
}

function WorkoutEditor({ onLeave }: { onLeave: () => void }) {
  const session = useWorkoutSession();
  const { workout, elapsedSec, saving, focusSetId } = session;
  const navigate = useNavigate();
  const toast = useToast();
  const { settings } = useApp();
  const { t, intlTag } = useI18n();

  const [showAdd, setShowAdd] = useState(false);
  const [suggestions, setSuggestions] = useState<ExerciseSuggestion[]>([]);
  const [confirmDeleteExercise, setConfirmDeleteExercise] = useState<string | null>(null);
  const [renamingExerciseId, setRenamingExerciseId] = useState<string | null>(null);
  const review = useOutlierReview();
  const [showFinish, setShowFinish] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showHeartRate, setShowHeartRate] = useState(false);

  useEffect(() => {
    void repositories()
      .exercises.suggestions(60)
      .then(setSuggestions);
  }, [workout.exercises.length]);

  const loggedSetCount = useMemo(
    () =>
      workout.exercises.reduce(
        (sum, exercise) =>
          sum + exercise.sets.filter((set) => set.weight !== null || set.reps !== null).length,
        0,
      ),
    [workout.exercises],
  );

  const supersetLabels = useMemo(() => {
    const groups = new Map<number, string>();
    const letters = 'ABCDEFGH';
    for (const exercise of workout.exercises) {
      if (exercise.supersetGroup === null) continue;
      if (!groups.has(exercise.supersetGroup)) {
        groups.set(exercise.supersetGroup, `SS ${letters[groups.size] ?? groups.size + 1}`);
      }
    }
    return groups;
  }, [workout.exercises]);

  const handleAddExercise = useCallback(
    async (name: string) => {
      await session.addExercise(name);
      setShowAdd(false);
    },
    [session],
  );

  /** Regenerate the day/week/month summaries. Never blocks navigation. */
  const refreshSummaries = useCallback(
    async (workout: Workout) => {
      try {
        await new SummaryService(repositories()).refreshForWorkout(workout, settings.defaultUnit);
      } catch (error) {
        console.warn('[summary] generation failed', error);
      }
    },
    [settings.defaultUnit],
  );

  /**
   * Finish and save.
   *
   * Outliers are checked *before* saving, but they never block it: whatever the
   * user decides, the workout is stored. When there is nothing to review the save
   * happens immediately, so the common path stays one tap. The review itself is
   * shared with Quick Log (see `useOutlierReview`).
   */
  const persist = useCallback(
    async (candidate: Workout) => {
      const finished = await session.finish(candidate);
      void refreshSummaries(finished);
      toast.show(
        t('workout.savedToast', {
          duration: formatDuration(finished.durationSec, t),
          exercises: finished.exercises.length,
        }),
        'success',
      );
      navigate(`/history/${finished.id}`, { replace: true });
    },
    [session, toast, navigate, refreshSummaries, t],
  );

  const handleFinish = useCallback(async () => {
    const current = session.workout;
    const clearToSave = await review.guard(current, persist);
    if (clearToSave) await persist(current);
  }, [persist, review, session.workout]);

  /**
   * Cancel the session and delete the draft.
   *
   * Distinct from the header's "Home" button, which parks the workout so it can be
   * resumed later. This is the only way to get rid of one.
   */
  const handleDiscard = useCallback(async () => {
    setShowDiscard(false);
    await session.discard();
    toast.show(t('workout.discardedToast'));
    navigate('/', { replace: true });
  }, [navigate, session, toast, t]);

  return (
    <>
      <PageHeader
        title={t('workout.title')}
        subtitle={`${t('workout.subtitle', {
          exercises: workout.exercises.length,
          sets: loggedSetCount,
        })}${saving ? ` · ${t('workout.saving')}` : ''}`}
        action={
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onLeave}>
              {t('nav.home')}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setShowFinish(true)}
            >
              {t('workout.finish')}
            </button>
          </>
        }
      />

      <main className="app-main">
        <div className="page">
          <div className="card">
            <div className="workout-head">
              <div>
                <div className="timer">{formatClock(elapsedSec)}</div>
                <div className="small faint">
                  {t('workout.started', {
                    time: new Date(workout.startTime).toLocaleTimeString(intlTag, {
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  })}
                </div>
              </div>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setShowNotes((value) => !value)}
                >
                  {t('workout.workoutNotes')}
                  {workout.notes ? ' •' : ''}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setShowHeartRate((value) => !value)}
                >
                  {workout.heartRate ? `♥ ${workout.heartRate}` : `♥ ${t('workout.heartRate')}`}
                </button>
              </div>
            </div>

            {showNotes ? (
              <textarea
                className="textarea"
                style={{ marginTop: 'var(--space-3)' }}
                placeholder={t('workout.notesPlaceholder')}
                aria-label={t('workout.workoutNotes')}
                value={workout.notes}
                onChange={(event) => session.setWorkoutNotes(event.target.value)}
              />
            ) : null}

            {showHeartRate ? (
              <div className="field" style={{ marginTop: 'var(--space-3)' }}>
                <label htmlFor="hr">{t('workout.heartRateLabel')}</label>
                <input
                  id="hr"
                  className="input"
                  type="text"
                  inputMode="numeric"
                  value={workout.heartRate ?? ''}
                  placeholder={t('workout.heartRatePlaceholder')}
                  onChange={(event) => {
                    const value = event.target.value.trim();
                    session.setHeartRate(value === '' ? null : Number(value) || null);
                  }}
                />
              </div>
            ) : null}
          </div>

          <div className="section-title">
            <span>{t('workout.exercises')}</span>
            <button type="button" className="btn btn-sm" onClick={() => setShowAdd(true)}>
              + {t('common.add')}
            </button>
          </div>

          {workout.exercises.length === 0 ? (
            // No scenery here: the recorder is a work surface, and decoration next to
            // the controls you are aiming at is in the way.
            <EmptyState
              title={t('workout.noExercisesTitle')}
              hint={t('workout.noExercisesHint')}
              scenery={false}
            />
          ) : (
            workout.exercises.map((exercise, index) => (
              <ExerciseCard
                key={exercise.id}
                exercise={exercise}
                index={index}
                supersetLabel={
                  exercise.supersetGroup === null
                    ? null
                    : (supersetLabels.get(exercise.supersetGroup) ?? null)
                }
                focusSetId={focusSetId}
                onRename={(name) => session.renameExercise(exercise.id, name)}
                onRenameWithRule={() => setRenamingExerciseId(exercise.id)}
                onRemove={() => setConfirmDeleteExercise(exercise.id)}
                onMove={(direction) => session.moveExercise(exercise.id, direction)}
                onToggleSuperset={() => session.toggleSuperset(exercise.id)}
                onAddSet={() => {
                  session.addSet(exercise.id, { focus: true });
                }}
                onCopyLastSet={() => {
                  session.addSet(exercise.id, { copyPrevious: true });
                }}
                onDuplicateSet={(setId) => {
                  session.addSet(exercise.id, { fromSetId: setId, focus: true });
                }}
                onUpdateSet={(setId, patch) => session.updateSet(exercise.id, setId, patch)}
                onRemoveSet={(setId) => session.removeSet(exercise.id, setId)}
              />
            ))
          )}

          <div className="page-actions">
            <button
              type="button"
              className="btn btn-primary btn-block btn-hero"
              onClick={() => setShowAdd(true)}
            >
              {t('workout.addExercise')}
            </button>
          </div>
        </div>
      </main>

      {showAdd ? (
        <AddExerciseSheet
          suggestions={suggestions}
          alreadyAdded={workout.exercises.map((exercise) => exercise.rawName)}
          onAdd={(name) => void handleAddExercise(name)}
          onClose={() => setShowAdd(false)}
        />
      ) : null}

      {confirmDeleteExercise ? (
        <ConfirmDialog
          title={t('workout.deleteExerciseTitle')}
          message={t('workout.deleteExerciseBody')}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          onCancel={() => setConfirmDeleteExercise(null)}
          onConfirm={() => {
            session.removeExercise(confirmDeleteExercise);
            setConfirmDeleteExercise(null);
          }}
        />
      ) : null}

      {renamingExerciseId ? (
        <RenameExerciseSheet
          currentName={
            workout.exercises.find((exercise) => exercise.id === renamingExerciseId)?.rawName ?? ''
          }
          onRename={(name) => session.renameExercise(renamingExerciseId, name)}
          onClose={() => setRenamingExerciseId(null)}
        />
      ) : null}

      {review.element}

      {/*
        The finish sheet carries both exits: "keep training" returns to the
        recorder, and "discard" deletes the draft. Putting discard here means the
        user who decides against the session is one tap from getting rid of it.
      */}
      {showFinish ? (
        <Sheet
          title={t('workout.finishTitle')}
          onClose={() => setShowFinish(false)}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setShowFinish(false)}
              >
                {t('workout.keepTraining')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowFinish(false);
                  void handleFinish();
                }}
              >
                {t('workout.finishConfirm')}
              </button>
            </>
          }
        >
          <p className="confirm-text muted">
            {t('workout.finishBody', {
              exercises: workout.exercises.length,
              sets: workout.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0),
            })}
          </p>
          <div className="page-actions">
            <button
              type="button"
              className="btn btn-danger btn-block"
              onClick={() => {
                setShowFinish(false);
                setShowDiscard(true);
              }}
            >
              {t('workout.discard')}
            </button>
          </div>
        </Sheet>
      ) : null}

      {showDiscard ? (
        <ConfirmDialog
          title={t('workout.discardTitle')}
          message={t('workout.discardBody')}
          confirmLabel={t('workout.discardConfirm')}
          cancelLabel={t('common.cancel')}
          danger
          onCancel={() => setShowDiscard(false)}
          onConfirm={() => void handleDiscard()}
        />
      ) : null}
    </>
  );
}
