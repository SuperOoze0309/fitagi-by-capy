import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EmptyState, PageHeader } from '../components/ui';
import { formatDuration, formatNumber, fromKg } from '../domain/units';
import { formatDayLabel, formatRelative, formatTimeOfDay, localDateKey } from '../domain/datetime';
import { countWorkingSets, workoutVolumeKg } from '../domain/metrics';
import type { Meal, PlanDay, Reminder, Workout } from '../domain/types';
import { repositories } from '../repositories';
import { summarizeDay } from '../repositories/mealRepository';
import {
  createExerciseEntry,
  createSetFromPrevious,
  createWorkout,
  withSetWeight,
} from '../domain/workout';
import { SummaryService } from '../services/summaries/summaryService';
import { minutesUntilNext } from '../services/reminders';
import { useApp, useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';
import { ThemeScenery } from '../components/ThemeScenery';

interface Loaded {
  inProgress: Workout | null;
  recent: Workout[];
  totalWorkouts: number;
  todayMeals: Meal[];
  /** The active plan's entry for today, when there is one and it is not a rest day. */
  todayPlan: PlanDay | null;
  /** True when the active plan marks today as rest. */
  restToday: boolean;
  /** The soonest enabled reminder, if any. */
  nextReminder: Reminder | null;
}

/** Home: resume or start a workout, plus a glance at recent training and food. */
export function HomePage() {
  const navigate = useNavigate();
  const { settings } = useApp();
  const { t, intlTag } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<Loaded | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    const repos = repositories();
    const todayKey = localDateKey(new Date());
    const weekday = new Date().getDay();
    const [inProgress, completed, total, todayMeals, activePlan, reminders] = await Promise.all([
      repos.training.inProgress(),
      repos.training.completed(),
      repos.training.count(),
      repos.meals.forDate(todayKey),
      repos.plans.active(),
      repos.reminders.all(),
    ]);

    const planDay = activePlan?.days.find((day) => day.weekday === weekday) ?? null;
    // The sorted reminder list already puts enabled ones first, so the soonest is
    // simply the first enabled one that computes a next time.
    const upcoming =
      reminders.find((reminder) => reminder.enabled && minutesUntilNext(reminder) !== null) ?? null;

    setData({
      inProgress,
      recent: completed.slice(0, 5),
      totalWorkouts: total,
      todayMeals,
      todayPlan: planDay && !planDay.rest && planDay.exercises.length > 0 ? planDay : null,
      restToday: planDay?.rest === true,
      nextReminder: upcoming,
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Fill in summaries for periods that predate this feature or arrived via an
   * import. It only looks at the current and previous week/month and does nothing
   * when they already exist, so it stays cheap on every launch.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await new SummaryService(repositories()).catchUp(settings.defaultUnit);
        if (cancelled) return;
        const created = result.daily + result.weekly + result.monthly;
        if (created > 0) {
          toast.show(
            created === 1
              ? t('summaries.generatedToastOne')
              : t('summaries.generatedToast', { count: created }),
          );
        }
      } catch (error) {
        // Never let bookkeeping break the home screen.
        console.warn('[summary] catch-up failed', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.defaultUnit, toast, t]);

  /**
   * Start the session the active plan has for today.
   *
   * The same shape as the Plans page, because "start today's workout" has to mean one
   * thing: a new workout containing the prescribed exercises, which the user then logs.
   * Prescriptions become sets, a target weight becomes the set weight, and a reps
   * prescription contributes only its leading number — "AMRAP" is left for the user.
   */
  const startTodayPlan = useCallback(async () => {
    if (starting || !data?.todayPlan) return;
    setStarting(true);
    try {
      const created = await repositories().training.put(createWorkout());
      for (const [index, prescribed] of data.todayPlan.exercises.entries()) {
        const entry = createExerciseEntry(created.id, prescribed.name, index);
        const reps = /^\s*(\d+)/.exec(prescribed.reps);
        const sets = Array.from({ length: Math.max(1, prescribed.sets) }, (_, setIndex) => {
          const base = createSetFromPrevious(undefined, settings.defaultUnit);
          const next = { ...base, reps: reps ? Number(reps[1]) : 0, order: setIndex };
          if (prescribed.targetWeightKg === null) return next;
          const display =
            settings.defaultUnit === 'kg'
              ? prescribed.targetWeightKg
              : prescribed.targetWeightKg / 0.45359237;
          return withSetWeight(next, Math.round(display * 10) / 10, settings.defaultUnit);
        });
        await repositories().training.upsertExercise(created.id, { ...entry, sets });
      }
      toast.show(t('plans.started'), 'success');
      navigate(`/workout/${created.id}`);
    } finally {
      setStarting(false);
    }
  }, [data?.todayPlan, navigate, settings.defaultUnit, starting, t, toast]);

  const startWorkout = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    try {
      const training = repositories().training;
      // A draft left over from a previous session is resumed rather than
      // duplicated, which is what makes "Start workout" safe to tap twice.
      const existing = await training.inProgress();
      if (existing) {
        navigate(`/workout/${existing.id}`);
        return;
      }
      const workout = await training.put(createWorkout());
      navigate(`/workout/${workout.id}`);
    } finally {
      setStarting(false);
    }
  }, [navigate, starting]);

  const todayKey = localDateKey(new Date());
  const todayCount = data?.recent.filter((w) => localDateKey(w.startTime) === todayKey).length ?? 0;
  const mealTotals = summarizeDay(data?.todayMeals ?? []);

  return (
    <>
      <PageHeader
        title={t('app.name')}
        subtitle={
          data
            ? t('home.workoutsLogged', {
                count: data.totalWorkouts,
                unit: settings.defaultUnit,
              })
            : t('common.loading')
        }
      />
      <main className="app-main">
        <div className="page">
          {data?.inProgress ? (
            <div className="card" style={{ borderColor: 'var(--primary)' }}>
              <div className="row-wrap">
                <span className="badge primary">{t('home.inProgress')}</span>
              </div>
              <div className="small muted" style={{ marginTop: 'var(--space-2)' }}>
                {t('home.inProgressDetail', {
                  exercises: data.inProgress.exercises.length,
                  sets: countWorkingSets(data.inProgress),
                  when: formatRelative(data.inProgress.startTime, intlTag),
                })}
              </div>
              <button
                type="button"
                className="btn btn-primary btn-block btn-hero"
                style={{ marginTop: 'var(--space-3)' }}
                onClick={() => navigate(`/workout/${data.inProgress?.id}`)}
              >
                {t('home.resumeWorkout')}
              </button>
              <ThemeScenery />
            </div>
          ) : (
            <div className="card">
              <div className="row-wrap">
                <span className="badge primary">{t('home.readyBadge')}</span>
              </div>
              <div className="small muted" style={{ marginTop: 'var(--space-2)' }}>
                {t('home.readyBody')}
              </div>
              <button
                type="button"
                className="btn btn-primary btn-block btn-hero"
                style={{ marginTop: 'var(--space-3)' }}
                disabled={starting || !data}
                onClick={() => void startWorkout()}
              >
                {starting ? t('home.starting') : t('home.startWorkout')}
              </button>
              <ThemeScenery />
            </div>
          )}

          {/*
            Today's plan and the next reminder, on the screen the app opens on.
            Both are the payoff of setting them up, and burying them a navigation
            deep means nobody uses them.
          */}
          {data?.todayPlan ? (
            <div className="card">
              <div className="row-between">
                <span className="badge primary">{t('plans.todayTitle')}</span>
                <span className="small faint">
                  {t('plans.weeklySets', {
                    count: data.todayPlan.exercises.reduce((sum, item) => sum + item.sets, 0),
                  })}
                </span>
              </div>
              <div className="label-strong" style={{ marginTop: 'var(--space-2)' }}>
                {data.todayPlan.title || t('plans.todayTitle')}
              </div>
              <ul className="small muted list-tight">
                {data.todayPlan.exercises.slice(0, 5).map((exercise) => (
                  <li key={exercise.id}>
                    {exercise.name} — {exercise.sets} × {exercise.reps}
                    {exercise.targetWeightKg !== null ? ` @ ${exercise.targetWeightKg} kg` : ''}
                  </li>
                ))}
                {data.todayPlan.exercises.length > 5 ? (
                  <li className="faint">
                    {t('history.more', { count: data.todayPlan.exercises.length - 5 })}
                  </li>
                ) : null}
              </ul>
              <div className="page-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  // Only meaningful when nothing is already being recorded: two open
                  // sessions would leave the recorder showing one of them at random.
                  disabled={starting || data.inProgress !== null}
                  onClick={() => void startTodayPlan()}
                >
                  {t('plans.startToday')}
                </button>
              </div>
              {data.inProgress ? (
                <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                  {t('plans.finishFirst')}
                </p>
              ) : null}
            </div>
          ) : data?.restToday ? (
            <div className="card">
              <div className="row-between">
                <span className="badge neutral">{t('plans.restToday')}</span>
              </div>
              <p className="small muted" style={{ margin: 'var(--space-2) 0 0' }}>
                {t('plans.restTodayHint')}
              </p>
            </div>
          ) : null}

          {data?.nextReminder ? (
            <Link
              className="card card-clickable"
              to="/reminders"
              style={{ display: 'block', color: 'inherit' }}
            >
              <div className="row-between">
                <div className="row" style={{ minWidth: 0, gap: 'var(--space-2)' }}>
                  <span className="mono small">
                    {formatTimeOfDay(data.nextReminder.time, intlTag)}
                  </span>
                  <span className="small break">
                    {data.nextReminder.title || t('reminders.title')}
                  </span>
                </div>
                <span className="badge">🔔</span>
              </div>
            </Link>
          ) : null}

          <Link
            className="card card-clickable"
            to="/quick-log"
            style={{ display: 'block', color: 'inherit' }}
          >
            <div className="row-between">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{t('home.quickLogTitle')}</div>
                <div className="small muted">{t('home.quickLogBody')}</div>
              </div>
              <span className="badge">
                {settings.aiEnabled ? t('home.aiAndOffline') : t('home.offline')}
              </span>
            </div>
            <div className="banner" style={{ marginTop: 'var(--space-3)' }}>
              {t('home.quickLogHint')}
            </div>
          </Link>

          <div className="card">
            <div className="row-between">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{t('home.mealsToday')}</div>
                <div className="small muted">
                  {t('home.mealsTodayDetail', {
                    count: data?.todayMeals.length ?? 0,
                    calories: formatNumber(mealTotals.calories, 0),
                  })}
                </div>
              </div>
              <Link className="btn btn-sm" to="/meals/new">
                {t('home.logMeal')}
              </Link>
            </div>
          </div>

          <div className="section-title">
            <span>{t('home.recentWorkouts')}</span>
            <Link to="/history" className="small">
              {t('common.viewAll')}
            </Link>
          </div>

          {!data ? (
            <div className="small faint">{t('common.loading')}</div>
          ) : data.recent.length === 0 ? (
            <EmptyState title={t('home.noWorkoutsTitle')} hint={t('home.noWorkoutsHint')} />
          ) : (
            <div className="stack">
              {data.recent.map((workout) => (
                <WorkoutRow key={workout.id} workout={workout} displayUnit={settings.defaultUnit} />
              ))}
            </div>
          )}

          {todayCount > 0 ? (
            <p className="small faint">
              {todayCount === 1
                ? t('home.loggedTodayOne', { date: formatDayLabel(todayKey, { intlTag }) })
                : t('home.loggedToday', {
                    count: todayCount,
                    date: formatDayLabel(todayKey, { intlTag }),
                  })}
            </p>
          ) : null}

          <div className="page-actions">
            <Link className="btn btn-block" to="/summaries">
              {t('home.viewSummaries')}
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}

export function WorkoutRow({
  workout,
  displayUnit,
}: {
  workout: Workout;
  displayUnit: 'kg' | 'lb';
}) {
  const { t, intlTag } = useI18n();
  const names = workout.exercises.map((exercise) => exercise.normalizedName || exercise.rawName);
  const unique = [...new Set(names)];
  const volume = workoutVolumeKg(workout);

  return (
    <Link
      to={`/history/${workout.id}`}
      className="card card-clickable"
      style={{ display: 'block', color: 'inherit' }}
    >
      <div className="row-between">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }} className="break">
            {unique.length > 0
              ? unique.slice(0, 3).join(' · ')
              : t('home.emptyWorkout')}
            {unique.length > 3 ? ` +${unique.length - 3}` : ''}
          </div>
          <div className="small muted">
            {formatDayLabel(localDateKey(workout.startTime), {
              today: t('common.today'),
              yesterday: t('common.yesterday'),
              intlTag,
            })}{' '}
            ·{' '}
            {new Date(workout.startTime).toLocaleTimeString(intlTag, {
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            · {formatDuration(workout.durationSec, t)}
          </div>
        </div>
        <span className="chevron">›</span>
      </div>
      <div className="row-wrap small faint" style={{ marginTop: 'var(--space-2)' }}>
        <span>{t('home.setsCount', { count: countWorkingSets(workout) })}</span>
        <span>
          {t('home.volume', {
            value: formatNumber(fromKg(volume, displayUnit), 0),
            unit: displayUnit,
          })}
        </span>
      </div>
    </Link>
  );
}
