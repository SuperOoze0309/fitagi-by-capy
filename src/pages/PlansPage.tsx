import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConfirmDialog, Sheet } from '../components/Sheet';
import { EmptyState, Field, PageHeader, Segmented } from '../components/ui';
import { NumberField } from '../components/NumberField';
import { weekdayNames } from '../domain/datetime';
import { createExerciseEntry, createSetFromPrevious, createWorkout, withSetWeight } from '../domain/workout';
import type { PlanDay, PlanExercise, TrainingGoal, TrainingPlan } from '../domain/types';
import {
  createEmptyPlan,
  createEmptyPlanDay,
  createEmptyPlanExercise,
  planTrainingDays,
  planWeeklySets,
} from '../repositories/planRepository';
import { repositories } from '../repositories';
import { aiService } from '../services/ai';
import type { PlanProposal } from '../services/ai';
import { SummaryService } from '../services/summaries/summaryService';
import { useApp, useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';

const GOALS: TrainingGoal[] = ['fatLoss', 'muscleGain', 'strength', 'endurance', 'generalFitness'];

/**
 * Training plans.
 *
 * A plan is a week of intentions, not a record: nothing here touches the workout
 * history. Starting a session from a plan copies today's exercises into a new
 * workout, which the user then logs normally — so a plan that turns out to be wrong
 * costs nothing but an edit.
 */
export function PlansPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { t, intlTag } = useI18n();
  const { settings, profile } = useApp();

  const [plans, setPlans] = useState<TrainingPlan[] | null>(null);
  const [editing, setEditing] = useState<TrainingPlan | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TrainingPlan | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<PlanProposal | null>(null);

  const weekdays = useMemo(() => weekdayNames(intlTag), [intlTag]);
  const today = new Date().getDay();

  const load = useCallback(async () => {
    setPlans(await repositories().plans.all());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = plans?.find((plan) => plan.active) ?? null;
  const todayDay = active?.days.find((day) => day.weekday === today) ?? null;

  const save = useCallback(
    async (plan: TrainingPlan) => {
      await repositories().plans.save(plan);
      setEditing(null);
      await load();
      toast.show(t('plans.saved'), 'success');
    },
    [load, t, toast],
  );

  const activate = useCallback(
    async (plan: TrainingPlan) => {
      await repositories().plans.save({ ...plan, active: true });
      await load();
      toast.show(t('plans.activated', { name: plan.name || t('plans.title') }), 'success');
    },
    [load, t, toast],
  );

  const remove = useCallback(
    async (plan: TrainingPlan) => {
      setConfirmDelete(null);
      await repositories().plans.remove(plan.id);
      await load();
      toast.show(t('plans.deleted'));
    },
    [load, t, toast],
  );

  /**
   * Start today's session.
   *
   * The plan's prescriptions become real sets: a target weight becomes the set's
   * weight, and "8-10" is left as a repetition count of 0 for the user to fill in
   * rather than guessed at. The workout is created here and opened in the recorder,
   * which is the same path as "Start workout" on Home.
   */
  const startToday = useCallback(async () => {
    if (!todayDay) return;
    const workout = createWorkout();
    const created = await repositories().training.put(workout);

    for (const [index, prescribed] of todayDay.exercises.entries()) {
      const entry = createExerciseEntry(created.id, prescribed.name, index);
      const sets = Array.from({ length: Math.max(1, prescribed.sets) }, (_, setIndex) => {
        const base = createSetFromPrevious(undefined, settings.defaultUnit);
        const reps = parseLeadingNumber(prescribed.reps);
        const next = { ...base, reps, order: setIndex };
        if (prescribed.targetWeightKg === null) return next;
        // Stored weight is in kg; the set carries the display unit the user chose.
        const display = settings.defaultUnit === 'kg'
          ? prescribed.targetWeightKg
          : prescribed.targetWeightKg / 0.45359237;
        return withSetWeight(next, Math.round(display * 10) / 10, settings.defaultUnit);
      });
      await repositories().training.upsertExercise(created.id, { ...entry, sets });
    }

    void new SummaryService(repositories()).refreshForWorkout(created, settings.defaultUnit).catch(
      () => undefined,
    );
    toast.show(t('plans.started'), 'success');
    navigate(`/workout/${created.id}`);
  }, [navigate, settings.defaultUnit, t, toast, todayDay]);

  const draft = useCallback(async () => {
    setBusy(true);
    try {
      const ai = aiService(settings);
      if (!ai.isEnabled()) {
        toast.show(t('plans.aiNeedsAi'));
        return;
      }
      const suggestions = await repositories().exercises.suggestions(40);
      const result = await ai.proposePlan(prompt, {
        profile,
        knownExercises: suggestions.map((suggestion) => suggestion.name),
      });
      if (result.days.every((day) => day.rest)) {
        toast.show(t('plans.aiFailed'));
        return;
      }
      setProposal(result);
      setDrafting(false);
    } catch (error) {
      toast.show(error instanceof Error ? error.message : t('plans.aiFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }, [profile, prompt, settings, t, toast]);

  const acceptProposal = useCallback(async () => {
    if (!proposal) return;
    const plan: TrainingPlan = {
      ...createEmptyPlan(),
      name: proposal.name || t('plans.newTitle'),
      goal: proposal.goal,
      notes: proposal.notes,
      source: 'ai',
      days: proposal.days.map((day) =>
        createEmptyPlanDay(day.weekday, {
          title: day.title,
          rest: day.rest,
          exercises: day.exercises.map((exercise) =>
            createEmptyPlanExercise(exercise.name),
          ).map((exercise, index) => ({
            ...exercise,
            sets: day.exercises[index]?.sets ?? exercise.sets,
            reps: day.exercises[index]?.reps ?? exercise.reps,
          })),
        }),
      ),
    };
    setProposal(null);
    setEditing(plan);
  }, [proposal, t]);

  return (
    <>
      <PageHeader
        title={t('plans.title')}
        subtitle={plans ? t('plans.subtitle', { count: plans.length }) : t('common.loading')}
        action={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setEditing(createEmptyPlan())}
          >
            + {t('plans.add')}
          </button>
        }
      />

      <main className="app-main">
        <div className="page">
          {/* Today's session, when there is an active plan with something on it. */}
          {active ? (
            <div className="card">
              <div className="row-between">
                <span className="label-strong">{t('plans.todayTitle')}</span>
                <span className="badge primary">{active.name || t('plans.active')}</span>
              </div>
              {todayDay && !todayDay.rest ? (
                <>
                  <div className="small muted" style={{ marginTop: 'var(--space-2)' }}>
                    {todayDay.title || weekdays[today]} ·{' '}
                    {t('plans.weeklySets', {
                      count: todayDay.exercises.reduce((sum, item) => sum + item.sets, 0),
                    })}
                  </div>
                  <ul className="small muted list-tight">
                    {todayDay.exercises.map((exercise) => (
                      <li key={exercise.id}>
                        {exercise.name} — {exercise.sets} × {exercise.reps}
                        {exercise.targetWeightKg !== null ? ` @ ${exercise.targetWeightKg} kg` : ''}
                      </li>
                    ))}
                  </ul>
                  <div className="page-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-block"
                      onClick={() => void startToday()}
                    >
                      {t('plans.startToday')}
                    </button>
                  </div>
                  <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                    {t('plans.planExerciseHint')}
                  </p>
                </>
              ) : (
                <>
                  <div className="small muted" style={{ marginTop: 'var(--space-2)' }}>
                    {todayDay?.rest ? t('plans.restToday') : t('plans.noPlanToday')}
                  </div>
                  <p className="small faint" style={{ margin: 'var(--space-1) 0 0' }}>
                    {todayDay?.rest ? t('plans.restTodayHint') : t('plans.aiBody')}
                  </p>
                </>
              )}
            </div>
          ) : null}

          {plans === null ? (
            <p className="small faint">{t('common.loading')}</p>
          ) : plans.length === 0 ? (
            <EmptyState title={t('plans.emptyTitle')} hint={t('plans.emptyHint')} />
          ) : (
            <div className="stack">
              {plans.map((plan) => (
                <article className="card" key={plan.id}>
                  <div className="row-between">
                    <div style={{ minWidth: 0 }}>
                      <div className="label-strong break">{plan.name || t('common.unknown')}</div>
                      <div className="small muted">
                        {t('plans.trainingDays', { count: planTrainingDays(plan) })} ·{' '}
                        {t('plans.weeklySets', { count: planWeeklySets(plan) })}
                        {plan.source === 'ai' ? ' · ✨' : ''}
                      </div>
                    </div>
                    {plan.active ? (
                      <span className="badge live">{t('plans.active')}</span>
                    ) : (
                      <button type="button" className="btn btn-sm" onClick={() => void activate(plan)}>
                        {t('plans.activate')}
                      </button>
                    )}
                  </div>

                  <div className="week-strip">
                    {plan.days.map((day) => (
                      <span
                        key={day.id}
                        className="week-cell"
                        data-state={day.rest || day.exercises.length === 0 ? 'rest' : 'train'}
                        title={day.title || weekdays[day.weekday]}
                      >
                        {weekdays[day.weekday]}
                      </span>
                    ))}
                  </div>

                  <div className="row" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-2)' }}>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(plan)}>
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setConfirmDelete(plan)}
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="page-actions">
            <button type="button" className="btn btn-block" onClick={() => setDrafting(true)}>
              ✨ {t('plans.aiGenerate')}
            </button>
          </div>
        </div>
      </main>

      {drafting ? (
        <Sheet
          title={t('plans.aiTitle')}
          onClose={() => setDrafting(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDrafting(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void draft()}
              >
                {busy ? t('plans.aiThinking') : t('plans.aiGenerate')}
              </button>
            </>
          }
        >
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>
              {t('plans.aiBody')}
            </p>
            <Field label={t('plans.aiPrompt')} htmlFor="plan-prompt">
              <textarea
                id="plan-prompt"
                className="textarea"
                placeholder={t('plans.aiPromptPlaceholder')}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </Field>
          </div>
        </Sheet>
      ) : null}

      {proposal ? (
        <Sheet
          title={t('plans.aiTitle')}
          onClose={() => setProposal(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setProposal(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void acceptProposal()}>
                {t('plans.aiUse')}
              </button>
            </>
          }
        >
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>
              {t('plans.aiPreviewHint')}
            </p>
            <div className="label-strong">{proposal.name || t('plans.newTitle')}</div>
            {proposal.days.map((day) => (
              <div className="card" key={day.weekday}>
                <div className="row-between">
                  <span className="label-strong">{weekdays[day.weekday]}</span>
                  <span className="small faint">{day.rest ? t('plans.restDay') : day.title}</span>
                </div>
                {day.exercises.length > 0 ? (
                  <ul className="small muted list-tight">
                    {day.exercises.map((exercise, index) => (
                      <li key={`${exercise.name}-${index}`}>
                        {exercise.name} — {exercise.sets} × {exercise.reps}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        </Sheet>
      ) : null}

      {editing ? (
        <PlanEditor
          plan={editing}
          weekdays={weekdays}
          onCancel={() => setEditing(null)}
          onSave={(plan) => void save(plan)}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={t('plans.deleteTitle')}
          message={t('plans.deleteBody')}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void remove(confirmDelete)}
        />
      ) : null}
    </>
  );
}

/** "8-10" and "AMRAP" both have to survive; only a leading number becomes reps. */
function parseLeadingNumber(reps: string): number {
  const match = /^\s*(\d+)/.exec(reps);
  return match ? Number(match[1]) : 0;
}

function PlanEditor({
  plan,
  weekdays,
  onCancel,
  onSave,
}: {
  plan: TrainingPlan;
  weekdays: string[];
  onCancel: () => void;
  onSave: (plan: TrainingPlan) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<TrainingPlan>(plan);
  const [dayIndex, setDayIndex] = useState(new Date().getDay());

  const patch = (changes: Partial<TrainingPlan>) => setDraft((current) => ({ ...current, ...changes }));

  const patchDay = (weekday: number, changes: Partial<PlanDay>) =>
    patch({
      days: draft.days.map((day) => (day.weekday === weekday ? { ...day, ...changes } : day)),
    });

  const patchExercise = (weekday: number, id: string, changes: Partial<PlanExercise>) =>
    patch({
      days: draft.days.map((day) =>
        day.weekday === weekday
          ? {
              ...day,
              exercises: day.exercises.map((exercise) =>
                exercise.id === id ? { ...exercise, ...changes } : exercise,
              ),
            }
          : day,
      ),
    });

  const day = draft.days.find((entry) => entry.weekday === dayIndex) ?? createEmptyPlanDay(dayIndex);

  return (
    <Sheet
      title={plan.name === '' ? t('plans.newTitle') : t('plans.editTitle')}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={draft.name.trim() === ''}
            onClick={() => onSave(draft)}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('plans.name')} htmlFor="plan-name">
          <input
            id="plan-name"
            className="input"
            placeholder={t('plans.namePlaceholder')}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>

        <Field label={t('plans.goal')} htmlFor="plan-goal">
          <select
            id="plan-goal"
            className="select"
            value={draft.goal ?? ''}
            onChange={(event) =>
              patch({ goal: (event.target.value || null) as TrainingGoal | null })
            }
          >
            <option value="">{t('common.notSet')}</option>
            {GOALS.map((goal) => (
              <option key={goal} value={goal}>
                {t(`profile.goal${goal.charAt(0).toUpperCase()}${goal.slice(1)}` as never)}
              </option>
            ))}
          </select>
        </Field>

        <div className="field">
          <label>{t('plans.days')}</label>
          <div className="chip-row" style={{ marginBottom: 'var(--space-2)' }}>
            {weekdays.map((name, weekday) => {
              const entry = draft.days.find((item) => item.weekday === weekday);
              const training = entry ? !entry.rest && entry.exercises.length > 0 : false;
              return (
                <button
                  key={name}
                  type="button"
                  className="flag-toggle"
                  data-on={weekday === dayIndex}
                  data-training={training}
                  onClick={() => setDayIndex(weekday)}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="row-between">
            <span className="label-strong">{weekdays[dayIndex]}</span>
            <Segmented
              ariaLabel={t('plans.restDay')}
              value={day.rest ? 'rest' : 'train'}
              options={[
                { value: 'train', label: t('workout.title') },
                { value: 'rest', label: t('plans.restDay') },
              ]}
              onChange={(value) => patchDay(dayIndex, { rest: value === 'rest' })}
            />
          </div>

          {day.rest ? (
            <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
              {t('plans.restDayHint')}
            </p>
          ) : (
            <>
              <Field label={t('plans.dayTitle')} htmlFor="plan-day-title">
                <input
                  id="plan-day-title"
                  className="input"
                  placeholder={t('plans.dayTitlePlaceholder')}
                  value={day.title}
                  onChange={(event) => patchDay(dayIndex, { title: event.target.value })}
                />
              </Field>

              <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
                {day.exercises.map((exercise) => (
                  <div className="plan-row" key={exercise.id}>
                    <input
                      className="input"
                      aria-label={t('plans.exerciseName')}
                      value={exercise.name}
                      onChange={(event) =>
                        patchExercise(dayIndex, exercise.id, { name: event.target.value })
                      }
                    />
                    <NumberField
                      value={exercise.sets}
                      decimals={0}
                      className="input plan-sets"
                      ariaLabel={t('plans.sets')}
                      onChange={(value) =>
                        patchExercise(dayIndex, exercise.id, { sets: Math.max(1, value ?? 1) })
                      }
                    />
                    <input
                      className="input plan-reps"
                      aria-label={t('plans.reps')}
                      value={exercise.reps}
                      onChange={(event) =>
                        patchExercise(dayIndex, exercise.id, { reps: event.target.value })
                      }
                    />
                    <button
                      type="button"
                      className="btn-icon"
                      aria-label={t('plans.removeExercise')}
                      onClick={() =>
                        patchDay(dayIndex, {
                          exercises: day.exercises.filter((entry) => entry.id !== exercise.id),
                        })
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: 'var(--space-3)' }}
                onClick={() =>
                  patchDay(dayIndex, { exercises: [...day.exercises, createEmptyPlanExercise()] })
                }
              >
                + {t('plans.addExercise')}
              </button>
            </>
          )}
        </div>

        <div className="row-between small faint">
          <span>{t('plans.trainingDays', { count: planTrainingDays(draft) })}</span>
          <span>{t('plans.weeklySets', { count: planWeeklySets(draft) })}</span>
        </div>

        <Field label={t('plans.notes')} htmlFor="plan-notes">
          <textarea
            id="plan-notes"
            className="textarea"
            placeholder={t('plans.notesPlaceholder')}
            value={draft.notes}
            onChange={(event) => patch({ notes: event.target.value })}
          />
        </Field>
      </div>
    </Sheet>
  );
}
