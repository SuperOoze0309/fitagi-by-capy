import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { EmptyState, PageHeader, Segmented } from '../components/ui';
import { ProgressChart } from '../components/ProgressChart';
import { RuleFormSheet } from '../components/RuleFormSheet';
import { Sheet } from '../components/Sheet';
import { formatNumber, fromKg, roundDisplayWeight } from '../domain/units';
import { formatDayLabel, formatDate, localDateKey } from '../domain/datetime';
import { bestSet, estimateOneRepMaxKg, workingSets } from '../domain/metrics';
import type { SetEntry, WeightUnit } from '../domain/types';
import type { Translator } from '../i18n';
import { repositories } from '../repositories';
import type { ExerciseHistoryEntry, ExerciseSummary } from '../repositories/exerciseRepository';
import { useApp, useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';

interface Loaded {
  name: string;
  summary: ExerciseSummary;
  history: ExerciseHistoryEntry[];
}
/**
 * History of one exercise across every workout: the answer to "what did I lift
 * last time, and am I progressing?".
 *
 * Everything is folded from the stored workouts by `ExerciseRepository`, so this
 * page holds no data of its own beyond what it renders.
 */
export function ExercisePage() {
  const { name = '' } = useParams<{ name: string }>();
  const exerciseName = decodeURIComponent(name);
  const navigate = useNavigate();
  const toast = useToast();
  const { settings } = useApp();
  const { t, tPlural, intlTag } = useI18n();

  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState<'top' | 'e1rm'>('top');
  const [ruleSheetOpen, setRuleSheetOpen] = useState(false);
  const [aliasFor, setAliasFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const exercises = repositories().exercises;
      const [history, summary] = await Promise.all([
        exercises.history(exerciseName),
        exercises.summary(exerciseName),
      ]);
      setData(summary ? { name: exerciseName, summary, history } : null);
    } catch (error) {
      // A storage read that fails must not leave the splash on screen forever: an
      // endless spinner looks like a hung app, where "no history" is a state the user
      // can act on. The console keeps the real reason.
      console.warn('[exercise] could not load history', error);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [exerciseName]);

  useEffect(() => {
    void load();
  }, [load]);

  const unit = settings.defaultUnit;

  /**
   * Chart data, oldest first so the line reads left to right.
   *
   * Two metrics, because they answer different questions: the top set shows raw
   * strength, while e1RM makes a heavy triple comparable with a light set of ten.
   */
  const chartPoints = useMemo(() => {
    if (!data) return [];
    return [...data.history]
      .reverse()
      .map((entry) => {
        const top = entry.bestSet;
        if (!top || top.weightKg === null) return null;

        const topDisplay = fromKg(top.weightKg, unit);
        const oneRm = estimateOneRepMaxKg(top);
        const value = metric === 'top' ? topDisplay : fromKg(oneRm ?? top.weightKg, unit);

        return {
          x: entry.date.getTime(),
          value,
          label: formatDayLabel(entry.dateKey, {
            today: t('common.today'),
            yesterday: t('common.yesterday'),
            intlTag,
          }),
          secondary:
            metric === 'top'
              ? `${formatNumber(topDisplay)} ${unit} × ${top.reps ?? '—'}`
              : t('exercise.fromSet', {
                  value: formatNumber(topDisplay),
                  unit,
                  reps: top.reps ?? '—',
                }),
        };
      })
      .filter((point): point is NonNullable<typeof point> => point !== null);
  }, [data, metric, unit, t, intlTag]);

  if (loading) {
    return (
      <div className="splash">
        <div className="small">{t('exercise.loading')}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title={exerciseName || t('workout.exerciseName')} />
        <main className="app-main">
          <div className="page">
            <EmptyState title={t('exercise.notFoundTitle')} hint={t('exercise.notFoundHint')} />
            <div className="page-actions">
              <button type="button" className="btn btn-block" onClick={() => navigate('/history')}>
                {t('history.backToHistory')}
              </button>
            </div>
          </div>
        </main>
      </>
    );
  }

  const { summary, history } = data;
  const bestWeight = summary.bestWeightKg === null ? null : fromKg(summary.bestWeightKg, unit);

  return (
    <>
      <PageHeader
        title={exerciseName}
        subtitle={`${tPlural(
          'addExercise.sessions',
          'addExercise.oneSession',
          summary.sessionCount,
        )} · ${tPlural('exercise.setsCount', 'exercise.oneSet', summary.totalWorkingSets)}`}
        action={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>
            {t('common.back')}
          </button>
        }
      />

      <main className="app-main">
        <div className="page">
          <div className="card">
            <div className="stat-grid">
              <div>
                <div className="stat-label">{t('exercise.bestSet')}</div>
                <div className="stat-value">
                  {bestWeight === null
                    ? '—'
                    : `${formatNumber(roundDisplayWeight(bestWeight, unit))} ${unit} × ${
                        summary.bestReps ?? '—'
                      }`}
                </div>
              </div>
              <div>
                <div className="stat-label">{t('exercise.sessions')}</div>
                <div className="stat-value">{summary.sessionCount}</div>
              </div>
              <div>
                <div className="stat-label">{t('exercise.totalSets')}</div>
                <div className="stat-value">{summary.totalWorkingSets}</div>
              </div>
              <div>
                <div className="stat-label">{t('exercise.lastDone')}</div>
                <div className="stat-value">
                  {formatDayLabel(localDateKey(summary.lastPerformed), {
                    today: t('common.today'),
                    yesterday: t('common.yesterday'),
                    intlTag,
                  })}
                </div>
              </div>
              <div>
                <div className="stat-label">{t('exercise.prs')}</div>
                <div className="stat-value">
                  {summary.personalBestCount > 0 ? summary.personalBestCount : '—'}
                  {summary.bestWeightDateKey ? (
                    <span className="small faint"> · {summary.bestWeightDateKey}</span>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="row-wrap" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-sm" onClick={() => setAliasFor(exerciseName)}>
                {t('exercise.rename')}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setRuleSheetOpen(true)}>
                {t('exercise.allRules')}
              </button>
            </div>
          </div>

          {data.history.length >= 2 ? (
            <div className="card">
              <div className="row-between">
                <div style={{ fontWeight: 600 }}>{t('exercise.progress')}</div>
                <Segmented
                  ariaLabel={t('exercise.progress')}
                  value={metric}
                  options={[
                    { value: 'top', label: t('exercise.metricTop') },
                    { value: 'e1rm', label: t('exercise.metricE1rm') },
                  ]}
                  onChange={setMetric}
                />
              </div>
              <ProgressChart
                points={chartPoints}
                unit={unit}
                ariaLabel={`${metric === 'top' ? t('exercise.metricTop') : t('exercise.metricE1rm')} · ${exerciseName} · ${tPlural(
                  'addExercise.sessions',
                  'addExercise.oneSession',
                  chartPoints.length,
                )}`}
              />
              {metric === 'e1rm' ? (
                <p className="small faint" style={{ margin: '8px 0 0' }}>
                  {t('exercise.e1rmHint')}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="section-title">
            <span>{t('exercise.sessionLog')}</span>
          </div>

          <div className="stack">
            {history.map((entry, index) => {
              const previous = history[index + 1];
              return (
                <SessionCard
                  key={`${entry.workoutId}-${index}`}
                  entry={entry}
                  previous={previous}
                  unit={unit}
                />
              );
            })}
          </div>

          <p className="small faint" style={{ marginTop: 14 }}>
            {t('exercise.unitFootnote', { unit })}
          </p>
        </div>
      </main>

      {ruleSheetOpen || aliasFor !== null ? (
        <Sheet
          title={aliasFor !== null ? t('exercise.rename') : t('rules.title')}
          onClose={() => {
            setRuleSheetOpen(false);
            setAliasFor(null);
            void load();
          }}
        >
          <p className="small muted" style={{ marginTop: 0 }}>
            {aliasFor !== null ? t('rules.explanation') : t('rules.footer')}
          </p>
          <RuleFormSheet
            presetMatch={aliasFor ?? ''}
            presetNormalized={aliasFor ?? ''}
            onSaved={() => {
              toast.show(t('common.saved'), 'success');
              void load();
            }}
          />
        </Sheet>
      ) : null}
    </>
  );
}

function SessionCard({
  entry,
  previous,
  unit,
}: {
  entry: ExerciseHistoryEntry;
  previous: ExerciseHistoryEntry | undefined;
  unit: WeightUnit;
}) {
  const { t, tPlural, intlTag } = useI18n();
  const working = workingSets(entry.sets);
  const top = bestSet(entry.sets);
  const oneRm = top ? estimateOneRepMaxKg(top) : null;

  // Compare the top set against the previous session for this exercise.
  let delta: number | null = null;
  if (top?.weightKg != null && previous?.bestSet?.weightKg != null) {
    delta = fromKg(top.weightKg, unit) - fromKg(previous.bestSet.weightKg, unit);
  }

  return (
    <Link
      to={`/history/${entry.workoutId}`}
      className="card"
      style={{ display: 'block', color: 'inherit' }}
    >
      <div className="row-between">
        <div>
          <div style={{ fontWeight: 600 }}>
            {formatDate(entry.date.toISOString(), intlTag)}
            {entry.isPersonalBest ? (
              <span className="badge live" style={{ marginLeft: 6 }}>
                {t('exercise.pr')}
              </span>
            ) : null}
          </div>
          <div className="small faint">
            {tPlural('exercise.setsCount', 'exercise.oneSet', working.length)} ·{' '}
            {t('exercise.volumeLabel', {
              value: formatNumber(fromKg(entry.volumeKg, unit), 0),
              unit,
            })}
            {oneRm !== null
              ? ` · ${t('exercise.metricE1rm')} ${formatNumber(fromKg(oneRm, unit), 0)}${unit}`
              : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {delta !== null && Math.abs(delta) >= 0.01 ? (
            <span className={delta > 0 ? 'badge live' : 'badge neutral'}>
              {delta > 0 ? '+' : ''}
              {formatNumber(roundDisplayWeight(delta, unit))} {unit}
            </span>
          ) : null}
          <div className="chevron" style={{ marginTop: 4 }}>
            ›
          </div>
        </div>
      </div>
      <div className="small mono" style={{ marginTop: 8, color: 'var(--text-muted)' }}>
        {working.map((set) => describeSetCompact(set, t)).join('  ·  ') ||
          t('exercise.noWorkingSets')}
      </div>
    </Link>
  );
}

function describeSetCompact(set: SetEntry, t: Translator['t']): string {
  const weight = set.weight === null ? '—' : formatNumber(set.weight);
  const reps = set.reps === null ? '—' : String(set.reps);
  const flags: string[] = [];
  if (set.rpe !== null) flags.push(`@${formatNumber(set.rpe, 1)}`);
  if (set.isFailure) flags.push(t('workout.failure'));
  if (set.isDropSet) flags.push(t('workout.drop'));
  return `${weight}${set.unit}×${reps}${flags.length > 0 ? ` ${flags.join(' ')}` : ''}`;
}
