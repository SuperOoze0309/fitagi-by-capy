import type { ExerciseEntry, SetEntry } from '../domain/types';
import { formatClock, formatNumber } from '../domain/units';
import { NumberField } from './NumberField';
import { useI18n } from '../state/AppContext';

interface ExerciseCardProps {
  exercise: ExerciseEntry;
  index: number;
  supersetLabel: string | null;
  onRename: (name: string) => void;
  /** Open the rename + alias-rule dialog for this exercise. */
  onRenameWithRule: () => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onToggleSuperset: () => void;
  onAddSet: () => void;
  onCopyLastSet: () => void;
  onDuplicateSet: (setId: string) => void;
  onUpdateSet: (setId: string, patch: Partial<SetEntry>) => void;
  onRemoveSet: (setId: string) => void;
  /** Newly created set id — receives focus so typing can start immediately. */
  focusSetId: string | null;
}

/**
 * One exercise inside the active workout: an inline-editable name plus a compact
 * grid of sets. This is the highest-traffic component in the app, so it stays
 * flat — no nested forms, no modals, one row per set — and the grid is sized by
 * CSS tracks rather than fixed widths, so it fits a 320px phone and a tablet.
 */
export function ExerciseCard({
  exercise,
  index,
  supersetLabel,
  onRename,
  onRenameWithRule,
  onRemove,
  onMove,
  onToggleSuperset,
  onAddSet,
  onCopyLastSet,
  onDuplicateSet,
  onUpdateSet,
  onRemoveSet,
  focusSetId,
}: ExerciseCardProps) {
  const { t } = useI18n();
  const sets = exercise.sets;

  return (
    <section className="exercise-card" aria-label={`${index + 1}. ${exercise.rawName}`}>
      <header className="exercise-head">
        <input
          className="input"
          style={{
            minHeight: '2.125rem',
            fontWeight: 650,
            borderColor: 'transparent',
            background: 'transparent',
          }}
          value={exercise.rawName}
          aria-label={t('workout.exerciseName')}
          onChange={(event) => onRename(event.target.value)}
          onFocus={(event) => event.target.select()}
        />
        <button
          type="button"
          className="btn-icon"
          aria-label={t('workout.renameWithRule')}
          title={t('workout.renameHint')}
          onClick={onRenameWithRule}
        >
          ✎
        </button>
        {supersetLabel ? <span className="badge">{supersetLabel}</span> : null}
        <button
          type="button"
          className="btn-icon"
          aria-label={t('workout.moveUp')}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label={t('workout.moveDown')}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label={t('workout.toggleSuperset')}
          title={t('workout.toggleSuperset')}
          data-on={exercise.supersetGroup !== null}
          style={exercise.supersetGroup !== null ? { color: 'var(--accent)' } : undefined}
          onClick={onToggleSuperset}
        >
          ⇄
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label={t('workout.deleteExercise')}
          onClick={onRemove}
        >
          ✕
        </button>
      </header>

      {sets.length === 0 ? (
        <p className="small muted" style={{ margin: 0, padding: 'var(--space-3)' }}>
          {t('workout.noSets')}
        </p>
      ) : (
        <>
          <div className="set-grid header" aria-hidden="true">
            <span>{t('workout.set')}</span>
            <span>{t('workout.weight')}</span>
            <span>{t('workout.reps')}</span>
            <span>{t('workout.rpe')}</span>
            <span />
          </div>
          {sets.map((set, setIndex) => (
            <div className="set-row" key={set.id}>
              <div className="set-grid">
                <span className="set-index">
                  {set.isWarmup ? t('workout.warmupShort') : setIndex + 1}
                </span>
                <NumberField
                  value={set.weight}
                  ariaLabel={`${t('workout.weight')} ${setIndex + 1}`}
                  placeholder={set.unit}
                  className="input-cell weight"
                  autoFocus={set.id === focusSetId}
                  onChange={(value) => onUpdateSet(set.id, { weight: value })}
                />
                <NumberField
                  value={set.reps}
                  decimals={0}
                  ariaLabel={`${t('workout.reps')} ${setIndex + 1}`}
                  placeholder={t('workout.reps')}
                  onChange={(value) => onUpdateSet(set.id, { reps: value })}
                />
                <NumberField
                  value={set.rpe}
                  decimals={1}
                  ariaLabel={`${t('workout.rpe')} ${setIndex + 1}`}
                  placeholder="—"
                  onChange={(value) => onUpdateSet(set.id, { rpe: value })}
                />
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={t('workout.copySet')}
                  onClick={() => onDuplicateSet(set.id)}
                  title={t('workout.copySet')}
                >
                  ⧉
                </button>
              </div>
              <div className="set-grid extra">
                <span />
                <NumberField
                  value={set.restSec}
                  decimals={0}
                  ariaLabel={`${t('workout.rest')} ${setIndex + 1}`}
                  placeholder={t('workout.rest')}
                  onChange={(value) => onUpdateSet(set.id, { restSec: value })}
                />
                <NumberField
                  value={set.rir}
                  decimals={0}
                  ariaLabel={`${t('workout.rir')} ${setIndex + 1}`}
                  placeholder={t('workout.rir')}
                  onChange={(value) => onUpdateSet(set.id, { rir: value })}
                />
              </div>
              <div className="set-flags">
                <button
                  type="button"
                  className="flag-toggle"
                  data-on={set.isFailure}
                  onClick={() => onUpdateSet(set.id, { isFailure: !set.isFailure })}
                >
                  {t('workout.failure')}
                </button>
                <button
                  type="button"
                  className="flag-toggle"
                  data-on={set.isWarmup}
                  onClick={() => onUpdateSet(set.id, { isWarmup: !set.isWarmup })}
                >
                  {t('workout.warmup')}
                </button>
                <button
                  type="button"
                  className="flag-toggle"
                  data-on={set.isDropSet}
                  onClick={() => onUpdateSet(set.id, { isDropSet: !set.isDropSet })}
                >
                  {t('workout.drop')}
                </button>
                {set.restSec !== null && set.restSec > 0 ? (
                  <span className="flag-toggle" style={{ borderStyle: 'dashed' }}>
                    {t('workout.restLabel', { time: formatClock(set.restSec) })}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="flag-toggle"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => onRemoveSet(set.id)}
                >
                  {t('common.delete')}
                </button>
              </div>
              {set.weight !== null && set.reps !== null ? (
                <div className="small faint" style={{ padding: '0 var(--space-3) var(--space-2)' }}>
                  {formatNumber(set.weight)} {set.unit} × {set.reps}
                </div>
              ) : null}
            </div>
          ))}
        </>
      )}

      <footer className="exercise-foot">
        <button type="button" className="btn btn-sm" onClick={onAddSet}>
          {t('workout.addSet')}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCopyLastSet}>
          {t('workout.copyLast')}
        </button>
      </footer>
    </section>
  );
}
