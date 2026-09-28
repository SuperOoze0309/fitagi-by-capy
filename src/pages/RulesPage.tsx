import { PageHeader } from '../components/ui';
import { RuleList } from '../components/RuleFormSheet';
import { useI18n } from '../state/AppContext';

/**
 * Alias rules, managed directly by the user.
 *
 * Resolution order for an exercise name is fixed and this page owns the top of it:
 *   1. an explicit rule created here (or captured from a rename)
 *   2. a previously confirmed mapping
 *   3. an AI suggestion (Phase 3)
 *   4. the raw name the user typed
 */
export function RulesPage() {
  const { t } = useI18n();

  return (
    <>
      <PageHeader title={t('rules.title')} subtitle={t('rules.subtitle')} />
      <main className="app-main">
        <div className="page">
          <RuleList />
          <p className="small faint" style={{ marginTop: 14 }}>
            {t('rules.footer')}
          </p>
        </div>
      </main>
    </>
  );
}
