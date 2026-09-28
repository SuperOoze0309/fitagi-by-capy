import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ConfirmDialog } from '../components/Sheet';
import { EmptyState, PageHeader, Segmented } from '../components/ui';
import { formatDuration, formatNumber, fromKg } from '../domain/units';
import { formatDateTime } from '../domain/datetime';
import type { SummaryKind, TrainingSummary } from '../domain/types';
import type { MessageKey } from '../i18n';
import { repositories } from '../repositories';
import { aiService } from '../services/ai';
import { periodLabel } from '../services/summaries/buildSummary';
import { SummaryService } from '../services/summaries/summaryService';
import { clearPolish, displayBody, isPolished, polishSummary } from '../services/summaries/polish';
import { useApp, useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';

const KIND_KEYS: Record<SummaryKind, MessageKey> = {
  daily: 'summaries.daily',
  weekly: 'summaries.weekly',
  monthly: 'summaries.monthly',
};

/**
 * Summaries: what you did, compressed.
 *
 * Every row is derived data generated locally — no model is involved. An LLM can
 * only rephrase a summary's body afterwards, and deleting one here never touches
 * the workouts it came from.
 */
export function SummariesPage() {
  const { settings } = useApp();
  const { t, tPlural } = useI18n();
  const toast = useToast();
  const ai = useMemo(() => aiService(settings), [settings]);
  const [kind, setKind] = useState<SummaryKind>('daily');
  const [summaries, setSummaries] = useState<TrainingSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TrainingSummary | null>(null);

  const load = useCallback(async () => {
    const rows = await repositories().summaries.ofKind(kind);
    setSummaries(rows);
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const regenerate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await new SummaryService(repositories()).rebuildAll(settings.defaultUnit);
      await load();
      toast.show(
        t('summaries.rebuiltToast', {
          daily: result.daily,
          weekly: result.weekly,
          monthly: result.monthly,
        }),
        'success',
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : t('summaries.rebuildFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, load, settings.defaultUnit, t, toast]);

  const unit = settings.defaultUnit;
  const latest = useMemo(() => summaries?.[0] ?? null, [summaries]);
  const kindLabel = t(KIND_KEYS[kind]);

  const handlePolish = useCallback(
    async (summary: TrainingSummary) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await polishSummary(repositories(), ai, summary);
        await load();
        toast.show(
          result.polished
            ? t('summaries.polishedToast')
            : result.reason
              ? t('summaries.keptLocalReason', { reason: result.reason })
              : t('summaries.keptLocal'),
          result.polished ? 'success' : 'info',
        );
      } finally {
        setBusy(false);
      }
    },
    [ai, busy, load, t, toast],
  );

  const handleClearPolish = useCallback(
    async (summary: TrainingSummary) => {
      await clearPolish(repositories(), summary);
      await load();
      toast.show(t('summaries.reverted'));
    },
    [load, t, toast],
  );

  return (
    <>
      <PageHeader
        title={t('summaries.title')}
        subtitle={t('summaries.subtitle')}
        action={
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void regenerate()}
          >
            {busy ? '…' : t('summaries.rebuild')}
          </button>
        }
      />
      <main className="app-main">
        <div className="page">
          <Segmented
            ariaLabel={t('summaries.title')}
            value={kind}
            options={[
              { value: 'daily', label: t('summaries.daily') },
              { value: 'weekly', label: t('summaries.weekly') },
              { value: 'monthly', label: t('summaries.monthly') },
            ]}
            onChange={setKind}
          />

          {summaries === null ? (
            <p className="small faint" style={{ marginTop: 14 }}>
              {t('common.loading')}
            </p>
          ) : summaries.length === 0 ? (
            <div style={{ marginTop: 14 }}>
              <EmptyState
                title={t('summaries.emptyTitle', { kind: kindLabel })}
                hint={t('summaries.emptyHint')}
              />
            </div>
          ) : (
            <>
              {latest ? (
                <div className="card" style={{ marginTop: 12 }}>
                  <div className="row-between">
                    <span className="badge">{periodLabel(kind, latest.periodKey)}</span>
                    <span className="small faint">
                      {tPlural('summaries.sessions', 'summaries.oneSession', latest.sessionCount)}
                    </span>
                  </div>
                  <div className="stat-grid" style={{ marginTop: 10 }}>
                    {latest.highlights.map((highlight) => (
                      <div key={highlight.label}>
                        <div className="stat-label">{highlight.label}</div>
                        <div className="stat-value">{highlight.value}</div>
                      </div>
                    ))}
                  </div>
                  <p style={{ margin: '12px 0 0', whiteSpace: 'pre-wrap' }}>{displayBody(latest)}</p>
                  {isPolished(latest) ? (
                    <p className="small faint" style={{ margin: '8px 0 0' }}>
                      {t('summaries.polishedBy', { target: ai.describeTarget() })}
                    </p>
                  ) : null}
                  <div className="row-wrap" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy || !ai.isEnabled()}
                      title={ai.isEnabled() ? t('summaries.polish') : t('settings.enableAi')}
                      onClick={() => void handlePolish(latest)}
                    >
                      {ai.isEnabled() ? t('summaries.polish') : t('summaries.polishOff')}
                    </button>
                    {isPolished(latest) ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => void handleClearPolish(latest)}
                      >
                        {t('summaries.useLocal')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="section-title">
                <span>{t('summaries.all', { kind: kindLabel })}</span>
                <span className="faint">{summaries.length}</span>
              </div>

              <div className="stack">
                {summaries.map((summary) => (
                  <article key={summary.id} className="card">
                    <div className="row-between">
                      <div>
                        <div style={{ fontWeight: 600 }}>
                          {periodLabel(kind, summary.periodKey)}
                        </div>
                        <div className="small muted">{summary.title}</div>
                      </div>
                      <button
                        type="button"
                        className="btn-icon"
                        aria-label={t('summaries.deleteLabel', { period: summary.periodKey })}
                        onClick={() => setConfirmDelete(summary)}
                      >
                        ✕
                      </button>
                    </div>

                    {summary.bullets.length > 0 ? (
                      <ul className="small muted" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                        {summary.bullets.slice(0, 5).map((bullet, index) => (
                          <li key={index}>{bullet}</li>
                        ))}
                        {summary.bullets.length > 5 ? (
                          <li className="faint">
                            {t('history.more', { count: summary.bullets.length - 5 })}
                          </li>
                        ) : null}
                      </ul>
                    ) : null}

                    <div className="row-between small faint" style={{ marginTop: 10 }}>
                      <span>
                        {t('summaries.volumeLabel', {
                          value: formatNumber(fromKg(summary.totalVolumeKg, unit), 0),
                          unit,
                        })}{' '}
                        · {formatDuration(summary.totalDurationSec)}
                      </span>
                      <span>{formatDateTime(summary.updatedAt)}</span>
                    </div>

                    {summary.workoutIds.length > 0 ? (
                      <div className="row-wrap" style={{ marginTop: 8 }}>
                        {summary.workoutIds.slice(0, 3).map((workoutId) => (
                          <Link key={workoutId} className="badge neutral" to={`/history/${workoutId}`}>
                            {t('common.open')}
                          </Link>
                        ))}
                        {summary.workoutIds.length > 3 ? (
                          <span className="small faint">
                            {t('history.more', { count: summary.workoutIds.length - 3 })}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            </>
          )}

          <p className="small faint" style={{ marginTop: 14 }}>
            {t('summaries.footer')}
          </p>
        </div>
      </main>

      {confirmDelete ? (
        <ConfirmDialog
          title={t('summaries.deleteTitle')}
          message={t('summaries.deleteBody', {
            kind: kindLabel,
            period: periodLabel(kind, confirmDelete.periodKey),
          })}
          confirmLabel={t('summaries.deleteConfirm')}
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const target = confirmDelete;
            setConfirmDelete(null);
            void (async () => {
              await repositories().summaries.remove(target.id);
              await load();
              toast.show(t('summaries.deleted'));
            })();
          }}
        />
      ) : null}
    </>
  );
}
