import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EmptyState, PageHeader } from '../components/ui';
import { ConfirmDialog } from '../components/Sheet';
import { formatTime, localDateKey, formatDayLabel } from '../domain/datetime';
import { formatNumber } from '../domain/units';
import type { Meal } from '../domain/types';
import { repositories } from '../repositories';
import { summarizeDay } from '../repositories/mealRepository';
import { useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';

/** Meals are listed a page at a time, for the same reason History is. */
const PAGE_SIZE = 40;

/**
 * The meal log.
 *
 * Manual entry is always available and never depends on AI; the photo flow is an
 * accelerator that lives one tap away on its own screen.
 */
export function MealsPage() {
  const { t, tPlural } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();

  const [meals, setMeals] = useState<Meal[] | null>(null);
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [confirmDelete, setConfirmDelete] = useState<Meal | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const rows = await repositories().meals.all();
    setMeals(rows);
    // Thumbnails are loaded for the visible rows only, so a long history does not
    // read every photo out of the database at once.
    const first = rows.slice(0, PAGE_SIZE);
    const loaded: Record<string, string> = {};
    for (const meal of first) {
      if (!meal.imageKey) continue;
      const data = await repositories().meals.loadImage(meal.imageKey);
      if (data) loaded[meal.id] = data;
    }
    setThumbs(loaded);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!meals) return [];
    const needle = query.trim().toLowerCase();
    if (needle === '') return meals;
    return meals.filter(
      (meal) =>
        meal.name.toLowerCase().includes(needle) ||
        meal.notes.toLowerCase().includes(needle) ||
        meal.items.some((item) => item.name.toLowerCase().includes(needle)),
    );
  }, [meals, query]);

  const shown = useMemo(() => filtered.slice(0, visible), [filtered, visible]);
  const remaining = filtered.length - shown.length;

  const todayKey = localDateKey(new Date());
  const todayMeals = useMemo(
    () => (meals ?? []).filter((meal) => localDateKey(meal.eatenAt) === todayKey),
    [meals, todayKey],
  );
  const todayTotal = useMemo(() => summarizeDay(todayMeals), [todayMeals]);

  const groups = useMemo(() => groupByDay(shown), [shown]);

  const remove = useCallback(
    async (meal: Meal) => {
      await repositories().meals.remove(meal.id);
      await load();
      toast.show(t('meals.deleted'));
    },
    [load, toast, t],
  );

  return (
    <>
      <PageHeader
        title={t('meals.title')}
        subtitle={meals ? t('meals.subtitle', { count: meals.length }) : t('common.loading')}
        action={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => navigate('/meals/new')}
          >
            + {t('meals.logMeal')}
          </button>
        }
      />
      <main className="app-main">
        <div className="page">
          <div className="card">
            <div className="row-between">
              <div style={{ fontWeight: 600 }}>{t('meals.today')}</div>
              <span className="badge primary">
                {t('meals.todayTotal', {
                  calories: todayTotal.calories,
                  protein: formatNumber(todayTotal.proteinG, 0),
                })}
              </span>
            </div>
            <div className="macro-grid" style={{ marginTop: 'var(--space-3)' }}>
              <Macro label={t('common.calories')} value={formatNumber(todayTotal.calories, 0)} unit="kcal" />
              <Macro label={t('common.protein')} value={formatNumber(todayTotal.proteinG, 0)} unit="g" />
              <Macro label={t('common.carbs')} value={formatNumber(todayTotal.carbsG, 0)} unit="g" />
              <Macro label={t('common.fat')} value={formatNumber(todayTotal.fatG, 0)} unit="g" />
            </div>
          </div>

          <input
            className="input"
            placeholder={t('meals.searchPlaceholder')}
            aria-label={t('meals.searchPlaceholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisible(PAGE_SIZE);
            }}
          />

          {meals === null ? (
            <p className="small faint">{t('common.loading')}</p>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={query ? t('meals.noMatchTitle') : t('meals.emptyTitle')}
              hint={query ? t('meals.noMatchHint') : t('meals.emptyHint')}
            />
          ) : (
            groups.map((group) => (
              <section key={group.dateKey}>
                <div className="section-title">
                  <span>{formatDayLabel(group.dateKey)}</span>
                  <span className="faint">
                    {formatNumber(summarizeDay(group.meals).calories, 0)} kcal
                  </span>
                </div>
                <div className="list">
                  {group.meals.map((meal) => (
                    <article key={meal.id} className="card">
                      <div className="row-between">
                        <div className="row" style={{ minWidth: 0, flex: 1 }}>
                          {thumbs[meal.id] ? (
                            <img
                              className="meal-photo-thumb"
                              src={thumbs[meal.id]}
                              alt={t('meals.photo')}
                              loading="lazy"
                            />
                          ) : null}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }} className="break">
                              {meal.name || t('common.unknown')}
                            </div>
                            <div className="small muted">
                              {formatTime(meal.eatenAt)}
                              {meal.portion ? ` · ${meal.portion}` : ''}
                              {' · '}
                              {meal.items.length === 1
                                ? t('meals.oneItem')
                                : tPlural('meals.itemsCount', 'meals.oneItem', meal.items.length)}
                            </div>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', flex: 'none' }}>
                          <div className="mono" style={{ fontWeight: 650 }}>
                            {meal.calories === null ? '—' : formatNumber(meal.calories, 0)}
                            <span className="small faint"> kcal</span>
                          </div>
                          <MealSourceBadge meal={meal} />
                        </div>
                      </div>

                      <div className="macro-grid" style={{ marginTop: 'var(--space-2)' }}>
                        <Macro label="P" value={formatNumber(meal.proteinG, 0)} unit="g" />
                        <Macro label="C" value={formatNumber(meal.carbsG, 0)} unit="g" />
                        <Macro label="F" value={formatNumber(meal.fatG, 0)} unit="g" />
                      </div>

                      <div className="row" style={{ marginTop: 'var(--space-2)', gap: 'var(--space-2)' }}>
                        <Link className="btn btn-sm" to={`/meals/${meal.id}`}>
                          {t('common.edit')}
                        </Link>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setConfirmDelete(meal)}
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    </article>
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
                {t('meals.showMore', { count: Math.min(remaining, PAGE_SIZE) })}
                <span className="faint"> · {t('meals.hidden', { count: remaining })}</span>
              </button>
            </div>
          ) : null}
        </div>
      </main>

      {confirmDelete ? (
        <ConfirmDialog
          title={t('meals.deleteTitle')}
          message={t('meals.deleteBody')}
          confirmLabel={t('meals.deleteConfirm')}
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const target = confirmDelete;
            setConfirmDelete(null);
            void remove(target);
          }}
        />
      ) : null}
    </>
  );
}

/** Compact macro figure, reused for the day total and each meal. */
export function Macro({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="macro">
      <div className="macro-label">{label}</div>
      <div className="macro-value">
        {value}
        <span className="small faint"> {unit}</span>
      </div>
    </div>
  );
}

/** Where a meal's numbers came from — an estimate must look like one. */
export function MealSourceBadge({ meal }: { meal: Meal }) {
  const { t } = useI18n();
  if (meal.source === 'manual') {
    return <span className="badge neutral">{t('meals.sourceManual')}</span>;
  }
  return (
    <span className="badge warn">
      {meal.source === 'ai-edited' ? t('meals.sourceAiEdited') : t('meals.sourceAi')}
    </span>
  );
}

function groupByDay(meals: Meal[]): { dateKey: string; meals: Meal[] }[] {
  const map = new Map<string, Meal[]>();
  for (const meal of meals) {
    const key = localDateKey(meal.eatenAt);
    const bucket = map.get(key);
    if (bucket) bucket.push(meal);
    else map.set(key, [meal]);
  }
  return [...map.entries()].map(([dateKey, rows]) => ({ dateKey, meals: rows }));
}
