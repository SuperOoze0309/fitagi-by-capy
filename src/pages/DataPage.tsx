import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '../components/Sheet';
import { Field, PageHeader, Segmented } from '../components/ui';
import { formatDateTime, localDateKey } from '../domain/datetime';
import type { Translator } from '../i18n';
import {
  applyBackup,
  backupFileName,
  createBackup,
  parseBackup,
  serializeBackup,
  summarizeBackup,
  BackupParseError,
  type BackupDocument,
  type BackupSummary,
} from '../services/backup';
import { buildExport, type ExportFormat } from '../services/export/exportService';
import { pickTextFile, saveTextFile } from '../services/fileTransfer';
import { useApp, useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';
import { repositories } from '../repositories';

/**
 * Backup and restore.
 *
 * A purely local app is only trustworthy if the data can leave the device, so this
 * is treated as a first-class feature rather than a settings extra:
 *  - export is always available and never includes the API key;
 *  - import parses and validates the file first, shows exactly what will change,
 *    and only then applies it.
 */
export function DataPage() {
  const toast = useToast();
  const { reloadSettings, settings } = useApp();
  const { t } = useI18n();

  const [counts, setCounts] = useState<{ workouts: number; rules: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ document: BackupDocument; summary: BackupSummary; fileName: string } | null>(
    null,
  );
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [range, setRange] = useState<'all' | 'month' | 'week'>('all');

  const loadCounts = useCallback(async () => {
    const repos = repositories();
    const [workouts, rules] = await Promise.all([repos.training.count(), repos.rules.count()]);
    setCounts({ workouts, rules });
  }, []);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  const handleExport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const document = await createBackup();
      const summary = summarizeBackup(document);
      const fileName = backupFileName(document.exportedAt);
      const result = await saveTextFile(fileName, serializeBackup(document));
      setLastExport(document.exportedAt);
      toast.show(
        result.location === 'shared'
          ? t('data.exportShared', {
              format: 'JSON',
              workouts: summary.workouts,
              sets: summary.sets,
            })
          : t('data.exportDone', {
              format: 'JSON',
              workouts: summary.workouts,
              sets: summary.sets,
              file: result.fileName,
            }),
        'success',
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : t('data.exportFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleTextExport = async (format: ExportFormat) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await buildExport(repositories(), format, {
        unit: settings.defaultUnit,
        ...rangeBounds(range),
      });
      if (result.workoutCount === 0) {
        toast.show(t('data.nothingInRange'));
        return;
      }
      const saved = await saveTextFile(result.fileName, result.contents, result.mimeType);
      toast.show(
        saved.location === 'shared'
          ? t('data.exportShared', {
              format: format === 'csv' ? t('data.csv') : t('data.markdown'),
              workouts: result.workoutCount,
              sets: result.setCount,
            })
          : t('data.exportDone', {
              format: format === 'csv' ? t('data.csv') : t('data.markdown'),
              workouts: result.workoutCount,
              sets: result.setCount,
              file: saved.fileName,
            }),
        'success',
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : t('data.exportFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePickFile = async () => {
    if (busy) return;
    const picked = await pickTextFile();
    if (!picked) return;
    try {
      const document = parseBackup(picked.text);
      setPending({ document, summary: summarizeBackup(document), fileName: picked.name });
    } catch (error) {
      toast.show(
        error instanceof BackupParseError ? error.message : t('data.importUnreadable'),
        'error',
      );
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    const { summary } = pending;
    setPending(null);
    setBusy(true);
    try {
      await applyBackup(pending.document);
      await reloadSettings();
      await loadCounts();
      toast.show(t('data.restoredToast', { count: summary.workouts }), 'success');
    } catch (error) {
      toast.show(error instanceof Error ? error.message : t('data.importFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('data.title')} subtitle={t('data.subtitle')} />
      <main className="app-main">
        <div className="page">
          <div className="card">
            <div className="row-between">
              <div style={{ fontWeight: 600 }}>{t('data.onDevice')}</div>
              <span className="badge neutral">
                {counts
                  ? t('data.counts', { workouts: counts.workouts, rules: counts.rules })
                  : '…'}
              </span>
            </div>
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              {t('data.storageNote')}
            </p>
          </div>

          <div className="section-title">
            <span>{t('data.export')}</span>
          </div>
          <div className="card">
            <p className="small muted" style={{ marginTop: 0 }}>
              {t('data.exportBody')}
            </p>
            <p className="small faint" style={{ margin: '0 0 10px' }}>
              {t('data.exportNoKey')}
            </p>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={busy || !counts}
              onClick={() => void handleExport()}
            >
              {busy ? t('data.working') : t('data.exportJson')}
            </button>
            {lastExport ? (
              <p className="small faint" style={{ margin: '8px 0 0' }}>
                {t('data.lastExport', { when: formatDateTime(lastExport) })}
              </p>
            ) : null}
          </div>

          <div className="card">
            <div style={{ fontWeight: 600 }}>{t('data.readable')}</div>
            <p className="small muted" style={{ margin: '6px 0 10px' }}>
              {t('data.readableBody')}
            </p>

            <Field label={t('data.range')} htmlFor="export-range">
              <Segmented
                ariaLabel={t('data.range')}
                value={range}
                options={[
                  { value: 'all', label: t('data.rangeAll') },
                  { value: 'month', label: t('data.rangeMonth') },
                  { value: 'week', label: t('data.rangeWeek') },
                ]}
                onChange={setRange}
              />
            </Field>

            <div className="row" style={{ marginTop: 12, gap: 8 }}>
              <button
                type="button"
                className="btn btn-block"
                disabled={busy || !counts}
                onClick={() => void handleTextExport('markdown')}
              >
                {t('data.markdown')}
              </button>
              <button
                type="button"
                className="btn btn-block"
                disabled={busy || !counts}
                onClick={() => void handleTextExport('csv')}
              >
                {t('data.csv')}
              </button>
            </div>
          </div>

          <div className="section-title">
            <span>{t('data.importSection')}</span>
          </div>
          <div className="card">
            <div className="banner warn" style={{ marginBottom: 10 }}>
              {t('data.importWarning')}
            </div>
            <button
              type="button"
              className="btn btn-block"
              disabled={busy}
              onClick={() => void handlePickFile()}
            >
              {t('data.chooseFile')}
            </button>
          </div>

          <div className="section-title">
            <span>{t('data.prefs')}</span>
          </div>
          <div className="card">
            <div className="row-between">
              <span>{t('data.defaultUnitLabel')}</span>
              <span className="mono small">{settings.defaultUnit}</span>
            </div>
            <div className="row-between" style={{ marginTop: 8 }}>
              <span>{t('data.themeLabel')}</span>
              <span className="mono small">{settings.theme}</span>
            </div>
            <div className="row-between" style={{ marginTop: 8 }}>
              <span>{t('data.aiLabel')}</span>
              <span className="mono small">
                {settings.aiEnabled ? t('data.enabled') : t('data.disabled')}
              </span>
            </div>
          </div>
        </div>
      </main>

      {pending ? (
        <ConfirmDialog
          title={t('data.restoreTitle')}
          message={describePending(pending.summary, pending.fileName, counts?.workouts ?? 0, t)}
          confirmLabel={t('data.restoreConfirm')}
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmImport()}
        />
      ) : null}
    </>
  );
}

function describePending(
  summary: BackupSummary,
  fileName: string,
  currentWorkouts: number,
  t: Translator['t'],
): string {
  return [
    t('data.restoreMeta', {
      file: fileName,
      when: formatDateTime(summary.exportedAt),
      version: summary.appVersion,
    }),
    t('data.restoreCounts', {
      workouts: summary.workouts,
      exercises: summary.exercises,
      sets: summary.sets,
      rules: summary.aliasRules,
      summaries: summary.summaries,
      meals: summary.meals,
    }),
    t('data.restoreReplaces', { count: currentWorkouts }),
  ].join('\n\n');
}

/** Inclusive local-day bounds for the chosen range. */
function rangeBounds(range: 'all' | 'month' | 'week'): { from?: string; to?: string } {
  const today = new Date();
  if (range === 'week') {
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    return { from: localDateKey(start), to: localDateKey(today) };
  }
  if (range === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: localDateKey(start), to: localDateKey(today) };
  }
  return {};
}
