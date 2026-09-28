import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ConfirmDialog } from '../components/Sheet';
import { Field, PageHeader } from '../components/ui';
import { formatDuration, formatNumber, fromKg } from '../domain/units';
import {
  formatDate,
  formatTime,
  toDateTimeLocalValue,
  fromDateTimeLocalValue,
  localDateKey,
} from '../domain/datetime';
import { countWorkingSets, estimateOneRepMaxKg, workingSets, workoutVolumeKg } from '../domain/metrics';
import type { ExerciseEntry, SetEntry, TrainingSummary, Workout } from '../domain/types';
import { repositories } from '../repositories';
import { useApp, useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';
import type { Translator } from '../i18n';

/** Read-only view of a finished workout, with explicit edit, reopen and delete actions. */
export function WorkoutDetailPage() {
  const { workoutId = '' } = useParams<{ workoutId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { t, tPlural, intlTag } = useI18n();
  const { settings } = useApp();

  const [workout, setWorkout] = useState<Workout | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Workout | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const found = await repositories().training.get(workoutId);
      setWorkout(found);
      setDraft(found);
    } catch (error) {
      // See ExercisePage: a failed read must end the splash, not extend it forever.
      console.warn('[workout] could not load', error);
      setWorkout(null);
    } finally {
      setLoading(false);
    }
  }, [workoutId]);

  useEffect(() => {
    void load();
  }, [load]);

  const volume = useMemo(
    () => (workout ? fromKg(workoutVolumeKg(workout), settings.defaultUnit) : 0),
    [workout, settings.defaultUnit],
  );

  if (loading) {
    return (
      <div className="splash">
        <div className="small">{t('history.loadingWorkout')}</div>
      </div>
    );
  }

  if (!workout) {
    return (
      <>
        <PageHeader title={t('history.detailTitle')} />
        <main className="app-main">
          <div className="page">
            <div className="empty">
              <strong>{t('history.notFound')}</strong>
              <span className="small">{t('history.notFoundHint')}</span>
            </div>
            <div className="page-actions">
              <button
                type="button"
                className="btn btn-block"
                onClick={() => navigate('/history')}
              >
                {t('history.backToHistory')}
              </button>
            </div>
          </div>
        </main>
      </>
    );
  }

  const save = async () => {
    if (!draft) return;
    const start = new Date(draft.startTime);
    const end = draft.endTime ? new Date(draft.endTime) : null;
    const durationSec =
      end && end.getTime() > start.getTime()
        ? Math.round((end.getTime() - start.getTime()) / 1000)
        : draft.durationSec;
    const next: Workout = { ...draft, durationSec };
    const saved = await repositories().training.put(next);
    setWorkout(saved);
    setDraft(saved);
    setEditing(false);
    toast.show(t('history.updated'), 'success');
  };

  const deleteWorkout = () => {
    setConfirmDelete(false);
    void (async () => {
      await repositories().training.remove(workout.id);
      toast.show(t('history.deleted'));
      navigate('/history', { replace: true });
    })();
  };

  return (
    <>
      <PageHeader
        title={formatDate(workout.startTime, intlTag)}
        subtitle={`${formatTime(workout.startTime, intlTag)}${
          workout.endTime ? ` – ${formatTime(workout.endTime, intlTag)}` : ''
        } · ${formatDuration(workout.durationSec, t)}`}
        action={
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>
              {t('common.back')}
            </button>
            {editing ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()}>
                {t('common.save')}
              </button>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                {t('common.edit')}
              </button>
            )}
          </>
        }
      />

      <main className="app-main">
        <div className="page">
          <div className="card">
            <div className="row row-wrap small faint">
              <span>{t('history.workoutCount', { count: workout.exercises.length })}</span>
              <span>
                {tPlural('history.workingSets', 'history.oneWorkingSet', countWorkingSets(workout))}
              </span>
              <span>
                {t('history.volumeSummary', {
                  value: formatNumber(volume, 0),
                  unit: settings.defaultUnit,
                })}
              </span>
              {workout.heartRate ? <span>♥ {workout.heartRate} bpm</span> : null}
            </div>

            {editing ? (
              <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
                <Field label={t('history.startLabel')} htmlFor="start-time">
                  <input
                    id="start-time"
                    className="input"
                    type="datetime-local"
                    value={toDateTimeLocalValue(draft?.startTime ?? workout.startTime)}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, startTime: fromDateTimeLocalValue(event.target.value) }
                          : current,
                      )
                    }
                  />
                </Field>
                <Field label={t('history.endLabel')} htmlFor="end-time">
                  <input
                    id="end-time"
                    className="input"
                    type="datetime-local"
                    value={toDateTimeLocalValue(
                      draft?.endTime ?? workout.endTime ?? workout.startTime,
                    )}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, endTime: fromDateTimeLocalValue(event.target.value) }
                          : current,
                      )
                    }
                  />
                </Field>
                <Field label={t('common.notes')} htmlFor="workout-notes">
                  <textarea
                    id="workout-notes"
                    className="textarea"
                    value={draft?.notes ?? ''}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, notes: event.target.value } : current,
                      )
                    }
                  />
                </Field>
              </div>
            ) : workout.notes ? (
              <p style={{ margin: 'var(--space-3) 0 0' }}>{workout.notes}</p>
            ) : null}
          </div>

          <div className="section-title">
            <span>{t('workout.exercises')}</span>
          </div>

          {workout.exercises.map((exercise) => (
            <ExerciseBlock key={exercise.id} exercise={exercise} t={t} />
          ))}

          {workout.exercises.length === 0 ? (
            <div className="empty">
              <strong>{t('history.noExercisesTitle')}</strong>
              <span className="small">{t('history.noExercisesHint')}</span>
            </div>
          ) : null}

          <DaySummaryCard workout={workout} />

          <div className="page-actions">
            <button
              type="button"
              className="btn btn-block"
              onClick={() => navigate(`/workout/${workout.id}`)}
            >
              {t('history.continueRecording')}
            </button>
          </div>

          {/*
            "Finished" is a state, not a lock. Reopening clears the end time so the
            workout shows up as in-progress again and the recorder resumes its timer.
          */}
          <div className="page-actions">
            <button
              type="button"
              className="btn btn-block"
              onClick={() =>
                void (async () => {
                  await repositories().training.reopen(workout.id);
                  toast.show(t('history.reopened'));
                  navigate(`/workout/${workout.id}`);
                })()
              }
            >
              {t('history.reopen')}
            </button>
          </div>

          <div className="page-actions">
            <button
              type="button"
              className="btn btn-danger btn-block"
              onClick={() => setConfirmDelete(true)}
            >
              {t('history.deleteWorkout')}
            </button>
          </div>

          <p className="small faint" style={{ marginTop: 'var(--space-4)' }}>
            {t('history.privacyNote', { unit: settings.defaultUnit })}
          </p>
        </div>
      </main>

      {confirmDelete ? (
        <ConfirmDialog
          title={t('history.deleteTitle')}
          message={t('history.deleteBody')}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={deleteWorkout}
        />
      ) : null}
    </>
  );
}

/**
 * The day's summary, shown on the workout that contributed to it.
 *
 * It is derived data, so it is rendered read-only and its absence is not an error:
 * a workout saved before summaries existed simply shows nothing here.
 */
function DaySummaryCard({ workout }: { workout: Workout }) {
  const { t } = useI18n();
  const [summary, setSummary] = useState<TrainingSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const dayKey = localDateKey(workout.startTime);
      const found = await repositories().summaries.get('daily', dayKey);
      if (!cancelled) setSummary(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [workout.startTime, workout.updatedAt]);

  if (!summary) return null;

  return (
    <>
      <div className="section-title">
        <span>{t('history.daySummary')}</span>
        <Link className="small" to="/summaries">
          {t('history.allSummaries')}
        </Link>
      </div>
      <div className="card">
        <div style={{ fontWeight: 600 }}>{summary.title}</div>
        {summary.bullets.length > 0 ? (
          <ul className="small muted list-tight">
            {summary.bullets.slice(0, 4).map((bullet, index) => (
              <li key={index}>{bullet}</li>
            ))}
          </ul>
        ) : null}
        <p className="small faint" style={{ margin: 'var(--space-3) 0 0' }}>
          {t('history.summaryFooter')}
        </p>
      </div>
    </>
  );
}

function ExerciseBlock({ exercise, t }: { exercise: ExerciseEntry; t: Translator['t'] }) {
  const { tPlural } = useI18n();
  const name = exercise.normalizedName || exercise.rawName;
  const sets = exercise.sets;
  const working = workingSets(sets);
  const renamed = name.toLowerCase() !== exercise.rawName.toLowerCase();

  return (
    <section className="exercise-card">
      <header className="exercise-head">
        <Link className="exercise-name" to={`/exercise/${encodeURIComponent(name)}`}>
          {name}
          {renamed ? (
            <span className="small faint"> · {t('history.loggedAs', { name: exercise.rawName })}</span>
          ) : null}
        </Link>
        <span className="small faint">
          {tPlural('exercise.setsCount', 'exercise.oneSet', working.length)}
        </span>
        <span className="chevron">›</span>
      </header>
      {sets.length === 0 ? (
        <p className="small muted" style={{ margin: 0, padding: 'var(--space-3)' }}>
          {t('history.noSets')}
        </p>
      ) : (
        <div className="list" style={{ padding: 'var(--space-1) var(--space-3) var(--space-2)' }}>
          {sets.map((set, index) => (
            <div className="row-between set-row" key={set.id}>
              <span className="small faint set-num">
                {set.isWarmup ? t('workout.warmup') : `#${index + 1}`}
              </span>
              <span className="spread mono" style={{ textAlign: 'left', paddingLeft: 8 }}>
                {describeSet(set)}
              </span>
              <span className="small faint">{describeSetMeta(set, t)}</span>
            </div>
          ))}
        </div>
      )}
      {exercise.notes ? (
        <p className="small muted" style={{ margin: 0, padding: '0 var(--space-3) var(--space-3)' }}>
          {exercise.notes}
        </p>
      ) : null}
    </section>
  );
}

function describeSet(set: SetEntry): string {
  const parts: string[] = [];
  if (set.weight !== null) parts.push(`${formatNumber(set.weight)} ${set.unit}`);
  if (set.reps !== null) parts.push(`× ${set.reps}`);
  if (set.weight === null && set.reps === null && set.durationSec !== null) {
    parts.push(`${set.durationSec}s`);
  }
  if (set.distance !== null) {
    parts.push(`${formatNumber(set.distance)} ${set.distanceUnit ?? ''}`.trim());
  }
  return parts.length > 0 ? parts.join(' ') : '—';
}

function describeSetMeta(set: SetEntry, t: Translator['t']): string {
  const parts: string[] = [];
  if (set.rpe !== null) parts.push(`${t('workout.rpe')} ${formatNumber(set.rpe, 1)}`);
  if (set.rir !== null) parts.push(`${t('workout.rir')} ${set.rir}`);
  if (set.isFailure) parts.push(t('workout.failure'));
  if (set.isDropSet) parts.push(t('workout.drop'));
  if (set.restSec !== null && set.restSec > 0) {
    parts.push(t('workout.restLabel', { time: `${set.restSec}s` }));
  }
  const oneRm = estimateOneRepMaxKg(set);
  if (oneRm !== null && set.reps !== null && set.reps > 1) {
    parts.push(`${t('exercise.metricE1rm')} ${formatNumber(oneRm, 0)}kg`);
  }
  return parts.join(' · ');
}
