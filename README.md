**English** | [简体中文](README.zh-CN.md)

# FitAGI by Capy

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.9.0-informational.svg)](CHANGELOG.md)
[![Platform](https://img.shields.io/badge/platform-Android%206.0%2B-3ddc84.svg)](#supported-devices)
[![Tests](https://img.shields.io/badge/tests-358%20passing-brightgreen.svg)](docs/DEVELOPING.md#verify)

A free, open-source, local-first workout and meal tracker for Android. The mascot is a ragdoll cat,
drawn in code rather than shipped as an image.

- **No account, no server, no cloud sync, no ads, no tracking.**
- Every core feature works fully offline.
- **AI is optional.** With AI disabled the app is a complete workout tracker; the AI layer only ever
  adds convenience on top.

The recording experience aims to feel like *notes + a training log*: open it, log a set, close it.
It is **feature complete for the planned scope** (0.9.0): manual logging, local persistence, History,
Exercise history with progress charts, kg/lb, a meal log with optional photo analysis, reminders as
local notifications, weekly training plans, an optional local-only profile, four colour themes with
hand-drawn pixel mascots and matching scenery, a complete interface translation (Simplified Chinese,
English, Spanish), JSON backup & restore, Markdown/CSV export, user-owned alias rules,
natural-language Quick Log with preview/confirm, outlier review, multi-layer summaries, and an
optional OpenAI-compatible AI layer.

> **New here?** [What works today](#what-works-today) is the feature tour, and
> [Known limits](#known-limits) says plainly what has **not** been verified — nothing has run on a
> real Android device yet.

---

## Get the APK

Download `FitAGI-by-Capy-0.9.0-debug.apk` from the
[latest release](https://github.com/SuperOoze0309/fitagi-by-capy/releases/latest), copy it to the phone
and open it — you will need to allow installing from unknown sources, because the APK is signed with
the Android debug key rather than a Play key. `adb install -r FitAGI-by-Capy-0.9.0-debug.apk` works too.

What the APK does, in one breath: it logs your workouts set by set, keeps a meal log with optional photo
analysis, shows progress charts, schedules reminders as local notifications, holds your weekly training
plan, and can optionally talk to an OpenAI-compatible endpoint you configure. **Nothing leaves the
phone** unless you start an AI request yourself. There is no account, no server, no ads and no
telemetry, and every core feature works with the phone in flight mode.

## Supported devices

| | |
| --- | --- |
| Android | **6.0 (API 23) or newer.** Compiled and validated against API 35 |
| Architecture | Any — phone or tablet, ARM or x86, 32- or 64-bit |
| Screen | Anything from a 320dp-wide phone to a tablet or a near-desktop window. Layouts reflow; nothing needs a particular size |
| Camera | **Optional.** A device without one still installs and still logs meals manually — the camera is only used for photo analysis |
| Notifications | Reminders need Android 13+'s notification permission granted; without it the app just never rings. They survive a restart |
| Storage | A few MB. Your data is a single SQLite file, plus whatever meal photos you take |
| Network | **Only for the optional AI features.** Everything else is fully offline |
| Language | Simplified Chinese, English, Spanish — otherwise it follows the device and falls back to English |

## Development

Building from source, running the app in a browser, the npm scripts and the test suites are covered in
[`docs/DEVELOPING.md`](docs/DEVELOPING.md) · [`中文`](docs/DEVELOPING.md#中文).

## What works today

**First run**
- On a new install the app opens a two-step permission walkthrough: camera and photos first,
  then notifications. Each step says what the permission is *for* before it is requested,
  and both can be declined — nothing gates on them
- The walkthrough is skipped for an install that predates it, so upgrading never re-asks

**Reminders**
- Local notifications scheduled by the phone, not by a server: a time of day plus any
  combination of weekdays, or every day
- Six kinds (training, meal, water, weigh-in, rest, custom) that only change the label and
  where the reminder points
- **Set them by hand, or let the AI propose 3–5** based on your goal, activity level and
  when you actually train; pick the ones you want, and they are created as editable reminders
- The schedule is rebuilt from the list every launch, so a reboot, a restored backup or a
  permission granted later can never leave the two out of step
- Nothing is sent anywhere; the notification is generated on the device

**Training plans**
- A weekly plan: seven days, each with a session name, exercises, sets, a reps prescription
  ("8-10", "5", "AMRAP" — text, not a number) and an optional target weight
- Rest days are part of the plan, not gaps in it
- One plan is active at a time; the Home screen shows today's session with a **Start**
  button that opens a new workout with those exercises already in it
- **Draft one with AI**: describe what you want ("four days, upper/lower, about an hour")
  and the model drafts a week, shown for review before anything is saved
- Plans never touch your history: deleting a plan leaves every workout you logged from it

**Home**
- Start workout / resume an unfinished one
- Recent workouts with sets, volume and duration
- Today's meals with a calorie total, and a one-tap "log meal"
- Quick Log entry point

**Workout** — the priority surface
- Create a workout; it is saved immediately and resumes after a reload
- Add any exercise by typing its name — there is no bundled exercise library
- Add sets fast: a new set inherits the previous set's weight, reps, RPE, RIR and rest
- Inline numeric entry for weight, reps, RPE, plus rest and RIR
- Per-set flags: failure, warmup, drop set
- Copy the previous set, duplicate any set, delete sets
- Reorder exercises, mark supersets, add notes, record average heart rate
- Live elapsed timer; "Finish & save" freezes duration and moves it to History
- The finish sheet offers three ways out: **Keep training**, **Finish & save** and
  **Discard workout**. Discarding is confirmed and then deletes the draft, which is the
  only way to remove one — the header's "Home" button deliberately parks the session so
  it can be resumed later
- Rename an exercise and optionally **remember it as an alias rule** in one step

**Meals** — a food log that works with AI switched off
- Manual entry: name, portion, calories, protein, carbs, fat, time and notes, plus an
  item breakdown where each food carries its own numbers. A meal's totals are always the
  sum of its items, so the headline and the breakdown cannot disagree
- A photo from the camera or the gallery, compressed on the device (longest edge 1280 px,
  JPEG quality 0.72) and stored as a data URL in its own key/value store, one row per
  meal; deleting the meal deletes the photo
- An **AI estimate from the photo** when a vision-capable model is configured. The
  estimate arrives as an editable draft, is labelled with its confidence as an estimate
  rather than a measurement, and nothing is stored until "Confirm and save"
- A **correction chat** that revises the estimate in place: "the rice was about 150 g"
  rescales that item instead of restarting, and items you did not mention are kept as
  they were. Every correction goes through the same editable form
- Meals are grouped by local day and paged 40 at a time. A header card totals today's
  calories, protein, carbs and fat, each day shows its calorie total, and search matches
  the meal name, its notes and its item names
- A photo is **not** part of a backup: a restored meal keeps its numbers and loses its
  picture
- When the configured model is known to be text-only the app says so on the spot and the
  manual form keeps working

**Profile** — optional and local-only
- Name, gender, age or birthday, height, weight, goal weight, unit system (metric or
  imperial), training goal and activity level. Every field can stay empty
- Condensed into a short `## User profile` block that is attached to meal-analysis
  requests, so asking a model to estimate a meal does not mean sending your whole history
- The profile screen shows that block exactly as it would be sent
- **Gender is context for the AI and nothing else.** It has no effect on the theme,
  colours, icons, mascots or behaviour; a test asserts that settings carry no `gender`
  and the profile carries no `theme`
- Birthdays are parsed as local calendar dates, so a timezone behind UTC cannot shift
  the age by a day

**Quick log** — natural language, AI optional
- Type `卧推 60kg 8次 4组 最后一组力竭`, `bench 80 8 8 7 6 rir2`, `倒蹬577lb 8次4组`
  or `深蹲 100kg 5x5`
- The **offline parser runs first** and handles these without any model; if it cannot
  parse the text, the optional model is asked instead
- The result is always a **preview**: every exercise and set is editable, sets can be
  excluded, and nothing reaches storage until you confirm
- If nothing can be parsed the text is kept as a workout note rather than discarded
- Quick-logged workouts land in History finished, not as an open session

**History**
- Grouped by local day, newest first, paged so a multi-year log stays fast
- Search across exercise names and workout notes
- Open a workout, edit its start/end time and notes, delete it
- Reopen a finished workout to keep recording, or set it back to in-progress
- Tap any exercise name to open its full history

**Exercise history**
- Best set, session count, total sets, PR count and last-performed date
- **PR badges** mark every session that set a new heaviest weight, plus the change versus
  the previous session
- **Progress chart** with labelled axes and a value readout, switchable between the
  **top set** and **estimated 1RM** — the second makes a heavy triple comparable with a
  light set of ten
- Per-session log with sets, volume, estimated 1RM and the delta vs the previous session

**Alias rules**
- Full management UI: create, edit, delete, list
- Also created automatically when you rename while logging ("bench" → "Bench Press")
- Matching is case-insensitive and the longest match wins
- Rules only affect *new* entries; past workouts keep the exact text you typed
- Rules always take priority over any AI suggestion

**Summaries** — multi-layer, generated on the device
- **Daily**: what you trained ("Trained legs and shoulders."), the main lifts with their
  numbers (`Leg Press: 100kg × 8 × 4`), sessions, working sets, volume, time, and any
  clear change versus your own previous best (`+5kg vs before`)
- **Weekly**: rolled up from its days — sessions, volume change vs the previous week,
  main lifts, and a line per day
- **Monthly**: rolled up from its weeks, so a month is never the whole month's JSON
- Generated **without any model**; an LLM may only rephrase afterwards
- Browse all three on the Summaries page, with a Rebuild action that regenerates from history
- Missing summaries for the current and previous week/month are filled in on launch, so
  history that arrived via an import is summarised too
- **Polish with AI** (optional) rewrites the prose; the on-device text is always kept and
  can be restored with one tap, and the button says "AI off" rather than disappearing
- Derived data: deleting a summary never touches the workouts it came from

**Outlier review**
- A weight far outside your own history is flagged before saving: the sheet shows the
  value and your usual range, and offers **Fix**, **Keep as typed** or **Ignore**
- It never blocks the save, and it never rewrites a number — `600 kg` stays `600 kg`
  unless you type a replacement
- Runs on both the structured recorder and Quick Log
- Needs at least three prior sessions before it says anything, so it stays quiet early on

**AI (optional, off by default)**
- Any OpenAI-compatible endpoint: Base URL, API key and model are yours to set
- Three roles with different system prompts:
  - **Recorder** — parses and looks up. Gives no advice.
  - **Reminder** — what you did last time: weights, reps, RPE, trend.
  - **Coach** — may advise, and must split its answer into recorded **FACTS** and its
    own **SUGGESTION**. The headings follow the language you asked in; a suggested number has
    to be grounded in a baseline you actually logged, and pain gets no diagnosis — it tells
    you to stop the movement and see a professional
- **Conversation, not a form**: the answer is typed onto the screen as it streams in from
  the endpoint, inside a bubble that grows, and the transcript scrolls to follow it. The
  input is docked at the bottom like a messaging app, and grows with what you type up to
  a point. A transcript you have scrolled up in stays where you put it instead of being
  yanked back to the bottom
- Endpoints that ignore the streaming flag still work: the whole answer appears at once
  instead of failing
- Use **Stop generating** to cancel an answer. Leaving the page also cancels the request;
  unfinished answers are not added to chat memory. Requests have a two-minute deadline.
- Enter sends, Shift+Enter inserts a line break, and confirming an IME composition does not send.
- Discovered exercise names are offered with a per-session name
- **Chat memory stays on-device**: the latest 100 exchanges remain visible after leaving and
  reopening the AI page. Follow-ups include up to 8 earlier exchanges so the model can keep
  track of what you were discussing. Each answer shows what was sent; Clear also removes the
  local transcript. Chat history is not included in backups.
- A **Summarise recent training** action asks for a recap of the built context, with no
  question needed
- A **Context Builder** decides what is sent: the current in-progress workout, the last 3–5
  sessions of the exercises you asked about, the last 7 days, and the weekly/monthly
  rollups — never the whole database. Each answer shows what was sent.
- With AI off the AI page explains how to enable it and points at the offline Quick Log
- Errors are actionable: a rejected key, a wrong base URL and an unreachable host each
  produce a specific message
- **Vision capability is reported, not assumed.** The model name is classified as
  `supported`, `unsupported` or `unknown` from known model families, and you can override
  the guess in Settings. A model known to be text-only is never sent a photo; `unknown`
  lets you try, and if the endpoint answers with a prose refusal the app recognises it and
  says the model cannot take images instead of showing a raw HTTP error
- **Photo analysis** for meals uses the same endpoint: the image goes as an
  OpenAI-compatible `image_url` content part in a data URL, and the model's own wording
  about what is uncertain is shown verbatim next to the estimate (model text is never
  translated)

**Backup & restore**
- Export one readable JSON file: workouts, exercises, sets, alias rules, summaries, meals,
  reminders, plans and settings (unit, theme, language, AI endpoint, model and vision
  override), plus the profile when it has been filled in
- Meal photos are deliberately not included — a backup stays a record of your data rather
  than a photo dump. A restored meal keeps its numbers and has no picture
- The API key is **never** written to a backup. Restoring the same AI endpoint keeps the key on
  the device. A changed endpoint clears the key and disables AI until you reconfigure it in Settings.
- Import validates the file first, shows what it contains and what will be replaced, and
  only then applies it. A backup written before meals, reminders and plans existed still
  imports: its workouts are restored untouched and the newer sections simply arrive empty
- **Markdown** and **CSV** exports for reading: a per-exercise table, every set, and a
  one-row-per-set CSV with the canonical kg value alongside the displayed weight. CSV
  cells are prefixed so a spreadsheet cannot execute typed text as a formula. Range can
  be all-time, this month or last 7 days.

**Settings**
- Language: **Auto** (follow the device) or Simplified Chinese / English / Español,
  applied instantly with no reload. Date and time formatting follows the chosen language
- Theme: four shipped themes — **ragdoll** (the app's own cat, warm off-white and pink),
  **bunny** (pink and blue), **panda** (black and white) and **orca** (deep ocean blue) — each
  with its own palette and 16×16 pixel mascot, shown as a swatch and a mascot in the picker
  and defaulting to `ragdoll`. On Android the status bar follows the theme, with its icon
  colour derived from the bar colour rather than hardcoded per theme
- Default unit (kg / lb)
- Storage engine shown for transparency
- AI: enable, base URL, key, model, default role, and the detected vision capability with
  an override switch
- Links to Profile, Backup & restore, Summaries and Alias rules
- Delete all local data (workouts, meals, summaries, rules and the profile)

### Units

Weight is stored as the value you typed plus its unit, together with a canonical kg value used for
volume and comparisons. Switching the display unit never rewrites your history.

### Languages and themes

Every user-visible string comes from a translation catalogue: `src/i18n/en.ts` is the reference,
and `zh-CN.ts` / `es.ts` are typed against its shape, so a missing or misspelled key is a build
error rather than an English word appearing in a Chinese screen. Date, time and number formatting
goes through `Intl` with the locale's own tag. Model-generated text — an AI answer, a meal
estimate's own note — is shown exactly as it arrived and is never translated.

A theme is a set of colour tokens, a pixel mascot **and a set of motifs**. Components consume tokens
only, and the stylesheet contains no palette values of its own, so adding a fifth theme means adding
one `ThemeDefinition`, one 16×16 mascot sprite and a few motifs — no page, component or stylesheet
change. Everything is drawn in code as character grids: there are no image files, no base64 blobs and
no third-party artwork anywhere in the app, including the app icon and the splash screen.

The four themes are **ragdoll** (the app's own cat: warm paper, grey fur, blue eyes, pink nose),
**bunny** (pink and blue), **panda** (black and white) and **orca** (deep ocean blue).

#### Theme scenery

A theme does not just recolour the app, it decorates it with things that belong to it:

| Theme | Ground strip | Standing on it | In the air |
| --- | --- | --- | --- |
| ragdoll | soft grass | a paw print, a ball of yarn, a heart | a paper cloud, a heart |
| bunny | grass tufts | a flower, a carrot, a heart | a cloud, a heart |
| panda | low moss | a bamboo stalk, a paw print, a leaf | a leaf, a paw print |
| orca | water and wave crests | a fish, bubbles, a star | bubbles, a star |

The motifs are composed at runtime into one wide sprite (`src/theme/scenery.ts`) and drawn at the
bottom of the Home hero card and inside empty states. Three rules keep it decoration rather than
noise: it is `aria-hidden`, it never takes a tap, and the arrangement is deterministic — the same
theme always draws the same scene. The browser smoke test compares a pixel-level fingerprint of the
scene across three themes, so "each theme draws its own scenery" is asserted rather than assumed.

### The app icon

The launcher icon is the hand-drawn ragdoll cat, used as supplied:
`design/icon-candidates/source/cat-sketch.jpg` (413×358). The pipeline crops it to a
350×350 square that keeps the whole cat and drops the heart and the fragment of another
drawing at the right edge, samples the sketch's own paper colour (`#f9f5f2`) from its
corners, and composites the result at each density.

```bash
pwsh -File design/icon-candidates/render-android-icons.ps1   # launcher + adaptive layers
node design/icon-candidates/render-splashes.mjs              # splash, both orientations
```

Two decisions are worth knowing about:

- **The artwork is the adaptive icon's *background* layer, not its foreground.** The sketch is a JPEG
  with no transparency, so as a foreground layer its own white square would sit on top of the
  background colour and the seam would show. Full bleed in the background, the launcher's mask crops
  paper rather than the cat, and `ic_launcher_foreground.png` is a transparent placeholder.
- **The cat occupies 88% of a plain square icon, 78% of the round one and 78% of the adaptive
  layer.** The adaptive safe zone is the central 72 of 108dp, and a circular mask is inscribed in
  that; at 78% the ears, eyes and nose are always inside it. A launcher that masks to a circle trims
  the outermost whiskers — the sketch is drawn edge to edge, so the alternative is a cat that looks
  lost in the middle.
- **The drawing is deepened slightly on the way in** (a gamma of 1.35). It is a pale pencil sketch,
  and at 48px the fur otherwise disappears against the paper. Gamma darkens the midtones — the fur and
  the outlines — while leaving the near-white paper alone; a contrast curve would have done the
  opposite, pushing the light-grey fur further towards white. The padding colour is then re-sampled
  from the adjusted artwork so the flat fill and the crop's own edges match exactly.

`design/icon-candidates/preview-icons.png` shows the result under the three mask shapes Android uses,
regenerate it with `node design/icon-candidates/preview-icons.mjs`.

`design/icon-candidates/alternates/` holds a vector cat drawn in the same family as the pixel
mascots; it was the first attempt and is kept only for reference. `uc-monogram/` holds the earlier
letterform concepts.

### Layout

One layout serves whatever screen the app is on. Navigation is a bottom bar on a phone and a side rail
from 56rem up; the type scale is fluid (`clamp()`), grids use `auto-fit`, content is capped to a reading
width and centred once there is room, and sheets become centred dialogs instead of full-width panels.
There are no fixed pixel widths for content, and nothing needs a particular screen size or orientation.

### Corners

The interface is built from rounded objects rather than rectangles with clipped corners, and the
whole thing reads from six radius tokens in `:root`:

| Token | Used by |
| --- | --- |
| `--radius-xs` | chips, segmented buttons, the inner corner of a speech bubble |
| `--radius-sm` | inputs, banners, inner blocks, a card nested inside a card |
| `--radius` | cards, exercise cards, theme tiles |
| `--radius-lg` | the outer corner of a card, the chat bubble, the text input |
| `--radius-xl` | the top of a bottom sheet |
| `--radius-pill` | every button, badge, toggle and filter chip |

Nested surfaces step *down* a size (`--radius-lg` on a card, `--radius-sm` inside it) so the curves
stay concentric; equal radii on nested boxes look wrong because the inner corner appears tighter.
`src/test/theme.test.ts` does not police this, but `global.css` contains no literal radius value —
every corner in the app comes from that table.

### Data model in one line

`Workout → ExerciseEntry[] → SetEntry[]`, where a set carries weight, reps, optional duration,
distance, rest, RPE, RIR, and failure/warmup/drop-set flags. Meals are a separate aggregate:
`Meal → MealItem[]`, with the meal's totals derived from its items. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full model and rationale.

---

## Project layout

```
src/
  domain/        types, units, dates, metrics, workout factories  (no I/O)
  storage/       StorageAdapter + IndexedDB / SQLite implementations
  repositories/  training, exercise, rule, settings, summary, profile, meal, plan, reminder
  services/      backup/restore, file transfer, Markdown/CSV export, outlier detection,
                 image picking and compression
    ai/          provider interface, OpenAI-compatible client, prompts, context builder,
                 offline parser, reminder and plan proposals, draft materializer,
                 vision detection, meal analysis, user context
    summaries/   pure summary builders + the service that persists them + AI polish
  state/         app-wide preferences, language and profile, active workout session,
                 shared outlier review
  theme/         theme tokens and the pixel mascots (data, no components)
  i18n/          catalogues (en / zh-CN / es), locale detection, the active-locale mirror
  styles/        the stylesheet: token variables, a fluid type scale and the breakpoints
  components/    sheet, fields, exercise card, exercise picker, rule forms, outlier sheet,
                 progress chart, pixel-art renderer, error boundary
  pages/         Home, Workout, Meals, Meal detail, Profile, QuickLog, History, detail,
                 Exercise, Summaries, Rules, Data, AI, Settings, Plans, Reminders, Welcome
  dev/           opt-in browser smoke test (stripped from production builds)
  test/          node:test suites, in-memory + fake-plugin storage doubles
android/         Capacitor Android project (generated, committed)
docs/            architecture notes
scripts/         test resolver hook, headless browser smoke driver
```

## Known limits

- **Nothing has been run on real hardware.** The APK has not been installed on a physical
  device or an emulator in this environment (no system image is installed). The SQLite
  adapter is covered by tests that execute its real SQL through a fake plugin, but a first
  launch on a device is still worth doing.
- **The native paths are type-checked, not exercised.** The share sheet and file picker
  (`services/fileTransfer.ts`) are written against the Capacitor `@capacitor/share` and
  `@capacitor/filesystem` definitions; the camera/gallery picker (`services/imageInput.ts`) is a
  platform file input with `capture="environment"`, which the Android WebView bridges to the system
  chooser. No native dialog has been opened on hardware. The browser fallbacks around them do run in
  the smoke test, but a native dialog cannot be driven from a headless page, so that run writes its
  meal photo through the repository instead of through the picker.
- **The two Android shell integrations are also unverified on hardware.**
  `services/nativeShell.ts` paints the status bar from the active theme and routes the hardware back
  button (close a sheet → go back → exit at the start). Both are guarded by
  `Capacitor.isNativePlatform()` so they are inert in a browser, and the status-bar *decision* has
  unit tests, but neither has been seen working on a device.
- **No real model has been called.** No LLM or vision endpoint has ever been contacted from
  this repository: the OpenAI-compatible client is covered against a mocked `fetch`, and the
  meal analysis is covered by tests that inject the chat functions. Whether a given
  endpoint accepts a data-URL image is therefore verified by the capability rules and by
  handling the endpoint's refusal, not by a live request.
- **The launcher icon has not been seen in a real launcher.** The artwork is verified by rendering
  it at 48, 96 and 192 px and looking at it, and the adaptive foreground is scaled to the documented
  safe zone, but which mask a given phone applies (circle, squircle, rounded square) and how the
  status-bar colour lands next to a real Android theme are only known from the platform rules.
- The browser smoke test needs Chrome or Edge installed; without one, `npm run test:browser`
  reports that it is skipping and exits successfully.

## Renaming the app: what is frozen

The product name changed from *Fitness Agent* to *FitAGI by Capy* in 0.8.0. Four identifiers were
deliberately **not** changed, because they are how existing data is found rather than how the app
introduces itself:

| Frozen | Where | Why |
| --- | --- | --- |
| `fitness-agent-backup` | `services/backup.ts` | The marker that recognises a backup file. Renaming it would reject every backup a user has already exported. |
| `fitness-agent` | `storage/idbAdapter.ts` | The IndexedDB database name. Renaming it would silently open a new, empty database. |
| `fitness_agent` | `storage/sqliteAdapter.ts` | The SQLite file name on Android, for the same reason. |
| `app.fitnessagent.tracker` | `capacitor.config.ts`, `build.gradle` | The Android package name. A new one installs a second app and leaves the first one's data behind. |

File names a user actually sees — backups, Markdown and CSV exports — did change, to
`fitagi-2026-02-14-0931.json`, `fitagi-2026-03-04.md` and `fitagi-2026-03-04.csv`. Those are labels,
not keys: an old file still restores, because the format is detected from its contents.

## If something goes wrong

A render error shows a recovery screen rather than a blank page — in the language you chose —
and it says plainly that your data is untouched. If it keeps happening, open the Data screen
(add `#/data` to the address) and export a JSON backup — that is the format that can be
restored.

## Not in this phase

Ideas that would fit the existing structure: a scheduled weekly summary refresh, a
per-exercise volume chart alongside the strength chart, a nutrition target to compare a day
against, and progress photos. None of them need architectural change.

## Privacy

All data lives on this device. There is no project server, no account and no telemetry. The only
network requests the app can ever make go to the OpenAI-compatible endpoint *you* configure, and only
when you explicitly trigger an AI action. Chat history stays on-device; each question sends up to 8
earlier exchanges and the training context shown under the answer to the selected endpoint. Chat
history is not included in backups. Each AI answer shows which context sections were sent, and a meal
photo is only ever sent inside the analysis request you started — it is never uploaded anywhere else,
and it stays in the app's own storage. The profile is local-only and reaches a model only as the short
context block attached to a meal request. Backups never contain your API key and never contain meal
photos.

## Documentation

| Document | What is in it |
| --- | --- |
| [`README.zh-CN.md`](README.zh-CN.md) | This file, in Simplified Chinese. 本文件的中文版。 |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each release, in English and Chinese. |
| [`docs/DEVELOPING.md`](docs/DEVELOPING.md) | For contributors: running it in a browser, npm scripts, building the APK, the test suites. English and Chinese in one file. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`中文`](docs/ARCHITECTURE.zh-CN.md) | Why the code is shaped the way it is: the storage contract, the migration rules, the theme and i18n architecture, the vision rules, the test harness. |
| [`design/README.md`](design/README.md) | The artwork sources and the scripts that generate the icons and splash screens. |

## Contributing

The two rules that matter most:

1. **No user-visible string in a component.** Every label lives in `src/i18n/en.ts` and its two
   translations; `src/test/i18n.test.ts` fails the build if a catalogue is incomplete or a phrase was
   copied from English.
2. **Never lose user data.** Schema changes are additive, migrations fill defaults, and a file written
   by an older version still imports. The frozen identifiers listed above exist for that reason — do
   not rename them.

Run `npm run verify` before opening a pull request: lint, typecheck, 358 unit tests and a production
build. [`docs/DEVELOPING.md`](docs/DEVELOPING.md) has the rest, including the browser suite that drives
the real app in headless Chrome at two viewports.

## License

MIT — see [`LICENSE`](LICENSE).
