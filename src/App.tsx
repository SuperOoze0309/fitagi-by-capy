import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { WorkoutPage } from './pages/WorkoutPage';
import { HistoryPage } from './pages/HistoryPage';
import { WorkoutDetailPage } from './pages/WorkoutDetailPage';
import { ExercisePage } from './pages/ExercisePage';
import { QuickLogPage } from './pages/QuickLogPage';
import { AiPage } from './pages/AiPage';
import { SummariesPage } from './pages/SummariesPage';
import { RulesPage } from './pages/RulesPage';
import { DataPage } from './pages/DataPage';
import { SettingsPage } from './pages/SettingsPage';
import { ProfilePage } from './pages/ProfilePage';
import { MealsPage } from './pages/MealsPage';
import { MealDetailPage } from './pages/MealDetailPage';
import { RemindersPage } from './pages/RemindersPage';
import { PlansPage } from './pages/PlansPage';
import { WelcomePage } from './pages/WelcomePage';
import { useApp, useI18n } from './state/AppContext';
import { PixelArt } from './components/PixelArt';
import { getMascot } from './theme/tokens';
import type { MessageKey } from './i18n';

interface NavItem {
  to: string;
  labelKey: MessageKey;
  icon: string;
  end: boolean;
  /** Shown in the bottom bar on a phone; the rail always shows everything. */
  primary: boolean;
}

/**
 * One navigation list, two presentations.
 *
 * On a phone the `primary` entries fill the bottom bar; from 56rem up the rail
 * shows every destination. Neither is a separate component, so a route can never
 * be reachable on one form factor and missing on the other.
 */
const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.home', icon: '🏠', end: true, primary: true },
  { to: '/plans', labelKey: 'nav.plans', icon: '🗓️', end: false, primary: true },
  { to: '/meals', labelKey: 'nav.meals', icon: '🍽️', end: false, primary: true },
  { to: '/history', labelKey: 'nav.history', icon: '📋', end: false, primary: true },
  { to: '/settings', labelKey: 'nav.settings', icon: '⚙️', end: false, primary: true },
  { to: '/reminders', labelKey: 'nav.reminders', icon: '🔔', end: false, primary: false },
  { to: '/ai', labelKey: 'nav.ai', icon: '✨', end: false, primary: false },
  { to: '/quick-log', labelKey: 'nav.quickLog', icon: '⌨️', end: false, primary: false },
  { to: '/summaries', labelKey: 'nav.stats', icon: '📈', end: false, primary: false },
  { to: '/profile', labelKey: 'nav.profile', icon: '👤', end: false, primary: false },
];

export default function App() {
  const { settings, ready } = useApp();
  const { t } = useI18n();

  /*
   * Wait for the stored preferences before choosing a route tree.
   *
   * The context holds `DEFAULT_SETTINGS` until storage has been read, and the default
   * `onboardedAt` is null — so without this the welcome branch renders for a moment on
   * every boot, and its catch-all redirect rewrites the URL. A deep link into the app
   * would land on Home instead of the page that was asked for. The splash is already
   * on screen at this point, so nothing visibly changes.
   */
  if (!ready) {
    return (
      <div className="splash">
        <PixelArt sprite={getMascot(settings.theme)} size={64} />
        <div className="small">{t('app.opening')}</div>
      </div>
    );
  }

  /*
   * First run: the permission walkthrough, before anything else.
   *
   * It is a route rather than a modal so the back button, the layout and the theme
   * all behave like every other screen. `onboardedAt` is null only on a fresh
   * install, so this cannot reappear once it has been seen.
   */
  if (settings.onboardedAt === null) {
    return (
      <div className="app-shell app-shell-plain">
        <Routes>
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="*" element={<Navigate to="/welcome" replace />} />
        </Routes>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <nav className="app-rail" aria-label={t('nav.main')}>
        <div className="row" style={{ padding: '0 var(--space-2) var(--space-3)' }}>
          <PixelArt
            sprite={getMascot(settings.theme)}
            size={28}
            title={t('theme.mascotAlt', { name: t(`theme.${settings.theme}`) })}
          />
          <strong style={{ fontSize: 'var(--font-sm)' }}>{t('app.name')}</strong>
        </div>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            <span className="rail-icon" aria-hidden="true">
              {item.icon}
            </span>
            {t(item.labelKey)}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/workout" element={<WorkoutPage />} />
        <Route path="/workout/:workoutId" element={<WorkoutPage />} />
        <Route path="/meals" element={<MealsPage />} />
        <Route path="/meals/new" element={<MealDetailPage />} />
        <Route path="/meals/:mealId" element={<MealDetailPage />} />
        <Route path="/reminders" element={<RemindersPage />} />
        <Route path="/plans" element={<PlansPage />} />
        <Route path="/welcome" element={<Navigate to="/" replace />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/history/:workoutId" element={<WorkoutDetailPage />} />
        <Route path="/exercise/:name" element={<ExercisePage />} />
        <Route path="/quick-log" element={<QuickLogPage />} />
        <Route path="/summaries" element={<SummariesPage />} />
        <Route path="/ai" element={<AiPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/data" element={<DataPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <nav className="app-nav" aria-label={t('nav.main')}>
        {NAV_ITEMS.filter((item) => item.primary).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            <span className="nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            {t(item.labelKey)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
