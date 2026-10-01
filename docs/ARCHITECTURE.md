# Architecture

FitAGI by Capy — a local-first workout and meal tracker. Android-first, built with Capacitor +
React + TypeScript + Vite. No account, no server, no cloud sync, no telemetry.

The product was called *Fitness Agent* before 0.8.0. Four identifiers still carry the old name on
purpose, because they are how existing data is found rather than how the app introduces itself: the
backup format marker `fitness-agent-backup`, the IndexedDB database `fitness-agent`, the SQLite file
`fitness_agent`, and the Android package `app.fitnessagent.tracker`. Renaming any of them would
orphan data that already exists on a device. The names a user sees in a file list did change, to
`fitagi-*`.

## Layers

```
src/
  domain/        Pure data model and math. No I/O, no React, no storage.
  storage/       StorageAdapter abstraction + IndexedDB and SQLite implementations.
  repositories/  One class per concern, the only thing pages talk to.
  services/      Cross-cutting logic that reads several repositories (outlier checks, backup,
                 image compression, meal analysis), plus `nativeShell.ts` for the two places
                 that talk to the Android shell (status bar, hardware back button).
  state/         React context: preferences + language + profile, active workout session, toasts.
  theme/         Theme tokens, the pixel mascots and the per-theme motifs + scenes. Data only.
  i18n/          Translation catalogues, locale detection, the active-locale mirror.
  styles/        The stylesheet: token variables, a fluid type scale, the breakpoints.
  components/    Reusable UI (sheet, fields, exercise card, pickers, pixel-art renderer).
  pages/         One component per route.
  dev/           Opt-in browser smoke test. Never part of the normal boot path.
```

Dependencies point one way: `pages → state → repositories → storage → domain`.
`domain` depends on nothing, which is why it is trivially testable. `theme` and `i18n` are leaves as
well: the catalogues are plain nested objects, and `theme/tokens.ts` depends only on the sprite data
and the `ThemeId` type, so a component can read either without pulling in storage or React state.

## Data model

`src/domain/types.ts` is the single source of truth.

```
Workout
  id, startTime, endTime|null, durationSec, notes, heartRate|null
  completed            false while the session is still being recorded
  exercises: ExerciseEntry[]
  createdAt, updatedAt

ExerciseEntry
  id, workoutId
  rawName              exactly what the user typed, never rewritten
  normalizedName       display/canonical name after alias rules
  order                0-based, contiguous
  notes, sets: SetEntry[], supersetGroup|null

SetEntry
  weight|null, weightKg|null, unit      entered value + canonical kg value
  reps|null, durationSec|null, distance|null, distanceUnit|null
  restSec|null, rpe|null, rir|null
  isFailure, isWarmup, isDropSet, notes
```

Derived types that are **not** sources of truth:

- `TrainingSummary` (`kind: 'daily' | 'weekly' | 'monthly'`) — belongs to `SummaryRepository`.
  Deleting a summary never touches a workout.
- `Settings` — one document, including the optional AI configuration, the theme, the language
  preference and the vision override.
- `AliasRule` — user-owned `{ match, normalized }` rename rules.
- `UserProfile` — one optional document. Every field is nullable; the app is fully usable with
  none of it filled in.

Meals are their own aggregate, next to workouts rather than inside them:

```
Meal
  id, eatenAt, name, portion
  items: MealItem[]      one food per row, each with its own figures
  calories, proteinG, carbsG, fatG
  notes, source, confidence, imageKey, aiNote
  createdAt, updatedAt

MealItem
  id, name, portion, calories, proteinG, carbsG, fatG
```

- `source` is `manual | ai | ai-edited`, and `confidence` is the model's own
  `high | medium | low`. They exist because nutrition from a photo is an **estimate**: the UI has
  to be able to say where a number came from instead of presenting it as measured.
- A meal's totals are always the sum of its items (`sumItems`), so the headline figure and the
  breakdown on screen cannot disagree. A value that is unknown stays `null` rather than becoming
  `0`, so "not known" never renders as "zero calories".
- `imageKey` names a row in the `images` key/value store, not a path: there is no filesystem
  involved and no orphaned file to clean up.

Design rule: *structure what is certain, keep the fuzzy parts as text.* There is deliberately no
bundled exercise library and no attempt to model every fitness semantic up front.

### Units

`weight` + `unit` are what the user typed and are never rewritten. `weightKg` is the canonical
value used for comparison, volume and 1RM. Switching the display unit changes rendering only;
history keeps the unit each set was logged in. `withSetWeight()` in `src/domain/workout.ts` is the
only function that writes `weightKg`, so the two can never drift.

## Storage

`StorageAdapter` (`src/storage/adapter.ts`) is a deliberately narrow contract:

- `collection<T>(name)` → `all / get / put / putMany / remove / clear / count`
- `kv(name)` → `get / set / remove`

Two implementations:

| Adapter | Used by | Notes |
| --- | --- | --- |
| `IndexedDbAdapter` | browser dev + fallback | `DB_VERSION = 4`. Collections `workouts`, `rules`, `summaries`, `meals`, `reminders`, `plans`; key/value stores `settings`, `presets`, `images`, `profile`, `aiChat`. |
| `SqliteAdapter` | Android (production) | `@capacitor-community/sqlite`, `SCHEMA_VERSION = 4`. Tables `workouts`, `alias_rules`, `summaries`, `meals`, `reminders`, `plans`, `settings`, `presets`, `profile`, `images`, `ai_chat`, `meta`. |

The store names are enumerated once, in the `CollectionName` and `KeyValueName` unions in
`src/storage/adapter.ts`, so a new collection cannot be added for one backend only. The SQLite schema
also creates a `meta` table that the adapter never reads or writes; it is reserved, not part of the
app's contract.

Each concern owns its own store:

| Store | Holds | Why it is separate |
| --- | --- | --- |
| `workouts` | Workout aggregates | The raw record. Never deleted by a migration. |
| `rules` | Alias rules | User-owned; resolution must not depend on a workout scan. |
| `summaries` | Derived daily/weekly/monthly summaries | Makes "deleting a summary cannot affect raw training data" structural. |
| `meals` | One document per meal | Same local-first contract as workouts. |
| `reminders` | User reminder definitions | The schedule itself lives in the OS; this store is what it is rebuilt from on every boot. |
| `plans` | Weekly training plans | A plan is a template, not a record: deleting one leaves every workout it produced untouched. |
| `images` | One compressed data URL per meal photo | A photo is its own row, so writing a new picture never rewrites the others, and deleting the meal deletes its image. |
| `profile` | The optional user profile | Never required, never blocking. |
| `aiChat` | The latest 100 AI conversation exchanges | Stored locally so follow-ups survive page changes and restarts; separate from workout records and excluded from backups. |
| `settings` / `presets` | Preferences, and the smoke test's run state | `presets` survives a reload exactly like user data does. |

Records are stored as JSON documents (`id`, `json`, plus denormalized columns for ordering and
future analytics). A workout is always read as a whole aggregate, so documents match the access
pattern and keep migrations trivial. If aggregate analytics ever needs real SQL, that work belongs
behind this interface — no page or repository has to change.

The SQLite plugin is imported type-only plus a dynamic runtime import, so it is never part of the
web bundle and browser development needs no native module. The plugin's v7 API is flat — every call
carries `database` (`query({ database, statement, values })`) and there is no connection handle to
keep. `setSqlitePluginForTests()` injects a double so the adapter's real SQL is covered by tests.

`CollectionCache` wraps each collection with an in-memory map. A realistic local history is a few
thousand sessions, so this makes History/Exercise/Home reads effectively free. Key/value stores are
not cached: they hold a handful of documents and are read when a screen needs them.

Because the stores are separate, "deleting a summary cannot affect raw training data" and "deleting a
meal deletes its photo" are structural guarantees rather than conventions.

## Repositories

| Repository | Responsibility |
| --- | --- |
| `TrainingRepository` | Workout aggregates: create, upsert exercise, move, complete, reopen, delete. |
| `ExerciseRepository` | Exercise-centric views folded from workouts: suggestions, history, summary, PR. |
| `RuleRepository` | User alias rules. Longest match wins. |
| `SettingsRepository` | App preferences, one key/value document. `patch()` is a read-merge-write and is **serialised** through an internal promise chain, because the settings screen writes one patch per keystroke and two overlapping patches both start from the same snapshot — the second write used to drop the first change. `ProfileRepository` uses the same queue. |
| `SummaryRepository` | Derived daily, weekly and monthly summaries, in their own collection. |
| `ProfileRepository` | The optional user profile, one key/value document (`settingsRepository.ts`), stored in the `profile` key/value store under the key `userProfile`. |
| `MealRepository` | Meals and their photos: list by day, save, delete (which deletes the image), plus the pure helpers `createEmptyMeal`, `createEmptyMealItem`, `sumItems`, `summarizeDay` and `imageKeyFor`. |
| `ReminderRepository` | Reminder definitions, in their own collection (`planRepository.ts`). Normalises kind, time and weekdays on read, and validates the time format on write. |
| `PlanRepository` | Weekly training plans (`planRepository.ts`), plus `planWeeklySets` and `planTrainingDays`. `save()` enforces **exactly one active plan**, so "which plan am I on" is never ambiguous. |

`buildRepositories()` wires the whole set from a `StorageBundle`; pages call `repositories()` and
never construct one themselves.

Name resolution priority is fixed now so a future LLM can never outrank the user:

1. explicit user alias rule
2. previously confirmed mapping
3. LLM suggestion (asking the model about names no rule covers)
4. the raw name

A rule is created from the rename dialog while logging (`RenameExerciseSheet`) or directly on the
rules page. `RuleRepository.resolve()` matches case-insensitively on substring and prefers the
longest match, so "incline bench" beats "bench". Resolution rewrites `normalizedName` only; `rawName`
keeps the exact text the user typed, which is why a rule can never silently rewrite history.

## Internationalisation

Three locales ship: `zh-CN`, `en`, `es`. Nothing is translated at runtime and no key is resolved by
string search at the call site.

| Module | Responsibility |
| --- | --- |
| `src/i18n/en.ts` | The reference catalogue: one nested object, 28 sections. Every other locale is typed against its shape, so adding a key here without translating it is a compile error. |
| `src/i18n/zh-CN.ts`, `src/i18n/es.ts` | Typed against `en`, so a missing or misspelled key fails the type-check before it can reach a user. `src/test/i18n.test.ts` asserts key parity, identical placeholders and that no long string is still English. |
| `src/i18n/types.ts` | `Messages` (the English shape with literals widened), `MessageKey` (dotted paths to leaves only), `MessageParams`, `Catalogue`. A typo like `home.nope` is a type error, not a blank label. |
| `src/i18n/index.ts` | `translate`, `translatePlural`, `createTranslator` (returns `t`, `tPlural` and the locale's `intlTag`), and `CATALOGUES` — the messages plus the BCP-47 tag used for `Intl`. |
| `src/i18n/locales.ts` | `LOCALES`, `LOCALE_LABELS`, `isLocale`, `localeFromTag` (any Chinese tag or any Spanish tag maps to the one catalogue for that language, everything else to English) and `detectSystemLocale`. |
| `src/i18n/runtime.ts` | A synchronous mirror of the active locale. `AppProvider` writes it on every change; the crash screen reads it, because a class component cannot call a hook and the settings record is only reachable asynchronously. |
| `src/i18n/presets.ts` | Localised starter exercise names. Deliberately **data, not UI copy**: they are written into a workout as exercise names, so they live outside the string catalogue. |

Rules that keep this honest:

- No user-visible string lives in a component; `t('key')` is the only source.
- Only two plural forms are needed (one/other) and all three languages agree on the strings
  involved, so the catalogue carries an explicit `<key>One` variant and `translatePlural` picks it.
  There is no ICU engine.
- An unknown placeholder is left visible as `{count}` rather than replaced with `undefined`: a
  visible placeholder is an obvious bug report, a missing number silently reads as correct.
- `translate` warns in development and falls back to English, then to the key itself — a gap is loud
  rather than invisible.
- Model-generated text (an AI answer, a meal estimate's own note) is shown **verbatim** and is not
  translated. It is the model's wording, not the app's copy.
- Date, time and number formatting go through `Intl` with the locale's `intlTag` (`zh-CN`, `en-US`,
  `es-ES`); `AppProvider` also sets `document.documentElement.lang` so screen readers and font
  selection follow the choice.

Switching language writes `settings.language` (`'system' | 'zh-CN' | 'en' | 'es'`), and the provider
resolves `'system'` on every render rather than storing a resolved value: a device-language change is
picked up without a migration, and an explicit choice is kept forever. Nothing reloads — the
translator is memoised per locale, so a change re-renders the tree and that is all.

## Themes, mascots and scenery

A theme is data. `src/theme/tokens.ts` holds `ThemeTokens` (background, surface, field, text colours,
primary/secondary/accent, semantic colours, status bar), `ThemeDefinition` (id, translation keys for
the name and hint, a three-colour swatch, the tokens), `THEMES` (`ragdoll`, `bunny`, `panda`, `orca`),
`DEFAULT_THEME_ID`, `getTheme`, `getMascot`, `cssVarsFor`, `applyTheme` and `statusBarColor`.

- Components never reference a raw colour and never branch on the theme id; they consume tokens.
  `cssVarsFor()` maps tokens onto the `--*` names the stylesheet already uses, and `applyTheme()`
  writes them onto `:root`, sets `data-theme` and updates the `<meta name="theme-color">` value, so
  the browser chrome follows the theme. `src/styles/global.css` therefore contains no hardcoded
  palette values — only the fallback block that keeps the first paint styled before settings have
  loaded.
- The Android status bar follows the theme through `src/services/nativeShell.ts`, which is called
  from the provider's theme effect: `applyStatusBarForTheme()` sets the bar colour from
  `statusBarColor()` and picks the icon style from the colour's relative luminance
  (`statusBarIconStyle()`, unit tested) rather than from a per-theme table, so a fifth theme needs
  no change there either. The whole module is guarded by `Capacitor.isNativePlatform()` and by
  try/catch: in a browser it does nothing, and a missing plugin must not break the launch path.
- The mascots are self-drawn pixel art. `src/theme/pixel.ts` defines `Palette` and `PixelSprite`
  (a grid of single-character palette keys, `.` for transparent) and is deliberately JSX-free, so
  the sprite data and the tokens can reference the type without pulling a `.tsx` file into
  non-JSX contexts. `src/theme/mascots.ts` holds the four 16×16 character grids (the ragdoll is the
  app's own mascot and the default theme) and `src/components/PixelArt.tsx` renders them as `<rect>`s
  with `shapeRendering="crispEdges"`. There is no image file, no base64 blob and no third-party
  artwork anywhere in the app.

### Scenery: motifs composed into a scene

`src/theme/motifs.ts` gives each theme a small vocabulary — `ground` (tiles along the bottom),
`accents` (standing on it) and `specks` (in the air): grass, flowers and carrots for the bunny;
bamboo and paw prints for the panda; water, fish and bubbles for the orca; paws, yarn and hearts for
the ragdoll. `src/theme/scenery.ts` composes them into one wide sprite and
`src/components/ThemeScenery.tsx` draws it (Home hero card, empty states).

Three details are load-bearing:

- **The composition is one sprite, not a dozen components.** A strip of twelve sprites would be twelve
  layout boxes and twelve SVGs for pure decoration; merging them is a few hundred `<rect>`s in one
  SVG.
- **Palette keys must be one character.** A grid row is a string, so `scene.palette['aG']` can never be
  addressed by `row[i]`. Merging sprites whose palettes share letters (`G` is grass in one and green in
  another) therefore remaps every source key to a unique character from a pool. Getting this wrong
  produces a scene that renders as *nothing*, which is exactly what the first implementation did, so
  `src/test/theme.test.ts` asserts that every composed scene has one-character keys and no
  unresolvable pixels.
- **The arrangement is fixed, not random.** A scene that reshuffles on every render reads as noise
  rather than as design.

The browser smoke test fingerprints the drawn pixels of the scenery on Home across three themes and
asserts they all differ, so "each theme draws its own scenery" cannot silently regress into "each
theme recolours the same scenery".

### The launcher icon and splash

The icon is the hand-drawn ragdoll cat, used as supplied rather than redrawn:
`design/icon-candidates/source/cat-sketch.jpg`. `render-android-icons.ps1` crops it to the 350×350
square that keeps the whole cat and drops the heart and the neighbouring drawing at the right edge,
samples the paper colour from the sketch's own corners, and composites every density with
`System.Drawing` — 48/72/96/144/192 for `ic_launcher` and `ic_launcher_round`, 108/162/216/324/432 for
the adaptive layers. `render-splashes.mjs` renders the splash screens at each density and orientation
from the same crop. Neither step needs an image library or a design tool.

Two structural decisions:

- **The artwork is the adaptive icon's background layer.** The sketch has no transparency, so as a
  foreground layer its white square would sit on the background colour and the seam would be visible.
  As the background it is full bleed; the mask crops paper, not the cat. That inverts the usual
  arrangement (colour background + artwork foreground) and is the reason
  `mipmap-anydpi-v26/ic_launcher.xml` points `<background>` at a bitmap and `<foreground>` at a
  transparent placeholder — which also means the launcher's parallax effect has nothing to move.
- **The cat is 88% of a legacy square icon, 78% of the round one and 78% of the adaptive layer.** The
  guaranteed-visible area of an adaptive icon is the central 72 of 108dp with a circular mask
  inscribed in it; 78% keeps the ears, eyes and nose inside that. A circular mask trims the outermost
  whiskers, because the sketch is drawn edge to edge — the alternative is a cat that looks lost in the
  middle of its own icon.
- **The drawing is deepened on the way in, with an `ImageAttributes.SetGamma(1.35)`.** It is a pale
  pencil sketch and at 48px the fur otherwise disappears into the paper. Gamma was the right knob and a
  contrast curve would have been the wrong one: the fur is a light grey above mid-grey, so more
  contrast pushes it towards white, while gamma darkens the midtones and leaves the near-white paper
  where it is. The padding colour is then re-sampled from the adjusted artwork, so the flat fill and
  the crop's own edge tone agree to within a level or two and there is no visible square where they
  meet.

`design/icon-candidates/alternates/` keeps the vector cat that was drawn first (same family as the
pixel mascots) and `uc-monogram/` the letterform concepts before it; neither ships.

The in-app theme mascot is still pixel art. It is 16×16, it has to match the bunny, panda and orca
sprites, and it sits in a picker next to them — dropping a JPEG sketch into that row would look like a
mistake, so the sketch is the app's identity and the pixel cat is the ragdoll theme's mascot.

- Adding a fifth theme is one `ThemeDefinition`, one sprite and a few motifs; no page, component or
  stylesheet changes. `src/test/theme.test.ts` validates the sprites as data (square grid, every
  palette key
  defined, hex colours, a real outline, panda stays monochrome) and checks text/background contrast
  for every theme.

The theme is presentation only. `settings.theme` and `profile.gender` are independent by
construction: `normalizeSettings()` has no `gender` field and `normalizeProfile()` has no `theme`
field, and both the unit suite and the browser smoke test assert exactly that.

## User profile

`src/pages/ProfilePage.tsx` edits `UserProfile`; `ProfileRepository` stores it as one key/value
document under `profile`. It is optional in the strongest sense: every field can be empty, nothing
gates on it, and an untouched profile is written to a backup as `null` rather than as an empty
object.

`src/services/ai/userContext.ts` turns it into the short block that a model actually sees:

- `resolveMetrics()` resolves height/weight/goal weight into metric values. `unitSystem` decides how
  the stored numbers are *interpreted* (in imperial mode a stored `weightKg: 130` means 130 lb as
  typed), and this is the only place that conversion happens.
- `resolveAge()` prefers a directly entered age and otherwise derives it from the birthday.
  `parsePlainDate()` builds a `YYYY-MM-DD` value from its parts instead of `new Date('2005-06-16')`,
  which JavaScript parses as UTC midnight and which therefore shifts the birthday — and the age — by
  a day in any timezone behind UTC.
- `buildProfileBlock()` emits only the lines that are filled in; a blank profile produces an empty
  string, and `buildUserContext()` then omits the `## User profile` heading entirely rather than
  announcing "Sex: unknown" to a model. The profile screen shows this block verbatim, so what will
  be sent is never a surprise.
- Gender appears here and nowhere else. It is context for the model, never an input to theming or
  behaviour.

## Exercise history

`ExerciseRepository.history(name)` folds every stored workout into `ExerciseHistoryEntry[]`
(newest first, with working-set count, volume and best set), and `summary(name)` reduces that to the
header stats. The `/exercise/:name` page holds no data of its own — it renders those two calls, plus
a dependency-free SVG sparkline of the top set per session.

## Backup and restore

`src/services/backup.ts` owns the format; `src/services/fileTransfer.ts` owns moving bytes in and out
of the device.

```
BackupDocument {
  format: 'fitness-agent-backup', version, exportedAt, app
  settings: Omit<Settings, 'aiApiKey'>   // the key is structurally excluded
  workouts[], aliasRules[], summaries[]
  meals[], reminders[], plans[]
  profile: UserProfile | null
}
```

- The API key is stripped by destructuring in `createBackup`, and `BackupDocument` does not declare
  the field at all. `src/test/helpers/assertBackupSource.ts` asserts both against the source, so
  re-adding the key fails a test rather than leaking quietly.
- `parseBackup` validates strictly (format marker, version, workouts array) and rejects a backup from
  a newer format instead of silently dropping fields. Individual malformed records are filtered out
  so one bad row cannot fail an otherwise good restore.
- `applyBackup` is replace-only: a restore is expected to reproduce the backup exactly, and silently
  merging two divergent histories is how people lose data. Storage caches are invalidated afterwards.
- Meal photos are deliberately **not** in the document: they would dominate its size and they are not
  the record. A restored meal keeps every number and has no image.
- `profile` is `null` when nothing was filled in (`hasProfileContent()`), and a profile-shaped object
  is the only thing accepted on import; anything else becomes `null` rather than being coerced into
  the live profile.
- Export writes to the app cache directory on Android and hands the file to the system share sheet;
  in a browser it is a normal download. Import is always a file picker.

## Migration and backwards compatibility

The app already has installs with stored data, so a new field must never be able to break one.
Three layers handle that, and each is covered by `src/test/migration.test.ts`:

- **Documents.** `normalizeSettings()` and `normalizeProfile()` resolve every field explicitly rather
  than merging blindly: an unknown theme, language, unit, role, gender, goal or activity level falls
  back — to a default, or to `null` for the profile enums, which are optional by nature — an
  implausible figure (a 0 kg bodyweight, a 400-year-old age) becomes `null` rather than a number that
  would quietly corrupt every AI request, and the retired pre-theme `colorScheme` value is simply
  dropped in favour of the default theme. `SettingsRepository.ensureInitialized()` writes the
  normalised document back, so a migration completes instead of being re-derived on every read.
- **Storage.** IndexedDB opens at `DB_VERSION = 4` and SQLite at `SCHEMA_VERSION = 4`. Both upgrades
  are additive: `onupgradeneeded` creates only the object stores that are missing, and the SQLite
  schema is a list of `CREATE TABLE IF NOT EXISTS`. A level-1 database therefore keeps every row it
  had — the test builds one by hand, saves a workout, opens it through the app and asserts the
  workout is still there and that the new stores work. `meals` arrived in v2, `reminders` and `plans`
  in v3, and `aiChat` in v4; `src/test/aiConversation.test.ts` walks the v3 → v4 step in the same
  way, and then reopens the connection to assert a stored conversation is still readable.
- **Backups.** A format-version-1 backup has no `meals` and no `profile` and may carry
  `theme: 'dark'`. It still imports: the missing arrays become empty, the profile becomes `null`, the
  retired theme value falls back to the default, and the workouts are restored untouched.

A migration never deletes workout history; nothing in the upgrade path issues a `DELETE` or a
`clear()`.

## Workout recording

`WorkoutSessionProvider` (`src/state/WorkoutSessionContext.tsx`) owns the active session:

- Every edit is applied locally immediately, then written to storage **debounced by 300 ms**, and
  also flushed on unmount and on `visibilitychange`. Closing the app or refreshing the page never
  loses a set.
- The elapsed clock is derived from `startTime` and re-ticks once per second; it is not persisted
  on every tick.
- `finish()` stamps `endTime` and freezes `durationSec`, then the workout becomes History.
- An unfinished workout is found again through `TrainingRepository.inProgress()`, which is how
  Home offers "Resume workout".
- `addSet()` composes the new set (including its id) outside the React state updater, because
  StrictMode invokes updaters twice and id generation must happen exactly once.

### Leaving, finishing and discarding

A draft is written to storage the moment a workout starts, so there are three distinct exits and the
difference between them matters:

- **Home** (the header button) only navigates away. The draft stays in storage and Home offers
  "Resume workout", which is what makes it safe to leave mid-session.
- **Finish & save** runs the outlier review, then `finish()` stamps the end time and the workout
  becomes History.
- **Discard workout** is the only way to remove a draft. It is offered inside the finish sheet, asks
  for confirmation, and then calls `WorkoutSessionContext.discard()`: the pending debounced write is
  dropped *before* the delete, so the timer cannot re-create the row just after it was removed.
  Without that ordering, walking away from a session would leave an unfinished workout on Home
  forever with no way to get rid of it.

A workout that was saved by mistake is not discarded but deleted, from its detail page
(`/history/:id`), which is also where **Reopen as in-progress** lives — "finished" is a state, not a
lock.

## Outlier detection

`findAnomalies()` in `src/services/validation.ts` compares each logged weight against the median of
the same exercise's past sessions. It needs at least 3 prior sessions before saying anything, and it
only *flags*:

- it never blocks saving,
- it never rewrites a value (600 kg is not silently changed to 60 kg).

The confirm/edit/ignore UI built on top of it is the Outlier review section below.

## Reminders

A reminder is a small document (`src/repositories/planRepository.ts`) plus a promise the
**operating system** keeps. The app owns the list, the OS owns the schedule, and the two drift on
their own — a reboot drops alarms, a permission granted later changes what can be scheduled, a
restored backup arrives with no schedule at all. Rather than track every way they can diverge,
`src/services/reminderScheduler.ts` rebuilds the whole schedule from storage:

- `sync()` clears everything this app scheduled and re-adds the enabled reminders. It is idempotent,
  so it is called on boot (from the provider, once settings are ready), after a permission grant, and
  after an import.
- The notification id is a hash of the reminder id (`notificationIdFor`), which makes a reschedule
  replace rather than duplicate. A weekly reminder on three weekdays takes three ids, offset from the
  base.
- An edit cancels before it schedules: on some Android versions `schedule()` with an existing id is
  not a replace, and a duplicate reminder is worse than a missed one.
- Every entry point is guarded by `Capacitor.isNativePlatform()` and try/catch. In a browser the
  module is inert, which is what lets the whole flow — including the permission step — run in the
  smoke test with the Web Notifications API standing in.

Normalisation lives in the repository, not at the call sites, because a reminder can arrive from
three places: the editor, an AI proposal, and a backup file. An unknown kind becomes `custom`, an
impossible time becomes the default, and weekdays are deduplicated, sorted and range-checked — so a
malformed file cannot hand the OS a schedule it would reject.

## Training plans

A plan is a week of *intentions*. It never touches the workout history: starting a session from a
plan copies the day's exercises into a **new workout** (`createWorkout` + `upsertExercise`), which
the user then logs normally. A plan that turns out to be wrong therefore costs an edit and nothing
else, and deleting a plan leaves every workout recorded from it intact.

- `PlanRepository.save()` enforces "exactly one active plan" rather than trusting the page: the Home
  card and the prefill both need a single answer to "what am I on this week".
- A `reps` prescription is **text** (`"8-10"`, `"5"`, `"AMRAP"`) because that is what a programme
  actually says. When a session is started from a plan, only a leading number becomes a repetition
  count and the rest is left for the user — guessing at "AMRAP" would put a wrong number in the log.
- Target weights are stored in kg like every other weight, so switching the display unit never
  rewrites a plan.

## First-run onboarding

`settings.onboardedAt` is null on a fresh install, which is what routes the app to `/welcome`; the
screen asks for camera and photos, then notifications, explaining each before requesting it, and both
steps can be skipped.

Two details are load-bearing:

- **The gate waits for settings to load.** `AppProvider` starts from `DEFAULT_SETTINGS`, whose
  `onboardedAt` is null, and it exposes a `ready` flag. Without waiting on it the welcome branch
  renders for a moment on *every* boot — and because that branch ends in
  `<Navigate to="/welcome" replace />`, it rewrote the URL: a deep link into the app landed on Home.
- **"Not a string" is not the same as "field absent".** A fresh install stores an explicit
  `onboardedAt: null`, and an install from before this screen has no field at all. Treating both as
  "old document" stamped the fresh install as legacy, so the walkthrough never appeared — the first
  read that raced `ensureInitialized`'s own write was enough to trigger it. `normalizeSettings` now
  distinguishes the three cases (timestamp / explicit null / absent) and `src/test/reminders.test.ts`
  pins all of them.

## AI layer (optional)

Everything lives under `src/services/ai/`. Nothing outside that folder knows which vendor
is in use, and no page has to special-case "AI is disabled".

| Module | Responsibility |
| --- | --- |
| `provider.ts` | `LlmProvider` interface, `LlmConfig`, `ChatMessage`/`ContentPart` (text and image parts only), draft/suggestion types, and a `DisabledLlmProvider` that explains how to turn AI on instead of throwing at call sites. |
| `openaiProvider.ts` | `POST {baseUrl}/chat/completions`. `fetch` is injectable, so the client is fully testable offline. Messages are posted as given, which is what lets a multimodal message through unchanged. |
| `prompts.ts` | System prompts for the three roles plus the parse/normalize/summarize prompts. |
| `localParser.ts` | The offline parser. Chinese and English, mixed freely. |
| `proposals.ts` | `proposeReminders` and `proposePlan`: the two places the model is allowed to *suggest* something the user then edits. Both validate every field and return proposals only — nothing in this module writes to storage. |
| `contextBuilder.ts` | Assembles the smallest context that can answer the question. |
| `materialize.ts` | Turns a *confirmed* draft into records. |
| `vision.ts` | Model capability detection: `supported` / `unsupported` / `unknown` from model-name families, plus the user override, the `image_url` content part and `looksLikeVisionRejection()`. |
| `mealAnalysis.ts` | Photo → editable meal proposal (`analyseMealPhoto`, `parseAnalysis`, `extractJson`) and the correction loop (`reviseMeal`), with `VisionNotSupportedError` / `VisionRejectedError` as distinct outcomes. |
| `userContext.ts` | The profile → short model context block (`buildUserContext`, `buildProfileBlock`, `resolveMetrics`, `resolveAge`, `parsePlainDate`). |
| `index.ts` | `AiService` facade: settings → provider, and the only place that decides when AI is involved. Also exposes `visionCapability`, `analyseMeal`, `reviseMeal` and `userContext`. Chat requests include up to 8 earlier exchanges with a character cap. |
| `src/repositories/aiConversationRepository.ts` | Saves, loads and clears the latest 100 chat exchanges in the local `aiChat` key/value store. |

### Vision capability

There is no standard way to ask an OpenAI-compatible endpoint whether it accepts images, so
`src/services/ai/vision.ts` gives an explicit three-state answer instead of dressing a guess up as a
fact:

| State | Meaning | What the app does |
| --- | --- | --- |
| `supported` | The model name matches a known multimodal family (or the user overrode the guess). | Sends the image. |
| `unsupported` | The model name matches a family that is definitely text-only (or the user overrode the guess). | Refuses to attach an image at all and says which model is the problem. |
| `unknown` | No reliable signal. | Lets the user try, and reports whatever the endpoint answers. |

- The family lists match substrings, not exact versions, so a new point release cannot silently flip
  a working setup to "unsupported". Vision families are checked first, so `qwen2.5-vl` is not caught
  by a text-only `qwen2.5` entry; the text-only list is kept deliberately short, because a wrong
  entry blocks a working feature.
- `settings.aiVisionOverride` (`true | false | null`) always wins: the person configuring the
  endpoint knows more than a substring table. Settings shows the detected state, the reason and the
  override switch.
- `looksLikeVisionRejection()` recognises a gateway that refuses the image in prose rather than with
  a usable status code — a message mentioning an image/vision/modality *and* a refusal — so
  "400 Bad Request" becomes "this model does not accept images".
- The check runs **before** the request (a text-only model produces an explanation, not an opaque API
  error) and the manual meal form stays usable in every case.

### AI must never be required

- The offline parser is tried **first**; a local match costs no request and cannot
  hallucinate. Only when it produces nothing is the model asked.
- `DisabledLlmProvider` returns the same shapes as the real provider, so Quick Log works
  identically with AI off.
- If the model returns unusable data, the user's text is kept as a workout note rather
  than lost.
- Suggestions are filtered against what the user actually typed, so a hallucinated
  exercise name is dropped instead of offered.

### Nothing writes to the log without confirmation

`draftToPreview` → user edits → `previewToDraft` → `materializeDraft`. The parser has no
access to storage at all; `materialize.ts` is the only module that turns a draft into
records, and it runs after the user presses confirm. That makes "the model never writes to
your log by itself" a structural property rather than a promise.

### Context Builder priority

1. the workout currently being recorded
2. the last 3–5 sessions of the exercises in question
3. the last 7 days of training (a rolling window, not "since Monday"), using the stored
   daily summaries when they exist
4. the weekly rollup — the **stored** summary is preferred, with a live computation as
   fallback so context is never empty just because a summary has not been generated yet
5. the monthly rollup, only when the question is about a longer trend

Context is rendered as compact plain text, not raw JSON: far fewer tokens, easier for a
model to read, and it makes a privacy review trivial. `TrainingContext.sections` records
what was included, and the AI page shows it under every answer.

Before each question, the AI page reads the current in-progress workout and passes its ID
to the builder, so that workout is included. Chat history is stored locally and remains
visible after reopening the page. Requests include at most the latest 8 exchanges, capped
at 16,000 characters. Earlier answers help resolve follow-ups but are not treated as
recorded training facts. The per-answer disclosure includes the conversation history;
chat history is excluded from backups.

### Roles

`recorder` parses and looks up without advising; `reminder` reports what was actually
logged; `coach` may advise but must keep recorded facts and hypothetical progression targets
separate. Coach headings follow the language of the latest question. Exact suggested targets are
allowed only when grounded in a relevant recorded baseline and are labelled as proposals; without
that baseline the coach asks a short question or gives a non-numeric option. The prompt also rejects
max attempts, forced reps, training through pain, diagnosis and rehabilitation advice.

The profile block is attached to **meal** requests only. The training context builder is unchanged
and does not include it, so a question about training is answered from training data.

## Meals

```
/meals          MealsPage        grouped by local day, paged 40 at a time, searchable
/meals/new      MealDetailPage   editor; the same component edits an existing meal
/meals/:mealId  MealDetailPage   loads the meal and its stored photo
```

The flow is `photo → analysis → editable result → correction loop → confirm → save`, and two
properties hold at every step:

- **Nothing reaches storage until the user confirms.** The analysis produces a draft held in
  component state; only `save()` writes, and it is the only writer of the image as well.
- **Every field is editable directly.** The chat correction is an accelerator, not a gate: with AI
  off, or by preference, the whole form can be filled by hand.

| Module | Responsibility |
| --- | --- |
| `src/repositories/mealRepository.ts` | `MealRepository` (`all`, `get`, `forDate`, `between`, `count`, `save`, `putMany`, `remove`, `clear`, plus `saveImage` / `loadImage` / `removeImage`), and the pure helpers `createEmptyMeal`, `createEmptyMealItem`, `sumItems`, `summarizeDay`, `imageKeyFor`. |
| `src/services/imageInput.ts` | `pickImage(source)` opens a hidden `<input type="file">`, with `capture="environment"` when the source is the camera, and `compressImage()` downscales to a 1280 px longest edge and re-encodes as JPEG at quality 0.72 through a canvas, so no image library ships. A user who cancels the picker gets `null`, which is not an error. |
| `src/services/ai/mealAnalysis.ts` | The two prompts (`MEAL_ANALYSIS_SYSTEM`, `MEAL_REVISION_SYSTEM`), `analyseMealPhoto()`, `reviseMeal()` and the tolerant JSON parsing. |

Decisions worth keeping:

- **A photo is its own row.** `imageKeyFor(mealId)` is deterministic (`image:<mealId>`), so a meal has
  at most one photo and re-analysing replaces it instead of orphaning the old one. Writing a new
  picture never rewrites anyone else's.
- **Deleting a meal deletes its photo**, and `MealRepository.clear()` walks the meals first: wiping
  the collection is not enough when the images live in another store.
- **Totals come from the items.** `sumItems()` is used both when the model returns items and after a
  manual item edit, so the headline figure and the breakdown on screen can never disagree. A value
  that is unknown everywhere stays `null` — "unknown" is never displayed as "zero calories".
- **A correction adjusts, it does not restart.** `reviseMeal()` sends the current numbers with the
  correction, so "the rice was about 150 g" rescales that item and every item the user did not
  mention is kept exactly as it was. A revised meal is marked `ai-edited`, because the user
  contributed to it.
- **Parsing is tolerant about wrapping and strict about values.** `extractJson()` accepts a fenced or
  padded reply; a figure that is not a finite, non-negative number becomes `null`, so a hallucinated
  string cannot be written into a meal as `NaN`; an item with no name is dropped rather than saved
  blank; a reply that is not JSON at all yields an empty proposal instead of an exception.
- **An estimate must look like an estimate.** The prompt says so, `source` and `confidence` store it,
  and the UI repeats it (`Estimate · medium` and a line explaining that the numbers are estimated).
- Photos are **excluded from backups** on purpose. The backup stays a record of the data; a restored
  meal keeps its numbers and loses its picture.

## Summaries

Derived data, generated **locally** — which is what makes them work with AI switched
off. An LLM can later rephrase a summary's body, but the numbers, the highlights and the
comparisons always come from `src/services/summaries/`.

The layers compress upward, and each reads only the layer below:

```
Workout ──► Daily Summary ──► Weekly Summary ──► Monthly Summary
```

That is what keeps a month's summary cheap: it never re-reads every workout, and the
whole month's JSON is never handed to a model.

| Module | Responsibility |
| --- | --- |
| `buildSummary.ts` | Pure builders: `aggregate`, `describeFocus`, `describeMainLifts`, `describeChanges`, `buildDailySummary`, `buildRollupSummary`, plus period-key maths (`weekKey`, `monthKey`, `weekDayKeys`, `monthWeekKeys`, `previousPeriodKey`). |
| `summaryService.ts` | Persists them, bottom-up: refreshing a day also refreshes its week and month. `rebuildAll()` regenerates everything from history. |

Design decisions worth keeping:

- **A summary never invents a number.** Unknown exercise names contribute nothing to the
  day's title rather than being guessed at, and a change below 1 kg (2 lb) is not
  reported as a change.
- **Focus attribution is one group per exercise**, so "Overhead Press" cannot be counted
  as both chest and shoulder work.
- **Comparison uses real workouts, not summaries.** The "vs before" baseline is the best
  previous set for that exercise, computed from history, so a missing or deleted summary
  can never hide a regression.
- **A day with nothing logged deletes its summary** instead of leaving a stale one.
- **Regenerating replaces** (ids are `sum_<kind>_<periodKey>`), so it never duplicates.
- Period keys follow the **user's local calendar**; daily is `YYYY-MM-DD`, weekly is that
  week's Monday, monthly is `YYYY-MM`.

Deleting a summary touches only the summary. That is structural — summaries live in their
own collection — and it is asserted from both the repository and the browser.

## Outlier review

`findAnomalies()` in `src/services/validation.ts` compares each logged weight against the
median of the same exercise's past sessions. It needs at least three prior sessions before
saying anything, and it excludes the workout being checked so editing an old session cannot
use its own numbers as the baseline.

`useOutlierReview` (`src/state/useOutlierReview.tsx`) is the shared UI contract, used by
both the structured recorder and Quick Log — Quick Log is in fact where a typo like "600kg"
is most likely to be typed:

- the check **never blocks saving**; the caller's save runs whatever the user answers;
- a value is **never rewritten** unless the user types a replacement, and corrections go
  through `applyWeightCorrections` so `weightKg` is re-derived rather than patched;
- if the check itself throws, the workout still saves.

## Readable exports

JSON (`services/backup.ts`) is the format for **restoring**. `services/export/` produces
the formats for **reading**, and they are deliberately one-way:

| Format | Shape | Notes |
| --- | --- | --- |
| Markdown | Totals, a per-exercise table, then every workout with its sets | Pastes into a note; includes the day summary when one exists |
| CSV | One row per set, 19 columns | Opens in a spreadsheet; includes the canonical `weightKg` next to the displayed weight and unit |

`csvCell()` prefixes a leading `=`, `+`, `-` or `@` with a quote, so text a user typed
into a set note cannot be executed as a formula by Excel or Sheets.

Both are built from the same `selectWorkouts()` range filter and share
`aggregateForExport()`, so the two formats always agree on a workout's numbers.

## Summary catch-up and polish

`SummaryService.catchUp()` runs on the Home screen. It fills in summaries for the current
and previous week/month when they are missing — the case where history arrived by import
or from a build that predates summaries. It is bounded (current/previous periods only, and
a cap on daily back-fill) and idempotent, so a second launch creates nothing.

`services/summaries/polish.ts` is the optional AI layer on top:

- the local `body` is generated on-device from real sets and is **never overwritten**;
- `polishSummary()` is a no-op that reports `AI is off` when AI is disabled;
- an unusable reply (empty, tiny, or over 1200 characters) is rejected and the local text
  stands;
- a failing endpoint is swallowed — a summary can never end up blank because of a network
  problem;
- `displayBody()` prefers `llmBody` when present, and `clearPolish()` reverts.

Only the single summary being polished is sent; a test asserts another day's session is
not included in the request.

## Responsive layout

`src/styles/global.css` has two rules at the top, and they are the whole design system: colour comes
from theme tokens only, and size is fluid. Fixed pixel values appear only where something genuinely
has a fixed size (touch targets, icon buttons, the rail); everything else is `rem`, `fr`, `clamp()`
or `min()`, so nothing assumes a 360×800 phone.

| Variable / breakpoint | Value | Effect |
| --- | --- | --- |
| `--font-base` … `--font-xl` | `clamp(...)` | Type scale that grows with the viewport but stays readable on a phone. |
| `--measure` | `42rem` → `46rem` (≥40rem) → `58rem` (≥56rem) → `66rem` (≥75rem) | Reading width for a column of content. It is what keeps a line readable and a card from stretching across a desktop. |
| `--rail` | `13.5rem` → `15rem` (≥75rem) | Width of the side navigation once it exists. |
| `--tap` | `2.5rem` | Touch targets never shrink below this. |
| `@media (min-width: 40rem)` | tablets in portrait, unfolded foldables, landscape phones | Wider measure, roomier padding, two-column `.split`, and sheets stop being bottom-anchored. |
| `@media (min-width: 56rem)` | large tablets and near-desktop | `.app-shell` becomes `rail + main` with the rail sticky at `100dvh`, the bottom bar is hidden, and `.card-grid` becomes three columns. |
| `@media (min-width: 75rem)` | near-desktop proportions | Wider measure and rail; the extra room goes to the column, not to line length. |
| `@media (max-height: 30rem) and (orientation: landscape)` | landscape phone | Shrinks the nav and header heights so the bar does not eat the screen. |
| `@media (max-width: 22.5rem)` | very narrow phones (≈320 px) | Tightens spacing and collapses `.stat-grid` to one column rather than overflowing. |

- **One navigation list, two presentations.** `src/App.tsx` holds one `NAV_ITEMS` array; the phone
  bottom bar renders the `primary` entries, and the rail renders every destination. Neither is a
  separate component, so a route cannot be reachable on one form factor and missing on the other.
- **Grids are `auto-fit` + `minmax`**, so `.stat-grid` and the macro grid give two columns on a phone
  and four on a tablet from one rule, with no media query and no fixed card count.
- **Sheets adapt instead of scaling.** A sheet is bottom-anchored on a phone (thumb reach) and
  becomes a centred dialog at ≥40rem with `max-width: 34rem`; `dvh` keeps it on screen when the
  keyboard opens. Toasts are capped at `min(92vw, 30rem)`.
- A `prefers-reduced-motion` block disables the sheet animation.

The browser smoke test runs the whole suite twice — at 390×844 and at 1280×900 — so both the bottom
bar and the rail branches are exercised, and it asserts at each width that exactly one navigation is
visible, that it is the one the 56rem breakpoint implies, that nothing overflows horizontally, and
that content is capped and centred on the wide screen.

## Robustness

Three things exist because the user's history is the only copy of their data, and a
display problem must never look like data loss:

- **`ErrorBoundary`** wraps the whole app. React tears down the tree on an uncaught render
  error, so without it one malformed workout — hand-edited JSON, a half-written import, a
  future migration bug — blanks the screen. The fallback says the data is still on the
  device, offers a reload, links straight to the Data screen for a backup, and never
  "cleans up" anything on its own. A browser test renders a deliberately crashing
  component through the real boundary and asserts the recovery screen appears.
- **A splash first, then the app.** Opening the database and reading settings is
  asynchronous; on a cold start with a large history that is not instant, and rendering
  nothing makes the app look like it failed to launch.
- **Paged lists.** History renders 60 workouts at a time and Meals 40, each with a "show
  more" button. A multi-year history is thousands of cards, and rendering them all makes
  scrolling and editing sluggish on a phone. The meals list also loads thumbnails for the
  first page (40 rows) rather than on every "show more", so scrolling a long food log never
  reads every photo out of the database one row at a time.

The crash screen is translated, which is why `i18n/runtime.ts` exists: a class component cannot call
`useI18n()`, and the chosen language lives in a settings document that is only reachable through an
async storage call. `AppProvider` mirrors the resolved locale into that module, so the recovery
screen renders immediately, in the user's language, with no dependency on the storage that may have
just failed. It is plain DOM — no router, no context, no storage — because the crash may have come
from any of those, and its one escape hatch (`#/data`) is a hash the user can type even if a button
is unreachable.

`TrainingRepository.complete()` keeps an existing end time and stamps the wall clock only when
there is none (`workout.endTime ?? nowIso()`), so the
duration can never be negative. The workout detail screen offers **Reopen as in-progress**
for the case where a session was finished by mistake — "finished" is a state, not a lock.

## Testing

| Command | What it covers |
| --- | --- |
| `npm test` | 283 tests in 55 suites (`src/**/*.test.ts`): repositories, units and formatting, metrics, alias rules, exercise history and personal bests, anomaly detection and the correction path, summary builders / service / catch-up / polish, Markdown and CSV exports, backup/restore and v1 compatibility, migrations, settings-write serialisation, **reminder scheduling arithmetic and plan normalisation**, **AI proposal parsing**, **streamed-chunk reading**, **stored AI conversations and their follow-up memory caps**, the offline parser, the context builder, the OpenAI client against a mocked `fetch`, theme tokens, status-bar icon selection, the pixel sprites, **motif and scenery composition**, catalogue parity **and completeness** across the three locales, vision capability detection, meal analysis and the profile context, the **real** `IndexedDbAdapter` via `fake-indexeddb`, and the `SqliteAdapter`'s real SQL via a fake Capacitor plugin. |
| `npm run test:browser` | `scripts/smoke.ps1` starts a throwaway Vite server and drives headless Chrome (or Edge) over CDP through the real app with `?smoke=1`, twice: at a phone viewport (390×844) and a desktop one (1280×900), each in its own browser profile so the two runs cannot influence each other. The in-page suite in `src/dev/browserSmoke.ts` records and finishes a workout across two page reloads, walks exercise history (chart metric toggle, PR badge), rules, backup round-trip, Markdown/CSV export, the browser download path, Quick Log preview+confirm, the AI page with AI off, summaries, the outlier review, manual meal entry/edit/delete, the vision-specific refusal, language switching in both directions, theme switching, and the responsive layout — then crashes a component through the real error boundary and asserts React logged no console errors. Every check must pass at both viewports. |
| `npm run verify` | lint + typecheck + tests + production build. |

Tests run on `node --test` with Node's native TypeScript transform and a small resolver hook
(`scripts/ts-resolve-loader.mjs`) for extensionless imports — no test framework dependency.

Storage doubles implement the same `StorageAdapter` contract: `MemoryAdapter` (fast repository tests)
and `FakeSqlitePlugin` (executes the SQLite adapter's real SQL against in-memory tables). The
IndexedDB and SQLite adapters therefore both have genuine coverage rather than assumed behaviour.

### Lessons baked into the harness

The browser smoke test is deliberately adversarial about its own scaffolding, because each of
these produced a *false green* at some point during development:

- Assertions are scoped to `#root` and matched case-insensitively. The harness's own result
  panel contains the check names, and CSS `text-transform: uppercase` is reflected in
  `innerText` — either one would make assertions pass trivially.
- The panel is pinned to a corner with `pointer-events: none`, because a full-screen overlay
  makes `innerText` report the panel instead of the page.
- `console.error` is captured and asserted empty: React reports invalid DOM nesting without
  throwing, which is how nested `<a>` elements in the History list were caught.
- The wrapper fails the run unless the panel reports `note: "done"`, so a failed or
  unfinished run can never be reported as success.
- The driver waits for that `done` marker rather than for the panel's existence, and the
  PowerShell wrapper pre-warms Vite's module graph — an on-demand transform of the whole
  smoke graph is slower than the harness will wait, which looks exactly like a hang.
- Coordination between reload passes uses the app's own IndexedDB, because `sessionStorage`
  did not survive a reload in headless Chrome.
- Expected UI strings are read from the translation catalogues rather than copied into the
  harness, so the language checks assert that the *running app* agrees with the shipped
  translations instead of comparing a second hardcoded copy. The suite drives the UI in
  English and switches language through the real picker.
- The interface language is **pinned to English before the first pass**. The app follows the
  device language by default, so on a machine set to Chinese or Spanish every English
  assertion failed at once — a run that looked like a broken app was a broken assumption.
  `src/dev/smokeEntry.ts` writes the preference and reloads once if it is not already `en`;
  the reload budget in `runBrowserSmoke()` covers that extra visit.
- Settings are changed through the **real form**, not by writing the repository. The provider
  reads preferences when it mounts, so a direct write is invisible to the running page: the
  vision check configured a text-only model that the meal screen never saw.
- Layout facts (which navigation is visible, whether anything overflows, how wide the
  content column is, how many columns the theme grid has) are read from the live viewport,
  and the whole suite is run at two widths — a check that only ever ran on a phone would
  quietly pass on a desktop layout it never saw. Visibility is measured from the rendered
  box, not from `offsetParent`: the bottom bar is `position: fixed` and reports a null
  `offsetParent` while fully visible.
- Text assertions that span two inline elements are made on the elements, not on the page
  text. `innerText` concatenates a date and an adjacent badge with no separator
  ("…2026PR"), so a word-boundary search over the whole page cannot see the badge.
- The harness writes `document.title = SMOKE:PASS | SMOKE:FAIL` as well as the panel, so a
  run is diagnosable from the tab title alone.
- Vite strips the smoke bootstrap from `index.html` at build time, so the shipped bundle
  never contains the test entry point or the `src/dev/*` modules. The last-resort boot
  reporter in `main.tsx` is guarded by `import.meta.env.DEV`, so a production boot failure
  shows the readable recovery screen rather than a JSON panel. (Nothing in this repository
  drives the APK itself; see the hardware note in the README.)
- The PowerShell wrapper ends with an explicit `exit` and kills the dev server **tree**
  (`taskkill /T`): `npx vite` is a wrapper around a child node process, and leaving that
  child alive kept the script's stdout pipe open, so a fully passing run hung the caller.
  `taskkill` also writes to stderr whenever a process has already exited, and under
  `ErrorActionPreference = 'Stop'` that turned a passing run into exit code 1 — the
  preference is relaxed for the cleanup only.

Two Windows-specific traps are documented in the scripts: Windows PowerShell 5.1 decodes
BOM-less scripts as ANSI (so `smoke.ps1` is ASCII-only and BOM-saved), and `Get-Content -Raw`
decodes files as ANSI (so the report JSON is read with an explicit UTF-8 decoder).

## Privacy

All data lives on the device. There is no project server, no account and no telemetry. The only
network calls the app can ever make are to an OpenAI-compatible endpoint that the user configures
themselves, and only when they explicitly trigger an AI action. The Android manifest declares
`INTERNET` because the optional AI feature and dev-time live reload need it; nothing else uses it.

Three things are worth stating explicitly, because they are what a local-first app is judged on:

- **A meal photo never leaves the device except inside the analysis request the user started.** It is
  stored as a data URL in the app's own key/value store, sent as an `image_url` content part in that
  one request, and never uploaded anywhere else. It is not in a backup either.
- **The profile is local-only**, and it reaches a model only as the short block attached to a meal
  request — never as an entire settings document, and never for training questions.
- **The API key is stored locally and structurally excluded from exports.** `BackupDocument` does not
  declare the field, and a test asserts that against the source.
