import { useEffect, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import type { ExerciseSuggestion } from '../repositories/exerciseRepository';
import { formatRelative } from '../domain/datetime';
import { quickExerciseNames } from '../i18n/presets';
import { useI18n } from '../state/AppContext';

interface AddExerciseSheetProps {
  suggestions: ExerciseSuggestion[];
  /** Names already in the current workout, shown as an "already added" hint. */
  alreadyAdded: string[];
  onAdd: (name: string) => void;
  onClose: () => void;
}

/**
 * Exercise picker. There is no bundled exercise library on purpose: the user can
 * type anything, and previously used names surface as they type.
 */
export function AddExerciseSheet({
  suggestions,
  alreadyAdded,
  onAdd,
  onClose,
}: AddExerciseSheetProps) {
  const { t, locale } = useI18n();
  // Offered before the user has any history, so the first session is not blank.
  const quickNames = useMemo(() => quickExerciseNames(locale), [locale]);
  const [query, setQuery] = useState('');
  const [input, setInput] = useState<HTMLInputElement | null>(null);

  useEffect(() => {
    input?.focus();
  }, [input]);

  const addedKeys = useMemo(
    () => new Set(alreadyAdded.map((name) => name.trim().toLowerCase())),
    [alreadyAdded],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return suggestions.slice(0, 12);
    return suggestions.filter((item) => item.name.toLowerCase().includes(needle)).slice(0, 20);
  }, [query, suggestions]);

  const trimmed = query.trim();
  const canCreate =
    trimmed !== '' && !filtered.some((item) => item.name.toLowerCase() === trimmed.toLowerCase());

  return (
    <Sheet title={t('addExercise.title')} onClose={onClose}>
      <div className="stack">
        <input
          ref={setInput}
          className="input"
          placeholder={t('addExercise.placeholder')}
          aria-label={t('workout.exerciseName')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && trimmed !== '') onAdd(trimmed);
          }}
        />

        {canCreate ? (
          <button type="button" className="btn btn-primary btn-block" onClick={() => onAdd(trimmed)}>
            {t('addExercise.add', { name: trimmed })}
          </button>
        ) : null}

        {trimmed === '' && suggestions.length === 0 ? (
          <div>
            <div className="section-title">{t('addExercise.common')}</div>
            <div className="row-wrap">
              {quickNames.map((name) => (
                <button key={name} type="button" className="flag-toggle" onClick={() => onAdd(name)}>
                  {name}
                </button>
              ))}
            </div>
            <p className="small faint" style={{ marginTop: 'var(--space-3)' }}>
              {t('addExercise.hint')}
            </p>
          </div>
        ) : null}

        {filtered.length > 0 ? (
          <div>
            <div className="section-title">{t('addExercise.recent')}</div>
            <div className="list">
              {filtered.map((item) => (
                <button
                  key={item.name}
                  type="button"
                  className="list-item"
                  onClick={() => onAdd(item.name)}
                >
                  <span className="li-main">
                    <span className="li-title">{item.name}</span>
                    <span className="li-sub">
                      {item.useCount === 1
                        ? t('addExercise.oneSession')
                        : t('addExercise.sessions', { count: item.useCount })}{' '}
                      · {formatRelative(item.lastUsed.toISOString())}
                    </span>
                  </span>
                  {addedKeys.has(item.name.trim().toLowerCase()) ? (
                    <span className="badge neutral">{t('addExercise.added')}</span>
                  ) : (
                    <span className="chevron">+</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
