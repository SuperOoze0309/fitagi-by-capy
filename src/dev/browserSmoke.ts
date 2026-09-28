import { initRepositories, repositories } from '../repositories';
import {
  createExerciseEntry,
  createSetFromPrevious,
  createWorkout,
  withSetWeight,
} from '../domain/workout';
import { serializeBackup, createBackup, parseBackup, applyBackup } from '../services/backup';
import { workoutVolumeKg } from '../domain/metrics';
import { getStorage } from '../storage';
import { localDateKey } from '../domain/datetime';
import { weekKey } from '../services/summaries/buildSummary';
import { buildExport } from '../services/export/exportService';
import { saveTextFile } from '../services/fileTransfer';
import { createEmptyMeal } from '../repositories/mealRepository';
import { translate, type Locale } from '../i18n';
import type { Workout } from '../domain/types';

/**
 * Browser smoke test — only runs when the page is opened with `?smoke=1`.
 *
 * It walks the real happy path against real IndexedDB and a real DOM, across page
 * reloads, which is exactly what the repository tests cannot cover:
 *
 *   pass 1  record a workout -> finish it -> reload
 *   pass 2  the workout is still there, History and Home render it -> seed a
 *           second session and an alias rule -> reload
 *   pass 3  exercise history page renders the log and trend, rules page renders
 *           the rule, quick log previews and confirms, AI page is not a dead end
 *
 * The run is coordinated through the app's own IndexedDB rather than
 * `sessionStorage`, which does not reliably survive a reload in headless Chrome.
 *
 * Results are written into `#smoke-result` so a headless run (scripts/smoke.ps1)
 * can assert without a debug-protocol client.
 */
export const PANEL_ID = 'smoke-result';
const RUN_STATE_KEY = 'browser-smoke-state';

/** Marker for the crash this harness raises on purpose, so it can be filtered out. */
const DELIBERATE_CRASH = 'smoke test: deliberate render failure';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Coordination state, kept in the `presets` key/value store so it survives a
 * reload exactly like the workout data does.
 */
interface RunState {
  step: number;
  visits: number;
  workoutId?: string;
}

function runStateStore() {
  return getStorage().scope.kv('presets');
}

async function readRunState(): Promise<RunState> {
  const stored = await runStateStore().get<RunState>(RUN_STATE_KEY);
  return stored ?? { step: 1, visits: 0 };
}

async function writeRunState(state: RunState): Promise<void> {
  await runStateStore().set(RUN_STATE_KEY, state);
}

export async function runBrowserSmoke(): Promise<void> {
  initRepositories();
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  };

  const state = await readRunState();
  const visits = state.visits + 1;
  await writeRunState({ ...state, visits });

  // A reload loop would otherwise hang with no explanation. The budget covers the
  // language pin plus the three passes, with headroom for a retried visit.
  if (visits > 6) {
    check('reload loop detected', false, `step=${state.step} visits=${visits}`);
    render(checks, 'done');
    document.title = 'SMOKE:FAIL';
    return;
  }

  render([{ name: `pass ${state.step} started`, ok: true, detail: `visit ${visits}` }], 'running');

  if (state.step === 1) {
    await completeWelcome(check);
    const workoutId = await pass1Record(check);
    await writeRunState({ step: 2, visits, workoutId });
    render(checks, 'reloading to verify persistence');
    window.location.reload();
    return;
  }

  if (state.step === 2) {
    await pass2Verify(check, state.workoutId);
    await writeRunState({ step: 3, visits, ...(state.workoutId ? { workoutId: state.workoutId } : {}) });
    render(checks, 'reloading to verify the exercise history page');
    window.location.reload();
    return;
  }

  await pass3Body(check);

  // 9. The error boundary must turn a crashing screen into a recoverable one.
  await checkErrorBoundary(check);
  check('no console errors', readConsoleErrors().length === 0, summarizeConsoleErrors());
  await runStateStore().remove(RUN_STATE_KEY);
  render(checks, 'done');
}

/**
 * Mount the real `ErrorBoundary` around a component that throws, into a detached
 * container, and assert it produced the recovery screen instead of a blank page.
 *
 * React logs caught render errors through `console.error` by design, so the errors
 * this deliberate crash produces are removed from the capture afterwards —
 * otherwise the harness would flag its own intentional failure.
 */
async function checkErrorBoundary(
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  const capture = window as unknown as { __smokeConsoleErrors?: string[] };
  const recorded = capture.__smokeConsoleErrors;
  const errorsBefore = recorded ? [...recorded] : [];

  const container = document.createElement('div');
  document.body.appendChild(container);

  try {
    const [{ createRoot }, { ErrorBoundary }, React] = await Promise.all([
      import('react-dom/client'),
      import('../components/ErrorBoundary'),
      import('react'),
    ]);

    const Boom = (): never => {
      throw new Error(DELIBERATE_CRASH);
    };

    const root = createRoot(container);
    root.render(
      React.createElement(ErrorBoundary, null, React.createElement(Boom as never, null)),
    );
    // Let React commit the fallback.
    await tick(250);

    const text = container.innerText;
    check(
      'a render crash shows a recovery screen instead of a blank page',
      text.includes('Something went wrong'),
      text.slice(0, 80) || '(empty)',
    );
    check('the recovery screen says the data is safe', /data is still on this device/i.test(text));
    check('the recovery screen explains what to do', /Reload/.test(text) && /backup/i.test(text));
    check('the boundary reports the error message', new RegExp(DELIBERATE_CRASH).test(text));

    root.unmount();
  } catch (error) {
    check('error boundary test ran', false, error instanceof Error ? error.message : String(error));
  } finally {
    container.remove();
    // Drop exactly the errors this intentional crash produced.
    if (recorded) {
      recorded.length = 0;
      recorded.push(...errorsBefore);
    }
  }
}

/**
 * React logs invalid DOM nesting and similar mistakes to `console.error` without
 * throwing, so a page can look fine while emitting broken markup. The harness
 * records them (see the console capture in scripts/cdp-check.mjs) and the smoke
 * test asserts there are none.
 */
function readConsoleErrors(): string[] {
  const recorded = (window as unknown as { __smokeConsoleErrors?: string[] })
    .__smokeConsoleErrors;
  return Array.isArray(recorded) ? recorded : [];
}

function summarizeConsoleErrors(): string {
  const errors = readConsoleErrors();
  if (errors.length === 0) return 'none';
  return errors[0]!.split('\n')[0]!.slice(0, 120);
}

/** Start a workout, log sets, finish it. This is the Phase 1 core loop. */
async function pass1Record(
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<string> {
  const training = repositories().training;

  const workout = await training.put(createWorkout());
  check('workout created with an id', workout.id.length > 0);
  check('workout starts incomplete', workout.completed === false);

  const exercise = createExerciseEntry(workout.id, 'Bench Press', 0);
  await training.upsertExercise(workout.id, {
    ...exercise,
    sets: [
      withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 60, 'kg'),
      withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 8 }, 60, 'kg'),
      withSetWeight(
        { ...createSetFromPrevious(undefined, 'kg'), reps: 7, isFailure: true, rpe: 10 },
        60,
        'kg',
      ),
    ],
  });

  const withSets = await training.get(workout.id);
  check(
    'sets persisted',
    withSets?.exercises[0]?.sets.length === 3,
    `${withSets?.exercises[0]?.sets.length} sets`,
  );

  const finished = await training.complete(workout.id);
  check('workout completed', finished.completed === true);
  check('duration stamped', finished.durationSec >= 0, `${finished.durationSec}s`);
  check(
    'appears in history',
    (await training.completed()).some((row) => row.id === workout.id),
  );

  return workout.id;
}

/** Everything written in pass 1 must survive a real page reload. */
async function pass2Verify(
  check: (name: string, ok: boolean, detail?: string) => void,
  storedId: string | undefined,
) {
  await appReady(check);
  const training = repositories().training;

  const reloaded = storedId ? await training.get(storedId) : null;
  check('workout survived the reload', reloaded !== null);
  check('exercise survived', reloaded?.exercises[0]?.rawName === 'Bench Press');
  check('all sets survived', reloaded?.exercises[0]?.sets.length === 3);
  check(
    'failure flag survived',
    reloaded?.exercises[0]?.sets[2]?.isFailure === true,
    `isFailure=${String(reloaded?.exercises[0]?.sets[2]?.isFailure)}`,
  );
  check('rpe survived', reloaded?.exercises[0]?.sets[2]?.rpe === 10);
  check('kg normalization survived', reloaded?.exercises[0]?.sets[0]?.weightKg === 60);

  const summary = await repositories().exercises.summary('Bench Press');
  check('exercise history built', summary?.sessionCount === 1, `${summary?.sessionCount} sessions`);

  // Render History and confirm the workout is on screen.
  await goTo('/history');
  check('History page renders the workout', await waitForText('Bench Press', 5000));

  // Home renders the most recent workout with its volume.
  await goTo('/');
  check('Home page renders the recent workout', await waitForText('volume', 5000));

  // Seed a second session (heavier) plus an alias rule, so pass 3 has something
  // to show on the exercise and rules pages.
  const second = await training.put(createWorkout());
  const entry = createExerciseEntry(second.id, 'bench', 0);
  await training.upsertExercise(second.id, {
    ...entry,
    normalizedName: 'Bench Press',
    sets: [withSetWeight({ ...createSetFromPrevious(undefined, 'kg'), reps: 6 }, 70, 'kg')],
  });
  await training.complete(second.id);
  await repositories().rules.save({ match: 'bench', normalized: 'Bench Press' });
  check('alias rule saved', (await repositories().rules.resolve('BENCH')) === 'Bench Press');
}

/** Phase 2 surfaces: exercise history page, rules page, backup round-trip. */
async function pass3Body(check: (name: string, ok: boolean, detail?: string) => void) {
  // The app must be up before anything is driven or asserted.
  await appReady(check);

  // 1. Exercise history page renders the session log and the trend chart.
  // Section titles are uppercased by CSS, and `innerText` reflects that, so the
  // assertions below compare case-insensitively.
  await goTo(`/exercise/${encodeURIComponent('Bench Press')}`);
  // Generous: this is the first navigation after a reload, so it races the app's own
  // boot (storage, settings, reminder sync) before the page can fetch its history.
  const exerciseText = await waitForAnyText(
    ['Session log', 'No history', 'Loading exercise'],
    15000,
  );
  const exerciseDom = exerciseText.toLowerCase();
  const logged = exerciseDom.includes('session log');
  check(
    'exercise page renders the session log',
    logged,
    logged
      ? undefined
      : `hash=${window.location.hash} notFound=${exerciseText.includes('No history')}` +
        ` loading=${/Loading exercise/i.test(exerciseText)}` +
        ` len=${exerciseText.length} tail=${exerciseText.slice(-60).replace(/\n/g, ' / ')}`,
  );
  check('exercise page shows the best set', /70\s*kg/.test(exerciseText), firstMatch(exerciseText, /\d+(\.\d+)?\s*kg/));
  check('exercise page counts both sessions', exerciseDom.includes('2 sessions'));
  check('exercise page renders the trend chart', !!document.querySelector('#root svg polyline'));
  check(
    'the chart has labelled axes',
    document.querySelectorAll('#root svg text').length >= 3,
    `${document.querySelectorAll('#root svg text').length} tick labels`,
  );
  check('exercise page shows a progression delta', exerciseText.includes('+10'), '+10 kg vs previous');
  // The rendered set line, for diagnostics when the assertion below fails.
  const setLines = [...document.querySelectorAll('#root .small.mono')]
    .map((node) => (node.textContent ?? '').trim())
    .filter((text) => text !== '');
  check(
    'exercise page shows all logged sets',
    /60kg.{0,3}8/i.test(exerciseText) && /fail/i.test(exerciseText),
    `sets: ${setLines.join(' | ').slice(0, 120) || '(none)'}`,
  );
  const prFlags = (await repositories().exercises.history('Bench Press')).map(
    (entry) => `${entry.dateKey}:${entry.isPersonalBest ? 'PR' : '-'}`,
  );
  const badgeText = [...document.querySelectorAll('#root .badge')]
    .map((node) => (node.textContent ?? '').trim())
    .join(' | ');
  check(
    'exercise page marks the record session as a PR',
    // Asserted on the badges rather than on the page text: `innerText` concatenates
    // the date and the badge with no separator ("...2026PR"), so a word-boundary
    // search over the whole page cannot see it even though it is rendered.
    /\bPR\b/.test(badgeText),
    `isPersonalBest = ${prFlags.join(', ')} · badges = ${badgeText.slice(0, 100) || '(none)'}`,
  );

  // The metric toggle switches the chart between the top set and estimated 1RM.
  const topSetReadout = firstMatch(exerciseText, /^\d+(\.\d+)? kg$/m);
  check('chart starts on the top-set metric', topSetReadout !== 'no match', topSetReadout);
  clickByText('button', 'e1RM');
  await tick(150);
  const e1rmText = appText();
  check('chart metric toggles to e1RM', /estimated from your best set/i.test(e1rmText));
  check(
    'e1RM is derived, so it differs from the raw top set',
    firstMatch(e1rmText, /^\d+(\.\d+)? kg$/m) !== topSetReadout,
    `${topSetReadout} → ${firstMatch(e1rmText, /^\d+(\.\d+)? kg$/m)}`,
  );
  clickByText('button', 'Top set');
  await tick(100);

  // 2. Rules page renders the saved rule, and the form UI actually saves one.
  await goTo('/rules');
  const rulesRendered = await waitForText('Saved rules', 5000);
  const rulesDom = appText();
  check('rules page renders', rulesRendered);
  check(
    'rules page renders the saved rule',
    rulesDom.includes('bench') && rulesDom.includes('Bench Press'),
  );

  // Drive the real form: type into both fields and click the button.
  const typedIntoForm =
    setReactInputValue('rule-match', 'ohp') && setReactInputValue('rule-normalized', 'Overhead Press');
  check('rule form accepts typed input', typedIntoForm);
  await tick(80);
  clickByText('button', 'Add rule');
  const addedViaForm = await waitForText('ohp', 4000);
  check('rule form saves through the UI', addedViaForm);
  check(
    'form rule resolves',
    (await repositories().rules.resolve('ohp')) === 'Overhead Press',
    `${await repositories().rules.count()} rules`,
  );

  // Remove it again through the data layer and confirm the UI reflects that.
  const rulesAfterForm = await repositories().rules.all();
  const ohp = rulesAfterForm.find((rule) => rule.match === 'ohp');
  if (ohp) await repositories().rules.remove(ohp.id);
  check('rules can be removed', (await repositories().rules.count()) === 1);

  // 3. Backup round-trip through the real storage, with an API key present.
  await repositories().settings.patch({
    defaultUnit: 'lb',
    aiEnabled: true,
    aiApiKey: 'sk-browser-smoke-secret',
  });
  const document_ = await createBackup();
  const json = serializeBackup(document_);
  check('backup excludes the API key', !json.includes('sk-browser-smoke-secret'));
  check('backup includes both workouts', document_.workouts.length === 2, `${document_.workouts.length} workouts`);
  check('backup includes the alias rule', document_.aliasRules.length === 1);
  check('backup keeps the AI model settings', document_.settings.aiEnabled === true);

  await repositories().training.clear();
  check('storage cleared before restore', (await repositories().training.count()) === 0);

  await applyBackup(parseBackup(json));
  const restored = await repositories().training.completed();
  check('restore brought the workouts back', restored.length === 2, `${restored.length} workouts`);
  check('restore kept the alias rule', (await repositories().rules.resolve('bench')) === 'Bench Press');
  const settingsAfter = await repositories().settings.get();
  check('restore kept the unit preference', settingsAfter.defaultUnit === 'lb');
  check(
    'restore preserved the local API key',
    settingsAfter.aiApiKey === 'sk-browser-smoke-secret',
    'local key is never taken from a file',
  );

  // 4. The data page renders, and history is queryable again after the restore.
  await goTo('/data');
  const dataRendered = await waitForText('Backup & restore', 5000);
  check('backup page renders', dataRendered);
  const after = await repositories().exercises.summary('Bench Press');
  check('exercise history rebuilt after restore', after?.sessionCount === 2, `${after?.sessionCount} sessions`);
  check('best weight survived the round-trip', after?.bestWeightKg === 70);

  // Readable exports: built from the restored data, and the browser download path
  // really runs (it throws if the blob/anchor APIs are unavailable).
  const markdown = await buildExport(repositories(), 'markdown', { unit: 'kg' });
  check(
    'markdown export contains the workouts',
    markdown.workoutCount === 2 && /# FitAGI by Capy export/.test(markdown.contents),
    `${markdown.workoutCount} workouts, ${markdown.contents.length} chars`,
  );
  check(
    'markdown export lists every set',
    markdown.setCount === 4 && /- 60 kg × 8/.test(markdown.contents),
    `${markdown.setCount} sets`,
  );
  check(
    'markdown export includes the per-exercise table',
    /\| Exercise \| Sessions \| Best set \| e1RM \| Volume \|/.test(markdown.contents),
  );

  const csv = await buildExport(repositories(), 'csv', { unit: 'kg' });
  check(
    'csv export has one row per set plus a header',
    csv.contents.trim().split('\n').length === csv.setCount + 1 && csv.setCount > 0,
    `${csv.setCount} sets`,
  );
  check('csv export carries the canonical kg value', /,60,kg,60,/.test(csv.contents));

  const download = await saveTextFile(markdown.fileName, markdown.contents, markdown.mimeType);
  check(
    'the browser download path works',
    download.fileName === markdown.fileName && download.bytes > 0,
    `${download.fileName} (${download.bytes} bytes)`,
  );

  check(
    'the export buttons are offered',
    findButton('Markdown') !== null && findButton('CSV') !== null,
  );

  // 5. Quick log with AI off: the offline parser must produce a confirmable preview.
  await goTo('/quick-log');
  const quickLogRendered = await waitForText('Describe the workout', 5000);
  check('quick log page renders', quickLogRendered);
  check(
    'quick log states it works offline',
    appText().toLowerCase().includes('local rule-based parser'),
  );

  // Typing multibyte text through the debug protocol is unreliable, so the UI path
  // is exercised with ASCII input. The parser itself is covered for Chinese input
  // ("卧推 60kg 8次 4组 最后一组力竭") by the unit tests.
  const typed = setReactTextareaValue('quick-input', 'bench 60kg 8 8 8 8 last set failure');
  check('quick log accepts input', typed);
  await tick(60);
  clickByText('button', 'Parse');
  const previewShown = await waitForText('Check before saving', 6000);
  const previewText = appText();
  check('quick log shows a preview instead of saving', previewShown);
  // The exercise name lives in an <input>, and innerText excludes form values, so
  // it is asserted on the element rather than on page text.
  const nameFields = [
    ...document.querySelectorAll<HTMLInputElement>('#root input[aria-label="Parsed exercise name"]'),
  ];
  const allInputs = [...document.querySelectorAll<HTMLInputElement>('#root input')].map(
    (input) => `${input.getAttribute('aria-label') ?? '(none)'}=${JSON.stringify(input.value)}`,
  );
  check(
    'preview shows the parsed exercise',
    nameFields.some((field) => field.value === 'bench'),
    `${nameFields.length} name fields; inputs: ${allInputs.slice(0, 6).join(', ')}`,
  );
  check('preview shows four sets', /4 sets/.test(previewText), firstMatch(previewText, /\d+ sets/));
  check(
    'preview marks the last set as failure',
    (previewText.match(/Failure/g) ?? []).length >= 1,
  );

  const beforeConfirm = await repositories().training.count();
  check(
    'nothing is written before confirmation',
    beforeConfirm === 2,
    `${beforeConfirm} workouts`,
  );

  // Confirm, which is the only path that writes.
  const confirmClicked = clickByTextStartingWith('button', 'Confirm and save');
  const saved = await waitForText('Workout', 6000);
  check('confirm button is present and clickable', confirmClicked);
  check('confirming saves the workout', saved);

  // The save and the route change are asynchronous; poll until the write is
  // observable rather than assuming it has landed by the time the page renders.
  const afterConfirm = await waitForCount(3, 5000);

  const storedWorkouts: Workout[] = await repositories().training.all();
  const created = storedWorkouts.find(
    (workout) => workout.exercises[0]?.rawName === 'bench',
  );
  const diagnosis = JSON.stringify({
    count: afterConfirm,
    total: storedWorkouts.length,
    volumes: storedWorkouts.map((workout) => workoutVolumeKg(workout)),
    names: storedWorkouts.map((workout) => workout.exercises.map((exercise) => exercise.rawName)),
    sets: storedWorkouts.map((workout) => workout.exercises.map((exercise) => exercise.sets.length)),
    complete: storedWorkouts.map((workout) => workout.completed),
  });
  check('a new workout was created', afterConfirm === 3, diagnosis);
  check('the parsed exercise was stored with the right name', created !== undefined, diagnosis);
  check('four sets were stored', created?.exercises[0]?.sets.length === 4);
  check(
    'the failure flag reached storage',
    created?.exercises[0]?.sets[3]?.isFailure === true,
  );
  check('the weight reached storage', created?.exercises[0]?.sets[0]?.weightKg === 60);
  check(
    'only the last set is marked as failure',
    created?.exercises[0]?.sets.filter((set) => set.isFailure).length === 1,
  );
  // Quick Log records something that already happened, so it must land in History
  // finished rather than leaving a session open on Home.
  check('the quick-logged workout is complete', created?.completed === true);
  // 4 sets x 60 kg x 8 reps. Rendering this as 192 rather than 1920 is exactly the
  // bug a naive trailing-zero strip in formatNumber used to cause.
  const historyText = appText();
  check(
    'volume renders at the right magnitude',
    /1920\s*kg\s*volume/.test(historyText),
    firstMatch(historyText, /\d+(\.\d+)?\s*kg\s*volume/),
  );

  // 6. The AI page must be useful with AI off, not a dead end.
  await goTo('/ai');
  const aiRendered = await waitForText('AI is switched off', 5000);
  check('AI page renders with AI off', aiRendered);
  check(
    'AI page points at the offline quick log',
    appText().toLowerCase().includes('works without ai'),
  );

  // 7. Summaries: generated locally, visible, and safe to delete.
  await goTo('/summaries');
  const summariesRendered = await waitForText('Summaries', 5000);
  check('summaries page renders', summariesRendered);

  const daily = await repositories().summaries.get('daily', localDateKey(new Date()));
  check('a daily summary was generated automatically', daily !== null);
  check(
    'the daily summary states what was trained',
    // The title names the muscle group ("Trained chest."), not the lift.
    /trained \w+/i.test(daily?.title ?? ''),
    daily?.title ?? '(none)',
  );
  check(
    'the daily summary counts every session today',
    daily?.sessionCount === 3,
    `${daily?.sessionCount} sessions`,
  );
  check(
    'the daily summary totals volume from real sets',
    Math.round(daily?.totalVolumeKg ?? 0) === 3720,
    `${Math.round(daily?.totalVolumeKg ?? 0)} kg`,
  );
  check('the daily summary names the main lifts', /bench/i.test(daily?.body ?? ''));

  const weekly = await repositories().summaries.get('weekly', weekKey(new Date()));
  check('a weekly summary exists', weekly !== null);
  check(
    'the weekly summary is rolled up from its days',
    /By period:/.test(weekly?.body ?? ''),
    `${weekly?.sessionCount ?? 0} sessions in the week`,
  );

  const summariesText = appText();
  check('daily tab lists the summary', /BENCH/i.test(summariesText) || /sessions/i.test(summariesText));
  check(
    'the polish button reports that AI is off rather than hiding',
    findButton('Polish (AI off)') !== null,
  );

  // Switch tabs and confirm the weekly summary is listed too.
  clickByText('button', 'Weekly');
  const weeklyTab = await waitForText('All weekly summaries', 4000);
  check('weekly tab renders', weeklyTab);

  // Deleting a summary must not touch the workouts it came from.
  const workoutsBeforeDelete = await repositories().training.count();
  const weeklyRow = await repositories().summaries.get('weekly', weekKey(new Date()));
  if (weeklyRow) await repositories().summaries.remove(weeklyRow.id);
  const afterSummaryDelete = await repositories().training.count();
  check(
    'deleting a summary leaves workouts intact',
    afterSummaryDelete === workoutsBeforeDelete,
    `${afterSummaryDelete} workouts`,
  );

  // 8. Outlier review: flags an implausible weight, and never blocks the save.
  //
  // Quick Log is the path most likely to receive a typo, so the check runs there.
  await goTo('/quick-log');
  await waitForText('Describe the workout', 5000);
  setReactTextareaValue('quick-input', 'bench 600kg 8');
  await tick(60);
  clickByText('button', 'Parse');
  await waitForText('Check before saving', 6000);

  const countBeforeTypo = await repositories().training.count();
  clickByTextStartingWith('button', 'Confirm and save');

  const reviewShown = await waitForText('Check this weight', 8000);
  check(
    'an implausible weight is flagged before saving',
    reviewShown,
    JSON.stringify({
      workouts: await repositories().training.count(),
      findings: (await repositories().exercises.history('bench')).length,
    }),
  );
  check(
    'nothing is written while the review is open',
    (await repositories().training.count()) === countBeforeTypo,
    `${await repositories().training.count()} workouts`,
  );
  check(
    'the review says nothing was changed',
    appText().toLowerCase().includes('nothing has been changed'),
  );
  check(
    'the review offers to keep the value as typed',
    findButton('Keep as typed') !== null,
    'keep button present',
  );
  check(
    'the review shows the usual range for comparison',
    /usual range is about/.test(appText()),
    firstMatch(appText(), /usual range is about [\d.]+[–-][\d.]+ \w+/),
  );

  clickByText('button', 'Keep as typed');
  const savedAfterKeep = await waitForCount(countBeforeTypo + 1, 8000);
  check(
    'saving is never blocked by the review',
    savedAfterKeep === countBeforeTypo + 1,
    `${savedAfterKeep} workouts`,
  );

  const heavy = (await repositories().training.completed()).find((workout) =>
    workout.exercises.some((exercise) => exercise.sets.some((set) => set.weight === 600)),
  );
  check(
    'the flagged value is stored exactly as typed',
    heavy !== undefined && heavy.exercises[0]?.sets[0]?.weight === 600,
    `weight = ${heavy?.exercises[0]?.sets[0]?.weight ?? 'not found'}`,
  );

  // 9. Meals: manual entry through the real form, then edit, then delete.
  await runMealChecks(check);

  // 10. Reminders and plans: the two screens the app grew for scheduling.
  await runReminderChecks(check);
  await runPlanChecks(check);

  // 11. Vision capability: a text-only model must be told apart from a broken one.
  await runVisionChecks(check);

  // 12. The AI page: a conversation with the composer docked under it.
  await runChatLayoutChecks(check);

  // 13. Language and theme switching, in both directions, with no reload.
  await runLocaleChecks(check);
  await runThemeChecks(check);

  // 14. Responsive layout at whatever viewport this run was started with. The
  //     harness runs the whole suite twice — once phone-sized, once desktop-sized —
  //     so both branches below are exercised across a full run.
  runLayoutChecks(check);

  await goTo('/');
}

/**
 * Reminders: create one by hand, see it listed, then delete it.
 *
 * The notification itself belongs to the operating system, so what is asserted here
 * is the part the app owns: the record, the list, and the fact that a save survives a
 * reload.
 */
async function runReminderChecks(check: (name: string, ok: boolean, detail?: string) => void) {
  await goTo('/reminders');
  const rendered = await waitForAnyText(['No reminders yet', 'New reminder', 'Loading…'], 6000);
  check(
    'the reminders page renders',
    /no reminders yet|new reminder/i.test(rendered),
    firstMatch(rendered, /.{0,40}/),
  );

  const before = await repositories().reminders.count();
  clickByTextStartingWith('button', '+');
  const editorOpen = await waitForText('What to call it', 5000);
  check('the reminder editor opens', editorOpen, window.location.hash);

  setReactInputValue('reminder-title', 'Smoke leg day');
  setReactInputValue('reminder-body', 'Squat, bench, row');
  setReactInputValue('reminder-time', '19:30');
  await tick(120);
  clickByText('button', 'Save');

  const saved = await waitUntil(
    async () => (await repositories().reminders.count()) === before + 1,
    6000,
  );
  check('saving writes the reminder', saved, `${await repositories().reminders.count()} stored`);

  const stored = (await repositories().reminders.all()).find(
    (reminder) => reminder.title === 'Smoke leg day',
  );
  check('the reminder keeps its time', stored?.time === '19:30', `time = ${stored?.time}`);
  check('a hand-made reminder is marked as manual', stored?.source === 'manual');
  check(
    'an empty weekday list means every day',
    stored?.weekdays.length === 0,
    `weekdays = ${JSON.stringify(stored?.weekdays)}`,
  );

  await goTo('/reminders');
  const listed = await waitForText('Smoke leg day', 5000);
  check('the reminder is listed', listed);

  if (stored) {
    clickByText('button', 'Delete');
    await waitForText('Delete this reminder?', 4000);
    // The dialog's own confirm button, not the row button behind it.
    clickByTextWithin('.sheet-foot', 'Delete');
    const removed = await waitUntil(
      async () => (await repositories().reminders.count()) === before,
      6000,
    );
    check('a reminder can be deleted', removed, `${await repositories().reminders.count()} stored`);
  }
}

/** Plans: build a week, make it active, and see the week render. */
async function runPlanChecks(check: (name: string, ok: boolean, detail?: string) => void) {
  await goTo('/plans');
  const rendered = await waitForAnyText(['No plans yet', 'New plan', 'Loading…'], 6000);
  check(
    'the plans page renders',
    /no plans yet|new plan/i.test(rendered),
    firstMatch(rendered, /.{0,40}/),
  );

  clickByTextStartingWith('button', '+');
  const editorOpen = await waitForText('Plan name', 5000);
  check('the plan editor opens', editorOpen, window.location.hash);

  setReactInputValue('plan-name', 'Smoke split');
  await tick(120);

  // Add one exercise to the shown day and name it.
  clickByText('button', '+ Add exercise');
  await tick(150);
  const exerciseInput = document.querySelector<HTMLInputElement>(
    '#root .plan-row input[aria-label="Exercise"]',
  );
  check('a plan day can take an exercise', exerciseInput !== null);
  if (exerciseInput) {
    setReactInputValueByElement(exerciseInput, 'Bench Press');
    await tick(120);
  }

  clickByText('button', 'Save');
  const created = await waitUntil(async () => (await repositories().plans.count()) === 1, 6000);
  check('saving writes the plan', created, `${await repositories().plans.count()} stored`);

  const stored = (await repositories().plans.all())[0];
  check('the plan keeps all seven days', stored?.days.length === 7, `${stored?.days.length} days`);
  check(
    'the named exercise is stored on its day',
    stored?.days.some((day) => day.exercises.some((item) => item.name === 'Bench Press')) === true,
  );

  await goTo('/plans');
  await waitForText('Smoke split', 5000);
  clickByText('button', 'Make active');
  const activated = await waitUntil(
    async () => (await repositories().plans.active()) !== null,
    6000,
  );
  check('a plan can be made active', activated);
  check(
    'only one plan is ever active',
    (await repositories().plans.all()).filter((plan) => plan.active).length === 1,
  );

  const strip = document.querySelectorAll('#root .week-strip .week-cell').length;
  check('the week is drawn as seven cells', strip === 7, `${strip} cells`);

  // The plan's payoff is on Home: today's session, with a button that starts it.
  await goTo('/');
  const home = await waitForAnyText(["Today's plan", 'Rest day', 'Start workout'], 6000);
  check(
    "the home screen shows today's plan",
    /today's plan/i.test(home),
    firstMatch(home, /.{0,50}/),
  );
  check(
    'today’s plan lists the exercises it was given',
    /Bench Press/.test(home),
    firstMatch(home, /Bench Press[^\n]{0,20}/),
  );
  check(
    'the plan can be started from home',
    findButton('Start today’s session') !== null,
    'start button present',
  );

  // And it is reachable on a phone, where the bottom bar has no slot for it.
  await goTo('/settings');
  await waitForText('Reminders', 6000);
  check(
    'settings links to the reminders screen',
    [...document.querySelectorAll('#root a')].some(
      (link) => link.getAttribute('href') === '#/reminders',
    ),
    window.location.hash,
  );

  // Clean up so a later run starts from the same place.
  const active = await repositories().plans.active();
  if (active) await repositories().plans.remove(active.id);
}

/**
 * The AI page is a conversation: the thread scrolls, and the composer is docked
 * under it rather than sitting above the transcript where the form used to be.
 */
async function runChatLayoutChecks(check: (name: string, ok: boolean, detail?: string) => void) {
  await goTo('/ai');
  // The composer's placeholder is an attribute, and `innerText` does not report
  // those, so the check waits for the element rather than for text.
  const ready = await waitUntil(
    () =>
      document.getElementById('ai-question') !== null ||
      appText().includes('AI is switched off'),
    8000,
  );
  if (!ready || document.getElementById('ai-question') === null) {
    check(
      'the AI page shows the chat once AI is on',
      false,
      firstMatch(appText(), /.{0,60}/),
    );
    return;
  }
  check('the AI page shows the chat once AI is on', true);

  const input = document.getElementById('ai-question');
  const thread = document.querySelector('#root .chat-scroll');
  const composer = document.querySelector('#root .chat-composer');
  check('the composer is present', composer !== null);
  check('the transcript has its own scroll container', thread !== null);

  if (input && composer) {
    const inputBox = input.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    const viewport = window.innerHeight;

    check(
      'the composer sits below the transcript',
      composerBox.top >= (thread?.getBoundingClientRect().bottom ?? 0) - 1,
      `thread ends at ${Math.round(thread?.getBoundingClientRect().bottom ?? -1)}, composer starts at ${Math.round(composerBox.top)}`,
    );
    check(
      'the input is inside the viewport, not below the fold',
      inputBox.bottom <= viewport + 1 && composerBox.bottom <= viewport + 1,
      `input bottom ${Math.round(inputBox.bottom)} / viewport ${viewport}`,
    );
    check(
      'the input is in the lower half of the screen',
      inputBox.top > viewport * 0.5,
      `input top ${Math.round(inputBox.top)} of ${viewport}`,
    );
    check(
      'the transcript scrolls instead of growing the page',
      Number.parseFloat(getComputedStyle(thread as Element).overflowY) !== 0 ||
        getComputedStyle(thread as Element).overflowY === 'auto',
      `overflow-y = ${getComputedStyle(thread as Element).overflowY}`,
    );
  }
}

/**
 * Wait until the app itself is up.
 *
 * After a reload the harness's next pass starts immediately, while `main.tsx` is
 * still opening storage, reading settings and rendering. Navigating before the shell
 * exists means driving a page that is not there yet, and a read issued in that window
 * can sit behind the boot's own database work — which surfaces as a page stuck on its
 * loading state rather than as an obvious failure. Waiting is also what makes the next
 * failing check meaningful: if the app never becomes ready, that is the finding.
 */
async function appReady(check: (name: string, ok: boolean, detail?: string) => void) {
  const ready = await waitUntil(
    () =>
      document.querySelector('#root .app-shell') !== null ||
      document.querySelector('#root .splash') === null,
    20000,
  );
  check(
    'the app finished booting',
    ready,
    ready ? undefined : `still on: ${appText().slice(-60).replace(/\n/g, ' / ')}`,
  );
  // Then let it settle. The shell renders before the first screen has read its data,
  // and driving the app inside that window races its own opening reads.
  await tick(700);
}

/**
 * Walk the first-run permission screen.
 *
 * A fresh profile has no onboarding stamp, so the very first visit lands here — which
 * is exactly what a new install does. The two permission cards are asserted, then the
 * flow is skipped rather than granted: a headless browser cannot answer a real
 * permission prompt, and "the user said not now" is a path the app has to survive
 * anyway.
 */
async function completeWelcome(check: (name: string, ok: boolean, detail?: string) => void) {
  const onWelcome = await waitForText('Camera and photos', 6000);
  if (!onWelcome) {
    // An install that already finished onboarding skips straight to Home.
    check('first run shows the permission walkthrough', false, window.location.hash);
    return;
  }
  const text = appText();
  check('first run shows the permission walkthrough', true);
  check(
    'the walkthrough explains the camera before asking',
    /photograph a meal/i.test(text),
    firstMatch(text, /Optional:[^.]*\./),
  );

  clickByText('button', 'Next');
  const second = await waitForText('Notifications', 4000);
  check('the second step asks for notifications', second);
  check(
    'the walkthrough explains what notifications are for',
    /reminders you set yourself|reminders/i.test(appText()),
    firstMatch(appText(), /Optional:[^.]*\./),
  );

  clickByText('button', 'Start logging');
  const home = await waitUntil(() => /Start workout/i.test(appText()), 6000);
  check('finishing the walkthrough lands on Home', home, window.location.hash);
  check(
    'the walkthrough is not shown twice',
    (await repositories().settings.get()).onboardedAt !== null,
    `onboardedAt = ${String((await repositories().settings.get()).onboardedAt)}`,
  );
}

/**
 * Meals: create one by hand, edit it, then delete it.
 *
 * The point is the whole path through the real UI — link → form → validation →
 * storage → list → delete — rather than a repository call.
 */
async function runMealChecks(check: (name: string, ok: boolean, detail?: string) => void) {
  await goTo('/meals');
  const mealsRendered = await waitForAnyText(['No meals logged', 'Log meal', 'Loading…'], 6000);
  check('meals page renders', /log meal/i.test(mealsRendered), firstMatch(mealsRendered, /.{0,40}/));

  const before = await repositories().meals.count();
  clickByTextStartingWith('button', '+');
  const editorShown = await waitForText('Food or dish', 5000);
  check('the meal editor opens from the meals page', editorShown, window.location.hash);

  // Fill the manual form exactly as a person would.
  const typedName = setReactInputValue('meal-name', 'Smoke chicken rice');
  const typedPortion = setReactInputValue('meal-portion', '1 bowl');
  const typedCalories = setReactInputValue('meal-kcal', '650');
  const typedProtein = setReactInputValue('meal-protein', '42');
  check(
    'the meal form accepts typed input',
    typedName && typedPortion && typedCalories && typedProtein,
  );
  await tick(120);

  const totalsShown = appText();
  check(
    'the totals card tracks the typed macros',
    /650/.test(totalsShown) && /42/.test(totalsShown),
    firstMatch(totalsShown, /\d+ kcal/),
  );

  clickByText('button', 'Confirm and save');
  const saved = await waitUntil(async () => (await repositories().meals.count()) === before + 1, 6000);
  check('saving the form writes exactly one meal', saved, `${await repositories().meals.count()} meals`);

  const stored = (await repositories().meals.all()).find(
    (meal) => meal.name === 'Smoke chicken rice',
  );
  check('the meal is stored with its typed values', stored !== undefined);
  check('the typed calories reached storage', stored?.calories === 650, `${stored?.calories}`);
  check('the typed protein reached storage', stored?.proteinG === 42, `${stored?.proteinG}`);
  check('a manually entered meal is marked as manual', stored?.source === 'manual');
  check(
    'the photo is optional',
    stored?.imageKey === null,
    `imageKey = ${String(stored?.imageKey)}`,
  );

  const listed = await waitForText('Smoke chicken rice', 5000);
  check('the saved meal appears in the list', listed);
  check(
    'the list header totals the day',
    /\d+\s*kcal/i.test(appText()),
    firstMatch(appText(), /[\d,]+\s*kcal/i),
  );

  // Edit through the row's own Edit link.
  if (stored) {
    await goTo(`/meals/${stored.id}`);
    const reopened = await waitForText('Edit meal', 5000);
    check('a saved meal reopens in the editor', reopened);
    setReactInputValue('meal-kcal', '700');
    await tick(100);
    clickByText('button', 'Confirm and save');
    const updated = await waitUntil(async () => {
      const row = await repositories().meals.get(stored.id);
      return row?.calories === 700;
    }, 6000);
    check('editing a meal updates it in place', updated, 'calories 650 → 700');
  }

  // Delete: the row button opens a confirm dialog, which must be the only writer.
  await goTo('/meals');
  await waitForText('Smoke chicken rice', 5000);
  const countBeforeDelete = await repositories().meals.count();
  clickByText('button', 'Delete');
  const confirmShown = await waitForText('Delete this meal?', 4000);
  check('deleting a meal asks first', confirmShown);
  check(
    'the meal still exists while the dialog is open',
    (await repositories().meals.count()) === countBeforeDelete,
  );
  clickByText('button', 'Delete meal');
  const deleted = await waitUntil(
    async () => (await repositories().meals.count()) === countBeforeDelete - 1,
    6000,
  );
  check('confirming removes the meal', deleted, `${await repositories().meals.count()} meals`);
}

/**
 * Vision: a photo plus a model the app knows is text-only must produce the
 * vision-specific explanation — and the manual form must stay usable.
 *
 * The image is written through the repository rather than the file picker, because
 * a native file dialog cannot be driven from a headless page. Everything after that
 * point is the real UI: the photo renders, and pressing Analyse runs the real
 * capability check before any request is made.
 */
async function runVisionChecks(check: (name: string, ok: boolean, detail?: string) => void) {
  // A 1×1 PNG: enough to render an <img> and to satisfy the code path that stores
  // and loads a photo, without shipping a fixture file.
  const onePixelPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const meal = await repositories().meals.save({
    ...createEmptyMeal({ source: 'manual' }),
    name: 'Photo meal',
    calories: 100,
    proteinG: 1,
    carbsG: 1,
    fatG: 1,
  });
  const imageKey = await repositories().meals.saveImage(meal.id, onePixelPng);
  await repositories().meals.save({ ...meal, imageKey });

  /*
   * Configure a text-only model through the real Settings screen.
   *
   * Writing the settings record directly would be invisible to the running app: the
   * provider reads preferences once, when it mounts, so the meal screen would still
   * be looking at the previous model. Driving the form is both the honest end-to-end
   * path and the only one that updates what the page sees.
   */
  await goTo('/settings');
  await waitForText('Enable AI', 5000);
  clickByAriaLabel('Enable AI');
  const aiFieldsAppeared = await waitUntil(
    () => document.getElementById('ai-model') !== null,
    5000,
  );
  check('the AI fields appear once AI is enabled', aiFieldsAppeared, window.location.hash);
  setReactInputValue('ai-base-url', 'https://example.invalid/v1');
  setReactInputValue('ai-model', 'deepseek-chat');
  await tick(150);
  const configured = await waitUntil(async () => {
    const stored = await repositories().settings.get();
    return stored.aiEnabled && stored.aiModel === 'deepseek-chat';
  }, 5000);
  check('the configured model is saved', configured, (await repositories().settings.get()).aiModel);

  await goTo(`/meals/${meal.id}`);
  const photoShown = await waitUntil(
    () => document.querySelector('#root img.meal-photo') !== null,
    6000,
  );
  check('a stored photo renders in the meal editor', photoShown);
  check(
    'an analyse button is offered for a photo',
    findButton('Analyse with AI') !== null || findButton('Re-analyse') !== null,
  );

  // A model the app is confident about is flagged before anything is sent.
  const warnedUpFront = await waitUntil(() => /does not accept images/i.test(appText()), 6000);
  check(
    'a photo with a text-only model is flagged before any request',
    warnedUpFront,
    `model=${(await repositories().settings.get()).aiModel} · ` +
      `banners=${[...document.querySelectorAll('#root .banner')]
        .map((node) => (node.textContent ?? '').trim().slice(0, 60))
        .join(' || ') || '(none)'}`,
  );

  const before = await repositories().meals.get(meal.id);
  clickByTextStartingWith('button', 'Analyse');
  const explained = await waitUntil(
    () => /does not accept images/i.test(appText()),
    6000,
  );
  const visionText = appText();
  check(
    'a text-only model is told apart from a failed request',
    explained,
    firstMatch(visionText, /[^.]*accept images[^.]*\./),
  );
  check(
    'the vision message names the configured model',
    visionText.includes('deepseek-chat'),
    firstMatch(visionText, /deepseek-chat/),
  );
  check(
    'the vision message offers the way forward',
    /log the meal by hand|Pick a multimodal model/i.test(visionText),
  );
  // Nothing may be overwritten or sent when the check fails early.
  const after = await repositories().meals.get(meal.id);
  check(
    'a blocked analysis changes nothing',
    after?.calories === before?.calories && after?.source === before?.source,
    `source=${after?.source} kcal=${after?.calories}`,
  );
  // Manual editing is still available on the same screen.
  const stillEditable = setReactInputValue('meal-name', 'Photo meal renamed');
  await tick(80);
  check('the manual form still works after a blocked analysis', stillEditable);
  check(
    'the manual edit is applied locally',
    (document.getElementById('meal-name') as HTMLInputElement | null)?.value ===
      'Photo meal renamed',
  );

  // The settings screen states the same capability, so the user can act on it.
  await goTo('/settings');
  const settingsText = await waitForAnyText(['Image analysis', 'Model', 'Settings'], 6000);
  check(
    'settings reports the vision capability of the configured model',
    settingsText.includes('Image analysis') && /does not accept images/i.test(settingsText),
    firstMatch(settingsText, /This model[^.]*\./),
  );
  check(
    'the capability is shown as a value, not as a vague warning',
    (document.querySelector('#root .badge.warn')?.textContent ?? '').trim() === 'unsupported',
    `badge = ${(document.querySelector('#root .badge.warn')?.textContent ?? '(none)').trim()}`,
  );

  // Clean up so later checks see the meals list they expect.
  await repositories().meals.remove(meal.id);
}

/** Language: switching must change the whole UI immediately, with no reload. */
async function runLocaleChecks(check: (name: string, ok: boolean, detail?: string) => void) {
  await goTo('/settings');
  await waitForText(translate('en', 'settings.title'), 5000);

  // The expected strings come from the catalogues themselves, so this asserts that
  // the *running app* agrees with the shipped translations rather than hardcoding
  // a second copy of them here.
  const switchTo = async (label: string, locale: Locale): Promise<boolean> => {
    clickByText('button', label);
    const expectedTitle = translate(locale, 'settings.title');
    return waitUntil(
      () =>
        document.documentElement.lang === locale && appText().includes(expectedTitle),
      6000,
    );
  };

  const assertTranslated = (locale: Locale, note: string) => {
    const text = appText();
    const title = translate(locale, 'settings.title');
    const englishTitle = translate('en', 'settings.title');
    const navLabel = translate(locale, 'nav.settings');
    check(
      `${note} is translated, not partially English`,
      text.includes(title) && title !== englishTitle && !text.includes(englishTitle),
      `${title} · nav ${navLabel} · ${firstMatch(text, /.{0,30}/)}`,
    );
    check(
      `${note} shows the localized navigation`,
      document.querySelector('#root nav')?.textContent?.includes(navLabel) === true,
      `nav = ${(document.querySelector('#root nav')?.textContent ?? '(none)').slice(0, 60)}`,
    );
  };

  const spanish = await switchTo('Español', 'es');
  check('switching to Spanish re-renders the UI without a reload', spanish);
  check(
    'the document language is updated for screen readers',
    document.documentElement.lang === 'es',
    `lang = ${document.documentElement.lang}`,
  );
  assertTranslated('es', 'the Spanish UI');

  const chinese = await switchTo('简体中文', 'zh-CN');
  check('switching to Chinese re-renders the UI without a reload', chinese);
  assertTranslated('zh-CN', 'the Chinese UI');

  // A second page in the same session, so a screen that was never wired to the
  // catalogue would show up here.
  await goTo('/meals');
  const mealsTitle = translate('zh-CN', 'meals.title');
  const mealsInChinese = await waitForAnyText([mealsTitle, '失败'], 5000);
  check(
    'a second page is translated too, so no screen was missed',
    mealsInChinese.includes(mealsTitle),
    firstMatch(mealsInChinese, /[\u4e00-\u9fff]{2,8}/),
  );

  // Back to English for every later assertion in this run.
  await goTo('/settings');
  await waitForText(translate('zh-CN', 'settings.title'), 5000);
  const backToEnglish = await switchTo('English', 'en');
  check(
    'switching back to English works',
    backToEnglish && (await waitForText(translate('en', 'settings.title'), 5000)),
  );
  check(
    'the language choice is persisted, not just applied in memory',
    (await repositories().settings.get()).language === 'en',
  );
}

/** Theme: the picker must change the tokens, the data attribute and the mascot. */
async function runThemeChecks(check: (name: string, ok: boolean, detail?: string) => void) {
  await goTo('/settings');
  await waitForText('Theme', 5000);

  const readTokens = () => {
    const style = window.getComputedStyle(document.documentElement);
    return {
      theme: document.documentElement.dataset['theme'] ?? '',
      accent: style.getPropertyValue('--accent').trim(),
      background: style.getPropertyValue('--bg').trim(),
      mascotPixels: document.querySelectorAll('#root .theme-option svg rect').length,
    };
  };

  const before = readTokens();
  check(
    'the theme picker renders a mascot per theme',
    before.mascotPixels >= 4 * 20,
    `${before.mascotPixels} pixel rects across the picker`,
  );
  check(
    'the active theme is published on the document',
    before.theme !== '',
    `data-theme = ${before.theme}`,
  );
  check(
    'a fresh install wears the app mascot theme',
    before.theme === 'ragdoll',
    `data-theme = ${before.theme}`,
  );

  // The scenery is theme-linked, not just recoloured: the drawing itself must
  // change. Only pixels can tell the difference, so the ink is compared.
  const signatures: Record<string, string> = {};

  const readScenery = async (themeId: string): Promise<string> => {
    await goTo('/');
    await waitUntil(() => document.querySelector('#root .scenery-art rect') !== null, 5000);
    const signature = scenerySignature();
    signatures[themeId] = signature;
    return signature;
  };

  const ragdollScenery = await readScenery('ragdoll');
  check(
    'the home card is decorated with the theme scenery',
    ragdollScenery !== '',
    ragdollScenery || '(no scenery)',
  );

  await goTo('/settings');
  await waitForText('Theme', 5000);

  clickByAriaLabel('Panda');
  const pandaApplied = await waitUntil(
    () => document.documentElement.dataset['theme'] === 'panda',
    4000,
  );
  const panda = readTokens();
  check('choosing a theme applies it immediately', pandaApplied, `data-theme = ${panda.theme}`);
  check(
    'the theme changes the colour tokens',
    panda.accent !== before.accent || panda.background !== before.background,
    `${before.accent || '(none)'} → ${panda.accent || '(none)'}`,
  );
  check(
    'the chosen theme is persisted',
    (await repositories().settings.get()).theme === 'panda',
  );
  const pandaScenery = await readScenery('panda');

  await goTo('/settings');
  await waitForText('Theme', 5000);
  clickByAriaLabel('Orca');
  const orcaApplied = await waitUntil(
    () => document.documentElement.dataset['theme'] === 'orca',
    4000,
  );
  const orca = readTokens();
  check('a third theme is reachable', orcaApplied, `data-theme = ${orca.theme}`);
  check(
    'each theme has its own palette',
    orca.accent !== panda.accent || orca.background !== panda.background,
    `${panda.accent} → ${orca.accent}`,
  );
  const orcaScenery = await readScenery('orca');

  check(
    'each theme draws its own scenery, not a recoloured copy',
    ragdollScenery !== pandaScenery &&
      pandaScenery !== orcaScenery &&
      ragdollScenery !== orcaScenery,
    `ragdoll=${ragdollScenery} panda=${pandaScenery} orca=${orcaScenery}`,
  );

  // Gender must never be part of the theme: the profile has no theme field and the
  // settings record has no gender field.
  const settings = await repositories().settings.get();
  const profile = await repositories().profile.get();
  check(
    'the theme is independent of the profile',
    !('gender' in settings) && !('theme' in profile),
    `settings.gender=${'gender' in settings} profile.theme=${'theme' in profile}`,
  );

  await goTo('/settings');
  await waitForText('Theme', 5000);
  clickByAriaLabel('Ragdoll');
  await waitUntil(() => document.documentElement.dataset['theme'] === 'ragdoll', 4000);
  check(
    'the picker can go back to the app mascot theme',
    document.documentElement.dataset['theme'] === 'ragdoll',
    `data-theme = ${document.documentElement.dataset['theme']}`,
  );
}

/**
 * A cheap fingerprint of the scenery currently on screen.
 *
 * Counting pixels is not enough — every theme has the same number of cells — so the
 * fill of each drawn pixel is folded into the signature. Two themes can only share a
 * signature if they draw the same shapes in the same colours.
 */
function scenerySignature(): string {
  const rects = [...document.querySelectorAll('#root .scenery-art rect')];
  if (rects.length === 0) return '';
  let hash = 0;
  for (const rect of rects) {
    const fill = rect.getAttribute('fill') ?? '';
    for (let index = 0; index < fill.length; index++) {
      hash = (hash * 31 + fill.charCodeAt(index)) | 0;
    }
  }
  return `${rects.length}:${hash}`;
}

/**
 * Layout: exactly one navigation for the current width, and nothing overflowing.
 *
 * `scripts/smoke.ps1` runs the whole suite at two viewport widths, so this asserts
 * the phone layout on one run and the side-rail layout on the other.
 */
function runLayoutChecks(check: (name: string, ok: boolean, detail?: string) => void) {
  const facts = readLayoutFacts();
  const describe =
    `width=${facts.width} rail=${facts.railVisible} bottomNav=${facts.bottomNavVisible} ` +
    `overflow=${facts.overflowPx}px wide=${facts.wideBreakpointMatches} ` +
    `page=${facts.pageWidth}px themeCols=${facts.themeColumns}`;

  check(
    'exactly one navigation is shown for this width',
    facts.railVisible !== facts.bottomNavVisible,
    describe,
  );
  check(
    'the navigation matches the wide breakpoint',
    facts.wideBreakpointMatches ? facts.railVisible : facts.bottomNavVisible,
    describe,
  );
  check('nothing overflows horizontally', facts.overflowPx <= 1, describe);

  // The measure is what keeps a long line readable: content fills a phone, and is
  // capped and centred once there is room to spare.
  if (facts.wideBreakpointMatches) {
    check(
      'content is capped and centred on a wide screen',
      facts.pageWidth > 0 && facts.pageWidth < facts.width - 40,
      describe,
    );
    check(
      'a wide screen gets more than one column where a grid is used',
      facts.themeColumns >= 2,
      describe,
    );
  } else {
    check(
      'content uses the full width on a phone',
      facts.pageWidth === 0 || facts.pageWidth > facts.width - 80,
      describe,
    );
  }
}

/**
 * Navigate the hash router.
 *
 * `location.hash` already implies the `#`, so assigning `'#/rules'` would produce
 * `##/rules` and match no route. Always route through here.
 */
async function goTo(path: string): Promise<void> {
  window.location.hash = `#${path}`;
  // Let the router commit the new tree before asserting on it.
  await tick(60);
}

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Poll until the stored workout count reaches `expected`, and report what it is. */
async function waitForCount(expected: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = await repositories().training.count();
  while (count !== expected && Date.now() < deadline) {
    await tick(100);
    count = await repositories().training.count();
  }
  return count;
}

/**
 * Set a React-controlled input's value the way a user would.
 *
 * React tracks the previous value on the DOM node, so assigning `.value` directly
 * is ignored. Going through the native setter and dispatching `input` is what makes
 * React's onChange fire — this is the only reliable way to drive a form without a
 * test framework.
 */
function setReactInputValue(id: string, value: string): boolean {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return false;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Same trick as `setReactInputValue`, for an element rather than an id. */
function setReactInputValueByElement(element: HTMLInputElement, value: string): boolean {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return false;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Same trick as `setReactInputValue`, for a textarea. */
function setReactTextareaValue(id: string, value: string): boolean {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLTextAreaElement)) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) return false;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Click the first button whose visible text matches. */
function clickByText(selector: string, text: string): boolean {
  const candidates = [...document.querySelectorAll(selector)];
  const target = candidates.find((node) => (node.textContent ?? '').trim() === text);
  if (!(target instanceof HTMLElement)) return false;
  target.click();
  return true;
}

/** Click the first button whose visible text starts with `prefix`. */
function clickByTextStartingWith(selector: string, prefix: string): boolean {
  const candidates = [...document.querySelectorAll(selector)];
  const target = candidates.find((node) => (node.textContent ?? '').trim().startsWith(prefix));
  if (!(target instanceof HTMLElement)) return false;
  target.click();
  return true;
}

/**
 * Click a button by text inside a specific container.
 *
 * Needed whenever a dialog repeats a word that is also on the page behind it — a row
 * "Delete" and a confirm "Delete" are both matched by a document-wide search, and the
 * first one wins, which re-opens the dialog instead of confirming it.
 */
function clickByTextWithin(container: string, text: string): boolean {
  const scope = document.querySelector(container);
  if (!scope) return false;
  const target = [...scope.querySelectorAll('button')].find(
    (node) => (node.textContent ?? '').trim() === text,
  );
  if (!(target instanceof HTMLElement)) return false;
  target.click();
  return true;
}

/** Find a button by exact visible text, without clicking it. */
function findButton(text: string): HTMLButtonElement | null {
  const candidates = [...document.querySelectorAll('button')];
  const target = candidates.find((node) => (node.textContent ?? '').trim() === text);
  return target instanceof HTMLButtonElement ? target : null;
}

/** Click the first element carrying an exact `aria-label`. */
function clickByAriaLabel(label: string): boolean {
  const target = document.querySelector(`[aria-label="${CSS.escape(label)}"]`);
  if (!(target instanceof HTMLElement)) return false;
  target.click();
  return true;
}

/** Poll a predicate until it is true, then return whether it ever became true. */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await tick(100);
  }
  return predicate();
}

/** Every layout fact the responsive checks need, read from the live viewport. */
interface LayoutFacts {
  width: number;
  railVisible: boolean;
  bottomNavVisible: boolean;
  overflowPx: number;
  wideBreakpointMatches: boolean;
  pageWidth: number;
  themeColumns: number;
}

/** Read what the current viewport actually renders, without mutating anything. */
function readLayoutFacts(): LayoutFacts {
  /**
   * Visibility has to be measured from the rendered box, not from `offsetParent`:
   * the bottom bar is `position: fixed`, and a fixed element reports a null
   * `offsetParent` even while it is on screen and occupying space.
   */
  const isVisible = (selector: string): boolean => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  const page = document.querySelector<HTMLElement>('#root .page');
  const themeOptions = document.querySelector<HTMLElement>('#root .theme-options');
  const columns = themeOptions
    ? window.getComputedStyle(themeOptions).gridTemplateColumns.split(' ').filter(Boolean).length
    : 0;

  return {
    width: window.innerWidth,
    railVisible: isVisible('.app-rail'),
    bottomNavVisible: isVisible('.app-nav'),
    overflowPx: Math.max(
      0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
    wideBreakpointMatches: window.matchMedia('(min-width: 56rem)').matches,
    pageWidth: page ? Math.round(page.getBoundingClientRect().width) : 0,
    themeColumns: columns,
  };
}

/** Text rendered by the app itself. The smoke panel is excluded on purpose. */
function appText(): string {
  return document.getElementById('root')?.innerText ?? '';
}

/**
 * Poll the DOM until `text` appears (the app renders asynchronously).
 *
 * Deliberately scoped to `#root`: the result panel appended by this module also
 * contains the check names, and matching against it would make every assertion
 * pass trivially.
 */
/**
 * Poll until any of `texts` appears in the app, and return the app text then.
 * Used for diagnostics: it can report what the page actually showed.
 */
async function waitForAnyText(texts: string[], timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = appText();
  while (Date.now() < deadline) {
    text = appText();
    if (texts.some((needle) => text.includes(needle))) return text;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return text;
}

/**
 * Poll the DOM until `text` appears (the app renders asynchronously).
 *
 * Deliberately scoped to `#root`: the result panel appended by this module also
 * contains the check names, and matching against it would make every assertion
 * pass trivially. Matching is case-insensitive because CSS uppercases headings.
 */
async function waitForText(text: string, timeoutMs: number): Promise<boolean> {
  const needle = text.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appText().toLowerCase().includes(needle)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return false;
}

function firstMatch(haystack: string, pattern: RegExp): string {
  return pattern.exec(haystack)?.[0] ?? 'no match';
}

function render(checks: Check[], note: string): void {
  const passed = checks.filter((entry) => entry.ok).length;
  const payload = {
    passed,
    failed: checks.length - passed,
    note,
    checks,
  };

  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('pre');
    panel.id = PANEL_ID;
    // Small, corner-pinned and non-interactive on purpose: a full-screen overlay
    // would cover the app, and `innerText` only reports rendered text, so every DOM
    // assertion below would silently read this panel instead of the page.
    panel.style.cssText =
      'position:fixed;right:0;bottom:0;z-index:9999;margin:0;padding:6px;max-width:60vw;' +
      'max-height:40vh;overflow:auto;pointer-events:none;opacity:0.92;' +
      'background:#0f1115;color:#e8eaf0;font:11px ui-monospace,monospace;white-space:pre-wrap;';
    document.body.appendChild(panel);
  }
  panel.textContent = JSON.stringify(payload, null, 1);
  document.title = checks.some((entry) => !entry.ok)
    ? 'SMOKE:FAIL'
    : note === 'done'
      ? 'SMOKE:PASS'
      : 'SMOKE:RUNNING';
}
