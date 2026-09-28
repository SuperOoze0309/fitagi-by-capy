import { useState } from 'react';
import { Sheet } from './Sheet';
import { NumberField } from './NumberField';
import type { AnomalyCheck } from '../services/validation';
import { useI18n } from '../state/AppContext';

interface AnomalyReviewSheetProps {
  findings: AnomalyCheck[];
  /** Called with the user's decisions; the workout is saved either way. */
  onResolve: (result: { corrected: { setId: string; weight: number }[] }) => void;
  /**
   * Called when the user dismisses the sheet. Saving is never blocked, so this is
   * treated as "keep everything as typed".
   */
  onDismiss: () => void;
}

/**
 * Outlier review.
 *
 * The detector flags weights that are far outside an exercise's own history. This
 * sheet exists to make the user *look* at them — it deliberately offers no way to
 * block the save, and it never rewrites a value by itself:
 *
 *   Fix        → the user types the intended number
 *   Keep       → save the flagged value unchanged
 *   Don't ask  → keep the value and stop flagging this set
 *
 * "600 kg" is never silently turned into "60 kg".
 */
export function AnomalyReviewSheet({ findings, onResolve, onDismiss }: AnomalyReviewSheetProps) {
  const { t } = useI18n();
  const [corrections, setCorrections] = useState<Record<string, number | null>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const active = findings.filter((finding) => !dismissed.has(finding.setId));

  const apply = () => {
    const corrected = Object.entries(corrections)
      .filter(([, weight]) => weight !== null && weight !== undefined)
      .map(([setId, weight]) => ({ setId, weight: weight as number }));
    onResolve({ corrected });
  };

  return (
    <Sheet
      title={findings.length === 1 ? t('an.title') : t('an.titlePlural')}
      onClose={onDismiss}
      footer={
        <>
          <button type="button" className="btn" onClick={onDismiss}>
            {t('an.keepAsTyped')}
          </button>
          <button type="button" className="btn btn-primary" onClick={apply}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="banner warn">{t('an.banner')}</div>

        {findings.map((finding) => {
          const isDismissed = dismissed.has(finding.setId);
          const correction = corrections[finding.setId] ?? null;

          return (
            <div
              key={finding.setId}
              className="card"
              style={isDismissed ? { opacity: 0.5 } : undefined}
            >
              <div className="row-between">
                <div style={{ fontWeight: 600, minWidth: 0 }} className="break">
                  {finding.exerciseName}
                </div>
                <span className="badge warn">
                  {finding.value} {finding.unit}
                </span>
              </div>
              <p className="small muted" style={{ margin: 'var(--space-1) 0 0' }}>
                {t('an.usualRange', {
                  low: finding.typicalLow,
                  high: finding.typicalHigh,
                  unit: finding.unit,
                })}
              </p>

              {isDismissed ? (
                <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                  {t('an.ignoring')}
                </p>
              ) : (
                <>
                  <div className="row" style={{ marginTop: 'var(--space-3)' }}>
                    <span className="small faint" style={{ minWidth: '3.5rem' }}>
                      {t('an.fixTo')}
                    </span>
                    <NumberField
                      value={correction}
                      ariaLabel={`${t('an.fixTo')} ${finding.exerciseName}`}
                      placeholder={String(finding.value)}
                      onChange={(value) =>
                        setCorrections((current) => ({ ...current, [finding.setId]: value }))
                      }
                    />
                    <span className="small faint">{finding.unit}</span>
                  </div>
                  <div className="row" style={{ marginTop: 'var(--space-2)' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setCorrections((current) => ({ ...current, [finding.setId]: null }))
                      }
                    >
                      {t('an.clearFix')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setDismissed((current) => new Set(current).add(finding.setId))}
                    >
                      {t('an.ignore')}
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}

        {active.length === 0 ? (
          <p className="small faint" style={{ margin: 0 }}>
            {t('an.allIgnored')}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
