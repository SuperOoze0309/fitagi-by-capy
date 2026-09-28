import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EmptyState, PageHeader } from '../components/ui';
import { formatDuration } from '../domain/units';
import { formatDayLabel, formatTime, localDateKey } from '../domain/datetime';
import { countWorkingSets } from '../domain/metrics';
import type { Workout } from '../domain/types';
import { repositories } from '../repositories';
import { useI18n } from '../state/AppContext';

/** Workouts rendered before the "show more" button appears. */
const PAGE_SIZE = 60;

/**
 * History: newest first, grouped by local calendar day, with search over exercise
 * names and workout notes.
 */
export function HistoryPage() {
  const { t, intlTag } = useI18n();
  const [workouts, setWorkouts] = useState<Workout[] | null>(null);
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(PAGE_SIZE);

  const load = useCallback(async () => {
    setWorkouts(await repositories().training.completed());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!workouts) return [];
    const needle = query.trim().toLowerCase();
    if (needle === '') return workouts;
    return workouts.filter((workout) => {
      if (workout.notes.toLowerCase().includes(needle)) return true;
      return workout.exercises.some(
        (exercise) =>
          exercise.rawName.toLowerCase().includes(needle) ||
          exercise.normalizedName.toLowerCase().includes(needle),
      );
    });
  }, [workouts, query]);

  // A long history is thousands of cards; rendering them all makes scrolling and
  // editing sluggish on a phone, so the list grows in pages.
  const shown = useMemo(() => filtered.slice(0, visible), [filtered, visible]);
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const remaining = filtered.length - shown.length;

  return (
    <>
      <PageHeader
        title={t('history.title')}
        subtitle={
          workouts
            ? t('history.subtitle', { count: workouts.length })
            : t('common.loading')
        }
      />
      <main className="app-main">
        <div className="page">
          <input
            className="input"
            placeholder={t('history.searchPlaceholder')}
            aria-label={t('history.searchPlaceholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              // A new search starts from the top of its own results.
              setVisible(PAGE_SIZE);
            }}
          />

          {workouts === null ? (
            <p className="small faint">{t('common.loading')}</p>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={query ? t('history.noMatchTitle') : t('history.emptyTitle')}
              hint={query ? t('history.noMatchHint') : t('history.emptyHint')}
            />
          ) : (
            groups.map((group) => (
              <section key={group.dateKey}>
                <div className="section-title">
                  <span>
                    {formatDayLabel(group.dateKey, {
                      today: t('common.today'),
                      yesterday: t('common.yesterday'),
                      intlTag,
                    })}
                  </span>
                  <span className="faint">
                    {group.workouts.length === 1
                      ? t('history.oneWorkout')
                      : t('history.workoutCount', { count: group.workouts.length })}
                  </span>
                </div>
                <div className="stack">
                  {group.workouts.map((workout) => (
                    <HistoryRow key={workout.id} workout={workout} />
                  ))}
                </div>
              </section>
            ))
          )}

          {remaining > 0 ? (
            <div className="page-actions">
              <button
                type="button"
                className="btn btn-block"
                onClick={() => setVisible((current) => current + PAGE_SIZE)}
              >
                {t('history.showMore', { count: Math.min(remaining, PAGE_SIZE) })}
                <span className="faint"> · {t('history.hidden', { count: remaining })}</span>
              </button>
            </div>
          ) : null}

          {workouts !== null && filtered.length > 0 ? (
            <p className="small faint">
              {t('history.showing', { shown: shown.length, total: filtered.length })}
            </p>
          ) : null}
        </div>
      </main>
    </>
  );
}

function HistoryRow({ workout }: { workout: Workout }) {
  const { t, intlTag } = useI18n();
  const navigate = useNavigate();
  const exercises = workout.exercises.map((exercise) => exercise.normalizedName || exercise.rawName);
  const unique = [...new Set(exercises)];

  return (
    // A row is a clickable region rather than a link, because the exercise names
    // inside it are links themselves and anchors cannot be nested.
    <article
      className="card card-clickable"
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/history/${workout.id}`)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          navigate(`/history/${workout.id}`);
        }
      }}
    >
      <div className="row-between">
        <span style={{ fontWeight: 600 }}>{formatTime(workout.startTime, intlTag)}</span>
        <span className="small faint">
          {formatDuration(workout.durationSec, t)} ·{' '}
          {t('home.setsCount', { count: countWorkingSets(workout) })}
        </span>
      </div>
      {unique.length > 0 ? (
        <ul
          className="small muted"
          style={{ margin: 'var(--space-2) 0 0', paddingLeft: 18 }}
          onClick={(event) => event.stopPropagation()}
        >
          {unique.slice(0, 4).map((name) => {
            const matched = workout.exercises.filter(
              (exercise) => (exercise.normalizedName || exercise.rawName) === name,
            );
            const setCount = matched.reduce((sum, exercise) => sum + exercise.sets.length, 0);
            const first = matched[0]?.sets[0];
            const detail =
              first && first.weight !== null && first.reps !== null
                ? ` · ${Number(first.weight.toFixed(2))}${first.unit} × ${first.reps}${
                    setCount > 1 ? ` × ${setCount}` : ''
                  }`
                : setCount > 0
                  ? ` · ${t('home.setsCount', { count: setCount })}`
                  : '';
            return (
              <li key={name}>
                <Link to={`/exercise/${encodeURIComponent(name)}`}>{name}</Link>
                {detail}
              </li>
            );
          })}
          {unique.length > 4 ? (
            <li className="faint">{t('history.more', { count: unique.length - 4 })}</li>
          ) : null}
        </ul>
      ) : (
        <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
          {t('history.noExercises')}
        </p>
      )}
      {workout.notes ? (
        <p className="small faint" style={{ margin: 'var(--space-2) 0 0', fontStyle: 'italic' }}>
          “{workout.notes}”
        </p>
      ) : null}
    </article>
  );
}

interface DayGroup {
  dateKey: string;
  workouts: Workout[];
}

function groupByDay(workouts: Workout[]): DayGroup[] {
  const map = new Map<string, Workout[]>();
  for (const workout of workouts) {
    const key = localDateKey(workout.startTime);
    const bucket = map.get(key);
    if (bucket) bucket.push(workout);
    else map.set(key, [workout]);
  }
  return [...map.entries()].map(([dateKey, rows]) => ({ dateKey, workouts: rows }));
}
