import { useEffect, useState } from 'react';
import { Field } from './ui';
import { Sheet } from './Sheet';
import { repositories } from '../repositories';
import { useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';

interface RenameExerciseSheetProps {
  /** Current raw name as typed, e.g. "bench". */
  currentName: string;
  onRename: (name: string) => void;
  onClose: () => void;
}

/**
 * Rename an exercise inside a workout, and optionally remember the change as an
 * alias rule.
 *
 * This is where users naturally teach the app their vocabulary: they log "bench",
 * decide it should read "Bench Press", and the rule makes every future "bench" land
 * on the same exercise. Nothing about existing history is rewritten.
 */
export function RenameExerciseSheet({ currentName, onRename, onClose }: RenameExerciseSheetProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState(currentName);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(currentName);
  }, [currentName]);

  const trimmed = name.trim();
  const changed = trimmed !== '' && trimmed !== currentName;

  const apply = async () => {
    if (!changed || busy) return;
    setBusy(true);
    try {
      onRename(trimmed);
      if (remember) {
        await repositories().rules.save({ match: currentName, normalized: trimmed });
        toast.show(t('rename.renamedRule', { from: currentName, to: trimmed }), 'success');
      } else {
        toast.show(t('rename.renamedOnce'));
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={t('rename.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!changed || busy}
            onClick={() => void apply()}
          >
            {t('rename.rename')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('rename.field')} htmlFor="rename-input">
          <input
            id="rename-input"
            className="input"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void apply();
            }}
          />
        </Field>

        <div className="row-between">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{t('rename.remember')}</div>
            <div className="small muted break">
              {t('rename.rememberDetail', { from: currentName, to: trimmed || '…' })}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={remember}
            aria-label={t('rename.remember')}
            className="switch"
            data-on={remember}
            onClick={() => setRemember((value) => !value)}
          />
        </div>

        <div className="banner">{t('rename.banner')}</div>
      </div>
    </Sheet>
  );
}
