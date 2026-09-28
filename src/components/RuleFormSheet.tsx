import { useEffect, useState } from 'react';
import { repositories } from '../repositories';
import type { AliasRule } from '../domain/types';
import { useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';

interface RuleFormSheetProps {
  /** Pre-filled "matches" value, e.g. the raw name the user typed. */
  presetMatch?: string;
  /** Pre-filled canonical name, e.g. what they renamed it to. */
  presetNormalized?: string;
  /** Id when editing an existing rule. */
  editing?: AliasRule | null;
  onSaved?: (rule: AliasRule) => void;
}

/**
 * Create or edit one alias rule.
 *
 * Rules are user-owned: they are always applied before any AI suggestion, and this
 * form never rewrites the history that already exists — it only changes how future
 * entries are named.
 */
export function RuleFormSheet({
  presetMatch = '',
  presetNormalized = '',
  editing = null,
  onSaved,
}: RuleFormSheetProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [match, setMatch] = useState(editing?.match ?? presetMatch);
  const [normalized, setNormalized] = useState(editing?.normalized ?? presetNormalized);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMatch(editing?.match ?? presetMatch);
    setNormalized(editing?.normalized ?? presetNormalized);
  }, [editing, presetMatch, presetNormalized]);

  const canSave = match.trim() !== '' && normalized.trim() !== '' && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const rule = await repositories().rules.save({
        ...(editing ? { id: editing.id } : {}),
        match,
        normalized,
      });
      toast.show(t('rules.savedToast', { match: rule.match, normalized: rule.normalized }), 'success');
      onSaved?.(rule);
      if (!editing) setMatch('');
      if (!editing) setNormalized('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="rule-match">{t('rules.matchLabel')}</label>
        <input
          id="rule-match"
          className="input"
          placeholder={t('rules.matchPlaceholder')}
          value={match}
          onChange={(event) => setMatch(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="rule-normalized">{t('rules.normalizedLabel')}</label>
        <input
          id="rule-normalized"
          className="input"
          placeholder={t('rules.normalizedPlaceholder')}
          value={normalized}
          onChange={(event) => setNormalized(event.target.value)}
        />
      </div>
      <p className="small faint" style={{ margin: 0 }}>
        {t('rules.explanation')}
      </p>
      <button type="button" className="btn btn-primary btn-block" disabled={!canSave} onClick={() => void save()}>
        {editing ? t('rules.save') : t('rules.add')}
      </button>
    </div>
  );
}

/** Full list of rules with edit and delete, used by the Rules page. */
export function RuleList({ onChange }: { onChange?: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [rules, setRules] = useState<AliasRule[] | null>(null);
  const [editing, setEditing] = useState<AliasRule | null>(null);

  const load = async () => {
    setRules(await repositories().rules.all());
    onChange?.();
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (rule: AliasRule) => {
    await repositories().rules.remove(rule.id);
    toast.show(t('rules.removed', { match: rule.match }));
    await load();
  };

  return (
    <div className="stack">
      {editing ? (
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            {t('rules.editing', { match: editing.match })}
          </div>
          <RuleFormSheet
            editing={editing}
            onSaved={() => {
              setEditing(null);
              void load();
            }}
          />
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-block" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('rules.newRule')}</div>
        <RuleFormSheet onSaved={() => void load()} />
      </div>

      <div className="section-title">
        <span>{t('rules.savedRules')}</span>
        <span className="faint">{rules ? rules.length : '…'}</span>
      </div>

      {rules === null ? (
        <div className="small faint">{t('common.loading')}</div>
      ) : rules.length === 0 ? (
        <div className="empty">
          <strong>{t('rules.emptyTitle')}</strong>
          <span className="small">{t('rules.emptyHint')}</span>
        </div>
      ) : (
        <div className="card" style={{ padding: '4px 12px' }}>
          <div className="list">
            {rules.map((rule) => (
              <div className="list-item" key={rule.id}>
                <span className="li-main">
                  <span className="li-title break">{rule.match}</span>
                  <span className="li-sub break">→ {rule.normalized}</span>
                </span>
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={t('rules.editLabel', { match: rule.match })}
                  onClick={() => setEditing(rule)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={t('rules.deleteLabel', { match: rule.match })}
                  onClick={() => void remove(rule)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
