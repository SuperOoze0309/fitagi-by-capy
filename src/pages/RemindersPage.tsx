import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog, Sheet } from '../components/Sheet';
import { EmptyState, Field, PageHeader, Switch } from '../components/ui';
import { formatTimeOfDay, weekdayNames } from '../domain/datetime';
import type { Reminder, ReminderKind } from '../domain/types';
import { createEmptyReminder } from '../repositories/planRepository';
import { repositories } from '../repositories';
import { aiService, usualTrainingTimes } from '../services/ai';
import type { ReminderProposal } from '../services/ai';
import {
  notificationPermissionState,
  requestNotificationPermission,
  type PermissionState,
} from '../services/reminders';
import { reminderScheduler } from '../services/reminderScheduler';
import { useApp, useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';

const KINDS: ReminderKind[] = ['workout', 'meal', 'water', 'weighIn', 'rest', 'custom'];

/**
 * Reminders.
 *
 * The list is the source of truth and the operating system holds a copy of the
 * schedule, so every change here goes through the scheduler: saving schedules,
 * deleting cancels, and the page resyncs on mount because a reboot, a restore or a
 * freshly granted permission all leave the two out of step.
 */
export function RemindersPage() {
  const { t, intlTag } = useI18n();
  const { settings, profile } = useApp();
  const toast = useToast();
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Reminder | null>(null);
  const [permission, setPermission] = useState<PermissionState>('unsupported');
  const [suggestions, setSuggestions] = useState<ReminderProposal[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setReminders(await repositories().reminders.all());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the OS schedule in step with the list, and learn the permission state while
  // we are at it: this is the one place that can do both without a user gesture.
  useEffect(() => {
    void (async () => {
      setPermission(await notificationPermissionState());
      await reminderScheduler().sync();
    })();
  }, []);

  const weekdays = useMemo(() => weekdayNames(intlTag), [intlTag]);

  const save = useCallback(
    async (reminder: Reminder) => {
      const saved = await repositories().reminders.save(reminder);
      const scheduled = await reminderScheduler().schedule(saved);
      setEditing(null);
      await load();
      toast.show(t('reminders.saved'), 'success');
      // The save succeeded but the OS refused to schedule it, which the user has to
      // know about: a reminder that silently never fires is worse than none.
      if (scheduled.notificationId === null && permission === 'granted') {
        toast.show(t('reminders.nothingScheduled'), 'error');
      }
    },
    [load, permission, t, toast],
  );

  const remove = useCallback(
    async (reminder: Reminder) => {
      setConfirmDelete(null);
      await reminderScheduler().cancel(reminder);
      await repositories().reminders.remove(reminder.id);
      await load();
      toast.show(t('reminders.deleted'));
    },
    [load, t, toast],
  );

  const toggle = useCallback(
    async (reminder: Reminder) => {
      const next = { ...reminder, enabled: !reminder.enabled };
      if (next.enabled) await reminderScheduler().schedule(next);
      else await reminderScheduler().cancel(reminder);
      await repositories().reminders.save(next);
      await load();
    },
    [load],
  );

  const askPermission = useCallback(async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'granted') {
      const outcome = await reminderScheduler().sync();
      await load();
      toast.show(t('reminders.scheduled', { count: outcome.scheduled }), 'success');
    }
  }, [load, t, toast]);

  const suggest = useCallback(async () => {
    setBusy(true);
    try {
      const ai = aiService(settings);
      if (!ai.isEnabled()) {
        toast.show(t('reminders.aiNeedsAi'));
        return;
      }
      const workouts = await repositories().training.completed();
      const proposals = await ai.proposeReminders({
        profile,
        usualTrainingTimes: usualTrainingTimes(workouts.map((workout) => workout.startTime)),
        activeWeekdays: [
          ...new Set(workouts.map((workout) => new Date(workout.startTime).getDay())),
        ],
        totalWorkouts: workouts.length,
      });
      if (proposals.length === 0) {
        toast.show(t('reminders.aiEmpty'));
        return;
      }
      setSuggestions(proposals);
      setChosen(new Set(proposals.map((_, index) => index)));
    } catch (error) {
      toast.show(error instanceof Error ? error.message : t('reminders.aiFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }, [profile, settings, t, toast]);

  const acceptSuggestions = useCallback(async () => {
    const picked = (suggestions ?? []).filter((_, index) => chosen.has(index));
    for (const proposal of picked) {
      const created = await repositories().reminders.save(
        createEmptyReminder({ ...proposal, source: 'ai' }),
      );
      await reminderScheduler().schedule(created);
    }
    setSuggestions(null);
    await load();
    toast.show(t('reminders.aiAdded', { count: picked.length }), 'success');
  }, [chosen, load, suggestions, t, toast]);

  const describeDays = (reminder: Reminder): string => {
    if (reminder.weekdays.length === 0) return t('reminders.everyDay');
    return reminder.weekdays.map((day) => weekdays[day]).join(' ');
  };

  return (
    <>
      <PageHeader
        title={t('reminders.title')}
        subtitle={
          reminders
            ? reminders.length === 1
              ? t('reminders.oneScheduled')
              : t('reminders.subtitle', { count: reminders.length })
            : t('common.loading')
        }
        action={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setEditing(createEmptyReminder())}
          >
            + {t('reminders.add')}
          </button>
        }
      />

      <main className="app-main">
        <div className="page">
          {permission !== 'granted' && permission !== 'unsupported' ? (
            <div className="card banner warn">
              <div className="label-strong">{t('reminders.permissionTitle')}</div>
              <p className="small muted" style={{ margin: 'var(--space-1) 0 var(--space-2)' }}>
                {t('reminders.permissionBody')}
              </p>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void askPermission()}>
                {t('reminders.permissionAction')}
              </button>
            </div>
          ) : null}

          {reminders === null ? (
            <p className="small faint">{t('common.loading')}</p>
          ) : reminders.length === 0 ? (
            <EmptyState title={t('reminders.emptyTitle')} hint={t('reminders.emptyHint')} />
          ) : (
            <div className="stack">
              {reminders.map((reminder) => (
                <article className="card" key={reminder.id}>
                  <div className="row-between">
                    <div className="row" style={{ minWidth: 0, gap: 'var(--space-2)' }}>
                      <span className="reminder-time mono">{formatTimeOfDay(reminder.time, intlTag)}</span>
                      <div style={{ minWidth: 0 }}>
                        <div className="label-strong break">
                          {reminder.title || t('common.unknown')}
                        </div>
                        <div className="small muted break">
                          {t(`reminders.kind${capitalize(reminder.kind)}` as never)} ·{' '}
                          {describeDays(reminder)}
                        </div>
                      </div>
                    </div>
                    <Switch
                      label={reminder.title || t('reminders.title')}
                      checked={reminder.enabled}
                      onChange={() => void toggle(reminder)}
                    />
                  </div>
                  {reminder.body ? (
                    <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                      {reminder.body}
                    </p>
                  ) : null}
                  <div className="row" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-2)' }}>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(reminder)}>
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setConfirmDelete(reminder)}
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="page-actions">
            <button
              type="button"
              className="btn btn-block"
              disabled={busy}
              onClick={() => void suggest()}
            >
              {busy ? t('reminders.aiThinking') : `✨ ${t('reminders.aiSuggest')}`}
            </button>
          </div>
          <p className="small faint">{t('reminders.aiBody')}</p>
        </div>
      </main>

      {editing ? (
        <ReminderEditor
          reminder={editing}
          weekdays={weekdays}
          onCancel={() => setEditing(null)}
          onSave={(reminder) => void save(reminder)}
        />
      ) : null}

      {suggestions ? (
        <Sheet
          title={t('reminders.aiTitle')}
          onClose={() => setSuggestions(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setSuggestions(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={chosen.size === 0}
                onClick={() => void acceptSuggestions()}
              >
                {t('reminders.aiAccept', { count: chosen.size })}
              </button>
            </>
          }
        >
          <div className="stack">
            {suggestions.map((proposal, index) => (
              <label className="card row" key={`${proposal.time}-${index}`} style={{ gap: 'var(--space-3)' }}>
                <input
                  type="checkbox"
                  checked={chosen.has(index)}
                  onChange={() =>
                    setChosen((current) => {
                      const next = new Set(current);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      return next;
                    })
                  }
                />
                <span className="spread">
                  <span className="row" style={{ gap: 'var(--space-2)' }}>
                    <span className="mono small">{proposal.time}</span>
                    <span className="label-strong">{proposal.title}</span>
                  </span>
                  <span className="small muted break">{proposal.body}</span>
                  <span className="small faint">
                    {proposal.weekdays.length === 0
                      ? t('reminders.everyDay')
                      : proposal.weekdays.map((day) => weekdays[day]).join(' ')}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </Sheet>
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={t('reminders.deleteTitle')}
          message={t('reminders.deleteBody')}
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

function ReminderEditor({
  reminder,
  weekdays,
  onCancel,
  onSave,
}: {
  reminder: Reminder;
  weekdays: string[];
  onCancel: () => void;
  onSave: (reminder: Reminder) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Reminder>(reminder);

  const patch = (changes: Partial<Reminder>) => setDraft((current) => ({ ...current, ...changes }));

  const toggleDay = (day: number) =>
    patch({
      weekdays: draft.weekdays.includes(day)
        ? draft.weekdays.filter((entry) => entry !== day)
        : [...draft.weekdays, day].sort(),
    });

  const preset = (days: number[]) => patch({ weekdays: days });

  return (
    <Sheet
      title={reminder.title === '' ? t('reminders.newTitle') : t('reminders.editTitle')}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={draft.title.trim() === ''}
            onClick={() => onSave(draft)}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('reminders.label')} htmlFor="reminder-title">
          <input
            id="reminder-title"
            className="input"
            placeholder={t('reminders.labelPlaceholder')}
            value={draft.title}
            onChange={(event) => patch({ title: event.target.value })}
          />
        </Field>

        <Field label={t('reminders.body')} htmlFor="reminder-body">
          <input
            id="reminder-body"
            className="input"
            placeholder={t('reminders.bodyPlaceholder')}
            value={draft.body}
            onChange={(event) => patch({ body: event.target.value })}
          />
        </Field>

        <Field label={t('reminders.kind')} htmlFor="reminder-kind">
          <select
            id="reminder-kind"
            className="select"
            value={draft.kind}
            onChange={(event) => patch({ kind: event.target.value as ReminderKind })}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`reminders.kind${capitalize(kind)}` as never)}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('reminders.time')} htmlFor="reminder-time">
          <input
            id="reminder-time"
            className="input"
            type="time"
            value={draft.time}
            onChange={(event) => patch({ time: event.target.value })}
          />
        </Field>

        <div className="field">
          <label>{t('reminders.days')}</label>
          <div className="chip-row" style={{ marginBottom: 'var(--space-2)' }}>
            {weekdays.map((name, day) => (
              <button
                key={name}
                type="button"
                className="flag-toggle"
                data-on={draft.weekdays.includes(day)}
                onClick={() => toggleDay(day)}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="chip-row">
            <button type="button" className="btn btn-sm" onClick={() => preset([])}>
              {t('reminders.everyDay')}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => preset([1, 2, 3, 4, 5])}>
              {t('reminders.weekdaysOnly')}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => preset([0, 6])}>
              {t('reminders.weekends')}
            </button>
          </div>
        </div>

        <div className="row-between">
          <span>{t('reminders.enabled')}</span>
          <Switch
            label={t('reminders.enabled')}
            checked={draft.enabled}
            onChange={(checked) => patch({ enabled: checked })}
          />
        </div>
      </div>
    </Sheet>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
