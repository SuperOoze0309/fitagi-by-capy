import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { NumberField } from '../components/NumberField';
import { createWorkout } from '../domain/workout';
import { nowIso } from '../domain/datetime';
import { secondsBetween } from '../domain/metrics';
import type { Workout } from '../domain/types';
import { repositories } from '../repositories';
import { aiService } from '../services/ai';
import {
  describePreview,
  draftToPreview,
  materializeDraft,
  previewToDraft,
  type EditablePreviewExercise,
} from '../services/ai/materialize';
import { newId } from '../domain/ids';
import { SummaryService } from '../services/summaries/summaryService';
import { useApp, useI18n } from '../state/AppContext';
import { useOutlierReview } from '../state/useOutlierReview';
import { useToast } from '../state/ToastContext';

/**
 * Starter phrasings.
 *
 * These are deliberately not translated: they are inputs to the parser, and the
 * point of the row is to show that any spelling in any language is accepted. The
 * offline parser understands exactly these shapes.
 */
const EXAMPLES = [
  '卧推 60kg 8次 4组 最后一组力竭',
  'bench 80 8 8 7 6 rir2',
  '倒蹬577lb 8次4组',
  '深蹲 100kg 5x5',
];

type Stage = 'input' | 'preview';

/**
 * Quick Log: type a workout the way you would write it in a note.
 *
 * The parse result is always a **preview**: nothing reaches storage until the user
 * confirms. With AI off the offline parser does the work, and if it finds nothing
 * the text is kept as a workout note rather than being discarded.
 */
export function QuickLogPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useI18n();
  const { settings } = useApp();
  const ai = useMemo(() => aiService(settings), [settings]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const [stage, setStage] = useState<Stage>('input');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState<EditablePreviewExercise[]>([]);
  const [parseSource, setParseSource] = useState<'local' | 'llm'>('local');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [unparsed, setUnparsed] = useState('');
  const [target, setTarget] = useState<'new' | 'current'>('new');
  const [inProgress, setInProgress] = useState<Workout | null>(null);
  const [counts, setCounts] = useState<{ exercises: number; sets: number } | null>(null);
  const review = useOutlierReview();

  const parse = useCallback(async () => {
    if (text.trim() === '' || busy) return;
    setBusy(true);
    try {
      const draft = await ai.parseWorkout(text, settings.defaultUnit);
      const suggestions = await ai.suggestNormalization(
        draft.exercises.map((exercise) => exercise.rawName),
      );
      setPreview(draftToPreview(draft, suggestions, newId));
      setNotes(draft.notes);
      setWarnings(draft.warnings);
      setUnparsed(draft.unparsed);
      setParseSource(draft.source);
      // Offer to append when a session is already open.
      const open = await repositories().training.inProgress();
      setInProgress(open);
      setTarget(open ? 'current' : 'new');
      setStage('preview');
    } catch (error) {
      toast.show(error instanceof Error ? error.message : t('quickLog.parseFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }, [ai, busy, settings.defaultUnit, t, text, toast]);

  const save = useCallback(
    async (reviewedWorkout?: Workout) => {
      // The review sheet resumes the save by calling back in with the reviewed
      // workout. That is the same logical save, so the in-flight guard must not
      // reject it — otherwise answering the sheet would strand the user on it.
      const isResume = reviewedWorkout !== undefined;
      if (busy && !isResume) return;
      const route = window.location.hash;
      setBusy(true);
      try {
        const appendToCurrent = target === 'current' && inProgress !== null;
        let finished: Workout;
        let savedCounts = counts;

        if (reviewedWorkout) {
          finished = reviewedWorkout;
        } else {
          const draft = previewToDraft(preview, notes, parseSource);
          const base = appendToCurrent ? (inProgress as Workout) : createWorkout();
          const result = await materializeDraft(draft, base, repositories());
          const endTime = nowIso();
          finished = appendToCurrent
            ? result.workout
            : {
                ...result.workout,
                endTime,
                durationSec: secondsBetween(result.workout.startTime, endTime),
                completed: true,
              };
          savedCounts = { exercises: result.exerciseCount, sets: result.setCount };
          setCounts(savedCounts);
        }

        // Quick Log is where a typo like "600kg" is most likely to be typed, so it
        // runs the same outlier check the recorder does. It never blocks saving.
        if (!isResume) {
          const clearToSave = await review.guard(finished, (candidate) => save(candidate));
          if (!clearToSave) return;
        }

        const saved = await repositories().training.put(finished);
        try {
          await new SummaryService(repositories()).refreshForWorkout(saved, settings.defaultUnit);
        } catch (error) {
          console.warn('[summary] generation failed', error);
        }
        // Summary generation may outlive this screen or a navigation already started.
        if (!mounted.current || window.location.hash !== route) return;
        const exerciseCount = savedCounts?.exercises ?? finished.exercises.length;
        const setCount =
          savedCounts?.sets ?? finished.exercises.reduce((sum, e) => sum + e.sets.length, 0);
        toast.show(
          t('quickLog.savedToast', { exercises: exerciseCount, sets: setCount }),
          'success',
        );
        navigate(appendToCurrent ? `/workout/${saved.id}` : `/history/${saved.id}`, {
          replace: true,
        });
      } catch (error) {
        toast.show(error instanceof Error ? error.message : t('quickLog.saveFailed'), 'error');
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      counts,
      inProgress,
      navigate,
      notes,
      parseSource,
      preview,
      review,
      settings.defaultUnit,
      t,
      target,
      toast,
    ],
  );

  const saveAsNoteOnly = useCallback(async () => {
    if (busy) return;
    const route = window.location.hash;
    setBusy(true);
    try {
      const base = createWorkout();
      const endTime = nowIso();
      const workout = await repositories().training.put({
        ...base,
        notes: text.trim(),
        endTime,
        durationSec: secondsBetween(base.startTime, endTime),
        completed: true,
      });
      try {
        await new SummaryService(repositories()).refreshForWorkout(workout, settings.defaultUnit);
      } catch (error) {
        console.warn('[summary] generation failed', error);
      }
      if (!mounted.current || window.location.hash !== route) return;
      toast.show(t('quickLog.savedAsNote'), 'success');
      navigate(`/history/${workout.id}`, { replace: true });
    } finally {
      setBusy(false);
    }
  }, [busy, navigate, settings.defaultUnit, t, text, toast]);

  const keptSummary = describePreview(preview);

  return (
    <>
      <PageHeader
        title={t('quickLog.title')}
        subtitle={
          ai.isEnabled()
            ? t('quickLog.aiOn', { target: ai.describeTarget() })
            : t('quickLog.offlineParser')
        }
        action={
          stage === 'preview' ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStage('input')}>
              {t('quickLog.editText')}
            </button>
          ) : undefined
        }
      />

      <main className="app-main">
        <div className="page">
          {stage === 'input' ? (
            <>
              <div className="card">
                <label htmlFor="quick-input" className="label-strong">
                  {t('quickLog.describe')}
                </label>
                <textarea
                  id="quick-input"
                  className="textarea"
                  style={{ marginTop: 'var(--space-2)' }}
                  placeholder={t('quickLog.placeholder')}
                  value={text}
                  autoFocus
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void parse();
                  }}
                />
                <div className="chip-row" style={{ marginTop: 'var(--space-2)' }}>
                  {EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      className="flag-toggle"
                      onClick={() => setText(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>

              <div className="page-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-block btn-hero"
                  disabled={busy || text.trim() === ''}
                  onClick={() => void parse()}
                >
                  {busy ? t('quickLog.parsing') : t('quickLog.parse')}
                </button>
              </div>

              <div className="page-actions">
                <button
                  type="button"
                  className="btn btn-block"
                  disabled={busy || text.trim() === ''}
                  onClick={() => void saveAsNoteOnly()}
                >
                  {t('quickLog.saveAsNote')}
                </button>
              </div>

              <div className="banner" style={{ marginTop: 'var(--space-3)' }}>
                {ai.isEnabled()
                  ? t('quickLog.aiBanner', { target: ai.describeTarget() })
                  : t('quickLog.offlineBanner', {
                      example1: '60kg 8次 4组',
                      example2: 'bench 80 8 8 7 6',
                      example3: '5x5',
                    })}
              </div>
            </>
          ) : (
            <>
              <div className="card">
                <div className="row-between">
                  <div>
                    <div className="label-strong">{t('quickLog.checkBeforeSaving')}</div>
                    <div className="small muted">
                      {t('quickLog.parsedBy', {
                        summary: keptSummary,
                        source:
                          parseSource === 'llm'
                            ? t('quickLog.sourceModel')
                            : t('quickLog.sourceOffline'),
                      })}
                    </div>
                  </div>
                  <span className={`badge ${parseSource === 'llm' ? '' : 'neutral'}`}>
                    {parseSource === 'llm' ? t('quickLog.badgeAi') : t('quickLog.badgeLocal')}
                  </span>
                </div>
                {warnings.length > 0 ? (
                  <div className="banner warn" style={{ marginTop: 'var(--space-3)' }}>
                    <div>
                      {warnings.map((warning) => (
                        <div key={warning}>{warning}</div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              {preview.map((exercise) => (
                <PreviewExerciseCard
                  key={exercise.id}
                  exercise={exercise}
                  onChange={(next) =>
                    setPreview((current) =>
                      current.map((item) => (item.id === exercise.id ? next : item)),
                    )
                  }
                  onRemove={() =>
                    setPreview((current) => current.filter((item) => item.id !== exercise.id))
                  }
                />
              ))}

              {preview.length === 0 ? (
                <div className="empty">
                  <strong>{t('quickLog.nothingParsed')}</strong>
                  <span className="small">{t('quickLog.nothingParsedHint')}</span>
                </div>
              ) : null}

              <div className="card">
                <label htmlFor="preview-notes" className="label-strong">
                  {t('quickLog.notesLabel')}
                </label>
                <textarea
                  id="preview-notes"
                  className="textarea"
                  style={{ marginTop: 'var(--space-2)' }}
                  placeholder={t('quickLog.notesPlaceholder')}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
                {unparsed ? (
                  <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                    {t('quickLog.keptAsNotes', { text: unparsed })}
                  </p>
                ) : null}
              </div>

              <div className="card">
                <div className="label-strong" style={{ marginBottom: 'var(--space-2)' }}>
                  {t('quickLog.saveTo')}
                </div>
                <div className="stack">
                  <button
                    type="button"
                    className={target === 'new' ? 'btn btn-primary' : 'btn'}
                    onClick={() => setTarget('new')}
                  >
                    {t('quickLog.newWorkout')}
                  </button>
                  <button
                    type="button"
                    className={target === 'current' ? 'btn btn-primary' : 'btn'}
                    disabled={!inProgress}
                    onClick={() => setTarget('current')}
                  >
                    {inProgress
                      ? t('quickLog.currentWorkout', { count: inProgress.exercises.length })
                      : t('quickLog.noCurrentWorkout')}
                  </button>
                </div>
              </div>

              <div className="page-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-block btn-hero"
                  disabled={busy || preview.length === 0}
                  onClick={() => void save()}
                >
                  {busy
                    ? t('workout.saving')
                    : t('quickLog.confirmAndSave', { summary: keptSummary })}
                </button>
              </div>
              <div className="page-actions">
                <button
                  type="button"
                  className="btn btn-block"
                  disabled={busy}
                  onClick={() => void saveAsNoteOnly()}
                >
                  {t('quickLog.discardAndSaveNote')}
                </button>
              </div>

              <p className="small faint" style={{ marginTop: 'var(--space-4)' }}>
                {t('quickLog.nothingWritten')}
              </p>
            </>
          )}
        </div>
      </main>

      {review.element}
    </>
  );
}

function PreviewExerciseCard({
  exercise,
  onChange,
  onRemove,
}: {
  exercise: EditablePreviewExercise;
  onChange: (next: EditablePreviewExercise) => void;
  onRemove: () => void;
}) {
  const { t, tPlural } = useI18n();
  const setCount = exercise.sets.filter((set) => set.include).length;

  const updateSet = (setId: string, patch: Partial<EditablePreviewExercise['sets'][number]>) => {
    onChange({
      ...exercise,
      sets: exercise.sets.map((set) => (set.id === setId ? { ...set, ...patch } : set)),
    });
  };

  return (
    <section className="exercise-card" style={{ marginTop: 'var(--space-3)' }}>
      <header className="exercise-head">
        <input
          className="input input-bare"
          value={exercise.rawName}
          aria-label={t('quickLog.parsedExerciseName')}
          onChange={(event) => onChange({ ...exercise, rawName: event.target.value })}
        />
        <span className="badge neutral">
          {tPlural('exercise.setsCount', 'exercise.oneSet', setCount)}
        </span>
        <button
          type="button"
          className="btn-icon"
          aria-label={t('quickLog.removeExercise')}
          title={t('quickLog.removeExercise')}
          onClick={onRemove}
        >
          ✕
        </button>
      </header>

      {exercise.suggestion && exercise.suggestion.suggested !== exercise.rawName ? (
        <div className="banner" style={{ margin: 'var(--space-3)' }}>
          <div className="row-between" style={{ gap: 'var(--space-2)' }}>
            <div className="small">
              {exercise.suggestion.fromUserRule ? t('quickLog.yourRule') : t('quickLog.suggestion')}
              {': '}
              {t('quickLog.logAs', { name: exercise.suggestion.suggested })}
              {/*
                The reason is produced by the model (or the alias-rule engine), so it
                arrives in the language the model answered in and is shown verbatim.
              */}
              <span className="faint"> · {exercise.suggestion.reason}</span>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                onChange({
                  ...exercise,
                  normalizedName: exercise.suggestion!.suggested,
                  rawName: exercise.suggestion!.suggested,
                })
              }
            >
              {t('quickLog.useSuggestion')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="set-grid header" aria-hidden="true">
        <span>{t('workout.set')}</span>
        <span>{t('workout.weight')}</span>
        <span>{t('workout.reps')}</span>
        <span>{t('workout.rpe')}</span>
        <span />
      </div>

      {exercise.sets.map((set, index) => (
        <div className="set-row" key={set.id}>
          <div className="set-grid">
            <span className="set-index">{set.isWarmup ? t('workout.warmupShort') : index + 1}</span>
            <NumberField
              value={set.weight}
              ariaLabel={t('quickLog.setWeightLabel', { index: index + 1 })}
              placeholder={set.unit}
              className="input-cell weight"
              onChange={(value) => updateSet(set.id, { weight: value })}
            />
            <NumberField
              value={set.reps}
              decimals={0}
              ariaLabel={t('quickLog.setRepsLabel', { index: index + 1 })}
              placeholder={t('quickLog.repsPlaceholder')}
              onChange={(value) => updateSet(set.id, { reps: value })}
            />
            <NumberField
              value={set.rpe}
              decimals={1}
              ariaLabel={t('quickLog.setRpeLabel', { index: index + 1 })}
              placeholder="—"
              onChange={(value) => updateSet(set.id, { rpe: value })}
            />
            <button
              type="button"
              className="btn-icon"
              aria-label={t('quickLog.excludeSetLabel', { index: index + 1 })}
              title={set.include ? t('quickLog.excludeSet') : t('quickLog.includeSet')}
              style={set.include ? undefined : { opacity: 0.4 }}
              onClick={() => updateSet(set.id, { include: !set.include })}
            >
              {set.include ? '✓' : '○'}
            </button>
          </div>
          <div className="set-flags">
            <label className="row small">
              {t('workout.rir')}
              <NumberField
                value={set.rir}
                decimals={0}
                ariaLabel={t('quickLog.setRirLabel', { index: index + 1 })}
                placeholder="—"
                onChange={(value) => updateSet(set.id, { rir: value === null ? null : Math.max(0, value) })}
              />
            </label>
            <button
              type="button"
              className="flag-toggle"
              data-on={set.isFailure}
              onClick={() => updateSet(set.id, { isFailure: !set.isFailure })}
            >
              {t('workout.failure')}
            </button>
            <button
              type="button"
              className="flag-toggle"
              data-on={set.isWarmup}
              onClick={() => updateSet(set.id, { isWarmup: !set.isWarmup })}
            >
              {t('workout.warmup')}
            </button>
            <button
              type="button"
              className="flag-toggle"
              data-on={set.isDropSet}
              onClick={() => updateSet(set.id, { isDropSet: !set.isDropSet })}
            >
              {t('workout.drop')}
            </button>
            <span className="flag-toggle" style={{ borderStyle: 'dashed' }}>
              {set.unit}
            </span>
          </div>
        </div>
      ))}
    </section>
  );
}
