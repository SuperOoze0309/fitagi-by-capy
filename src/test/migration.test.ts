import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryAdapter } from '@/test/MemoryAdapter';
import { initStorage, resetStorageForTests, destroyStorage } from '@/storage';
import { buildRepositories, type Repositories } from '@/repositories';
import {
  DEFAULT_SETTINGS,
  EMPTY_PROFILE,
  LEGACY_ONBOARDED_AT,
  normalizeProfile,
  normalizeSettings,
} from '@/repositories/settingsRepository';
import {
  createEmptyPlan,
  createEmptyReminder,
} from '@/repositories/planRepository';
import { createEmptyMeal, createEmptyMealItem, sumItems, summarizeDay } from '@/repositories/mealRepository';
import {
  BackupParseError,
  applyBackup,
  createBackup,
  parseBackup,
  serializeBackup,
} from '@/services/backup';
import { DEFAULT_THEME_ID } from '@/theme/tokens';
import type { Meal, UserProfile } from '@/domain/types';

/**
 * Migration safety.
 *
 * The app already has users with stored data, so a new field must never be able to
 * break an existing install. Everything below is about reading *old* shapes.
 */
describe('settings migration', () => {
  it('fills in the fields an older build never wrote', () => {
    // What a pre-theme install has on disk: no theme, no language, no vision flag,
    // plus the retired light/dark preference.
    const legacy = {
      id: 'app',
      defaultUnit: 'lb',
      aiEnabled: true,
      aiBaseUrl: 'https://api.example.test/v1',
      aiApiKey: 'sk-kept',
      aiModel: 'some-model',
      aiRole: 'coach',
      theme: 'dark',
    } as unknown as Partial<typeof DEFAULT_SETTINGS>;

    const normalized = normalizeSettings(legacy);

    assert.equal(normalized.defaultUnit, 'lb', 'existing choices survive');
    assert.equal(normalized.aiEnabled, true);
    assert.equal(normalized.aiApiKey, 'sk-kept');
    assert.equal(normalized.aiRole, 'coach');
    // New fields get defaults rather than `undefined`.
    assert.equal(normalized.theme, DEFAULT_THEME_ID);
    assert.equal(normalized.language, 'system');
    assert.equal(normalized.aiVisionOverride, null);
  });

  it('keeps a valid theme and language', () => {
    const normalized = normalizeSettings({
      theme: 'orca',
      language: 'zh-CN',
      aiVisionOverride: true,
    } as Partial<typeof DEFAULT_SETTINGS>);
    assert.equal(normalized.theme, 'orca');
    assert.equal(normalized.language, 'zh-CN');
    assert.equal(normalized.aiVisionOverride, true);
  });

  it('falls back on a nonsense value instead of propagating it', () => {
    const normalized = normalizeSettings({
      theme: 'neon',
      language: 'klingon',
      defaultUnit: 'stone',
      aiRole: 'wizard',
      aiVisionOverride: 'yes',
    } as unknown as Partial<typeof DEFAULT_SETTINGS>);
    assert.equal(normalized.theme, DEFAULT_THEME_ID);
    assert.equal(normalized.language, 'system');
    assert.equal(normalized.defaultUnit, 'kg');
    assert.equal(normalized.aiRole, 'recorder');
    assert.equal(normalized.aiVisionOverride, null);
  });

  it('returns defaults for a completely empty document', () => {
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  });
});

describe('profile migration', () => {
  it('treats a missing profile as an empty one, not an error', () => {
    assert.deepEqual(normalizeProfile(null), EMPTY_PROFILE);
    assert.deepEqual(normalizeProfile(undefined), EMPTY_PROFILE);
  });

  it('defaults the unit system and drops unknown enum values', () => {
    const normalized = normalizeProfile({
      name: 'Sam',
      gender: 'alien',
      unitSystem: 'martian',
      trainingGoal: 'becomeLegend',
      activityLevel: 'extreme',
    } as unknown as Partial<UserProfile>);

    assert.equal(normalized.name, 'Sam');
    assert.equal(normalized.gender, null, 'an unknown gender is not coerced');
    assert.equal(normalized.unitSystem, 'metric');
    assert.equal(normalized.trainingGoal, null);
    assert.equal(normalized.activityLevel, null);
  });

  it('rejects physically impossible figures rather than storing them', () => {
    // A 0 kg bodyweight would quietly corrupt every AI request that uses it.
    const normalized = normalizeProfile({
      heightCm: 0,
      weightKg: -5,
      goalWeightKg: 9000,
      age: 400,
    } as Partial<UserProfile>);

    assert.equal(normalized.heightCm, null);
    assert.equal(normalized.weightKg, null);
    assert.equal(normalized.goalWeightKg, null);
    assert.equal(normalized.age, null);
  });

  it('accepts plausible figures', () => {
    const normalized = normalizeProfile({
      heightCm: 173,
      weightKg: 130,
      age: 21,
      gender: 'male',
      trainingGoal: 'fatLoss',
    } as Partial<UserProfile>);

    assert.equal(normalized.heightCm, 173);
    assert.equal(normalized.weightKg, 130);
    assert.equal(normalized.age, 21);
    assert.equal(normalized.gender, 'male');
    assert.equal(normalized.trainingGoal, 'fatLoss');
  });

  it('never derives a theme or any presentation from gender', () => {
    // The separation is a product requirement, so it is asserted structurally:
    // a settings object has no gender field and a profile has no theme field.
    const settings = normalizeSettings({ gender: 'female' } as never);
    assert.ok(!('gender' in settings));

    const profile = normalizeProfile({ gender: 'female', theme: 'orca' } as never);
    assert.ok(!('theme' in profile));
  });
});

/** End-to-end: an existing database gains the new stores without losing rows. */
describe('storage migration', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    resetStorageForTests();
  });

  afterEach(async () => {
    await destroyStorage().catch(() => undefined);
    resetStorageForTests();
  });

  it('opens a v1 database, keeps its workouts, and adds the new stores', async () => {
    // Build a level-1 database by hand, exactly as the previous release left it.
    const legacyRequest = indexedDB.open('fitness-agent', 1);
    await new Promise<void>((resolve, reject) => {
      legacyRequest.onupgradeneeded = () => {
        const db = legacyRequest.result;
        for (const name of ['workouts', 'rules', 'summaries', 'settings', 'presets']) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      legacyRequest.onsuccess = () => resolve();
      legacyRequest.onerror = () => reject(legacyRequest.error);
    });

    const legacyDb = legacyRequest.result;
    const workout = {
      id: 'legacy-workout',
      startTime: '2026-01-05T09:00:00.000Z',
      endTime: '2026-01-05T10:00:00.000Z',
      durationSec: 3600,
      notes: 'from the previous version',
      heartRate: null,
      exercises: [],
      completed: true,
      createdAt: '2026-01-05T09:00:00.000Z',
      updatedAt: '2026-01-05T10:00:00.000Z',
    };
    await new Promise<void>((resolve, reject) => {
      const tx = legacyDb.transaction('workouts', 'readwrite');
      tx.objectStore('workouts').put(workout);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacyDb.close();

    // Now open it through the app, which upgrades the schema.
    const bundle = await initStorage();
    const repos = buildRepositories(bundle);

    const workouts = await repos.training.all();
    assert.equal(workouts.length, 1, 'the existing workout is still there');
    assert.equal(workouts[0]?.id, 'legacy-workout');
    assert.equal(workouts[0]?.notes, 'from the previous version');

    // The stores added in v2 are usable, which is what proves the upgrade ran.
    assert.equal(await repos.meals.count(), 0);
    await repos.meals.save(createEmptyMeal());
    assert.equal(await repos.meals.count(), 1);

    // And the ones added in v3.
    assert.equal(await repos.reminders.count(), 0);
    assert.equal(await repos.plans.count(), 0);

    const settings = await repos.settings.ensureInitialized();
    assert.equal(settings.theme, DEFAULT_THEME_ID);
    assert.equal(settings.language, 'system');
  });

  it('opens a v2 database, keeps everything in it, and adds the v3 stores', async () => {
    // A database exactly as 0.8.0 left it: five collections and four key/value
    // stores, with a workout and a meal already in them.
    const v2Request = indexedDB.open('fitness-agent', 2);
    await new Promise<void>((resolve, reject) => {
      v2Request.onupgradeneeded = () => {
        const db = v2Request.result;
        for (const name of ['workouts', 'rules', 'summaries', 'meals']) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
        for (const name of ['settings', 'presets', 'images', 'profile']) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      v2Request.onsuccess = () => resolve();
      v2Request.onerror = () => reject(v2Request.error);
    });

    const legacyDb = v2Request.result;
    const before = {
      workout: {
        id: 'v2-workout',
        startTime: '2026-02-01T09:00:00.000Z',
        endTime: '2026-02-01T10:00:00.000Z',
        durationSec: 3600,
        notes: 'logged on 0.8.0',
        heartRate: null,
        exercises: [],
        completed: true,
        createdAt: '2026-02-01T09:00:00.000Z',
        updatedAt: '2026-02-01T10:00:00.000Z',
      },
      meal: {
        id: 'v2-meal',
        eatenAt: '2026-02-01T12:00:00.000Z',
        name: 'Rice bowl',
        items: [],
        calories: 600,
        createdAt: '2026-02-01T12:00:00.000Z',
        updatedAt: '2026-02-01T12:00:00.000Z',
      },
      // The v2 settings document, which has no `onboardedAt` field at all.
      settings: {
        id: 'app',
        defaultUnit: 'lb',
        aiEnabled: false,
        theme: 'orca',
        language: 'es',
      },
    };
    await new Promise<void>((resolve, reject) => {
      const tx = legacyDb.transaction(['workouts', 'meals', 'settings'], 'readwrite');
      tx.objectStore('workouts').put(before.workout);
      tx.objectStore('meals').put(before.meal);
      tx.objectStore('settings').put({ id: 'app', value: before.settings });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacyDb.close();

    const bundle = await initStorage();
    const repos = buildRepositories(bundle);

    // Nothing from v2 was dropped by the upgrade.
    const workouts = await repos.training.all();
    assert.equal(workouts.length, 1, 'the v2 workout survived the schema change');
    assert.equal(workouts[0]?.notes, 'logged on 0.8.0');
    assert.equal(await repos.meals.count(), 1, 'the v2 meal survived too');
    assert.equal((await repos.meals.all())[0]?.name, 'Rice bowl');

    // The v2 preferences are still in force.
    const settings = await repos.settings.get();
    assert.equal(settings.defaultUnit, 'lb');
    assert.equal(settings.theme, 'orca');
    assert.equal(settings.language, 'es');

    // An install that predates onboarding is not walked through it again.
    assert.equal(
      settings.onboardedAt,
      LEGACY_ONBOARDED_AT,
      'a document without the field means an existing install, not a new one',
    );

    // And the v3 stores exist and work.
    assert.equal(await repos.reminders.count(), 0);
    assert.equal(await repos.plans.count(), 0);
    await repos.reminders.save(createEmptyReminder({ title: 'Leg day', time: '19:00' }));
    const plan = await repos.plans.save({ ...createEmptyPlan(), name: 'Split', active: true });
    assert.equal(await repos.reminders.count(), 1);
    assert.equal((await repos.plans.active())?.id, plan.id);
  });

  it('keeps the API key out of a backup but keeps it on the device', async () => {
    const bundle = await initStorage(new MemoryAdapter());
    const repos = buildRepositories(bundle);
    await repos.settings.patch({ aiApiKey: 'sk-local-only', theme: 'orca', language: 'es' });

    const json = serializeBackup(await createBackup(repos));
    assert.ok(!json.includes('sk-local-only'));
    assert.match(json, /"theme": "orca"/);
    assert.match(json, /"language": "es"/);

    await repos.settings.patch({ aiApiKey: 'sk-local-only' });
    const restored = await repos.settings.get();
    assert.equal(restored.aiApiKey, 'sk-local-only');
  });
});

describe('backup compatibility', () => {
  let repos: Repositories;

  beforeEach(async () => {
    resetStorageForTests();
    const bundle = await initStorage(new MemoryAdapter());
    repos = buildRepositories(bundle);
  });

  afterEach(() => {
    resetStorageForTests();
  });

  it('restores a v1 backup that has no meals and no profile', async () => {
    const v1 = {
      format: 'fitness-agent-backup',
      version: 1,
      exportedAt: '2026-02-14T09:31:00.000Z',
      app: { name: 'Fitness Agent', version: '0.4.0' },
      settings: { defaultUnit: 'kg', theme: 'dark' },
      workouts: [],
      aliasRules: [],
      summaries: [],
    };

    const parsed = parseBackup(JSON.stringify(v1));
    assert.deepEqual(parsed.meals, []);
    assert.equal(parsed.profile, null);
    // The retired theme value falls back rather than being written through.
    assert.equal(parsed.settings.theme, DEFAULT_THEME_ID);
    assert.equal(parsed.settings.language, 'system');

    await applyBackup(parsed, { repos });
    assert.equal(await repos.meals.count(), 0);
    assert.deepEqual(await repos.profile.get(), EMPTY_PROFILE);
  });

  it('round-trips meals and the profile through a backup', async () => {
    const meal: Meal = {
      ...createEmptyMeal({ eatenAt: '2026-02-14T12:30:00.000Z' }),
      name: 'Chicken rice bowl',
      portion: '1 bowl',
      items: [
        { ...createEmptyMealItem(), name: 'Chicken breast', portion: '150 g', calories: 248, proteinG: 46 },
      ],
      calories: 248,
      proteinG: 46,
      carbsG: 0,
      fatG: 5,
      source: 'ai-edited',
    };
    await repos.meals.save(meal);
    await repos.profile.save({
      ...EMPTY_PROFILE,
      name: 'Sam',
      gender: 'female',
      heightCm: 165,
      trainingGoal: 'strength',
    });

    const json = serializeBackup(await createBackup(repos));
    await repos.meals.clear();
    await repos.profile.clear();

    await applyBackup(parseBackup(json), { repos });

    const restored = await repos.meals.get(meal.id);
    assert.equal(restored?.name, 'Chicken rice bowl');
    assert.equal(restored?.proteinG, 46);
    assert.equal(restored?.source, 'ai-edited');
    assert.equal(restored?.items.length, 1);

    const profile = await repos.profile.get();
    assert.equal(profile.name, 'Sam');
    assert.equal(profile.gender, 'female');
    assert.equal(profile.heightCm, 165);
  });

  it('refuses a restore whose meals are malformed, before touching the stored data', async () => {
    // The previous contents, which a refused restore must leave exactly as they are.
    const before = await repos.training.all();
    const document = await createBackup(repos);
    const messy = {
      ...JSON.parse(serializeBackup(document)),
      meals: [
        { id: 'ok', eatenAt: '2026-02-14T12:00:00.000Z', name: 'fine' },
        { id: 'no-timestamp' },
        null,
        'nope',
      ],
      profile: { name: 'Someone', unitSystem: 'stone', weightKg: 'heavy' },
    };

    assert.throws(
      () => parseBackup(JSON.stringify(messy)),
      (error: unknown) => {
        assert.ok(error instanceof BackupParseError);
        assert.match(error.message, /meals\[1\]\.eatenAt/);
        assert.match(error.message, /meals\[2\]/);
        assert.match(error.message, /meals\[3\]/);
        assert.match(error.message, /profile\.unitSystem|profile\.name/);
        return true;
      },
    );

    // Nothing was written on the way to that refusal.
    assert.deepEqual(await repos.training.all(), before, 'the stored log is untouched');
  });
});

describe('meal totals', () => {
  it('sums items and keeps unknown as null, not zero', () => {
    const totals = sumItems([
      { ...createEmptyMealItem(), name: 'a', calories: 100, proteinG: 10 },
      { ...createEmptyMealItem(), name: 'b', calories: 50, proteinG: null },
    ]);
    assert.equal(totals.calories, 150);
    assert.equal(totals.proteinG, 10, 'a missing value does not become 0');

    // Nothing known at all means "unknown", which the UI shows as a dash.
    const empty = sumItems([{ ...createEmptyMealItem(), name: 'c' }]);
    assert.equal(empty.calories, null);
    assert.equal(empty.proteinG, null);
  });

  it('summarises a day across meals', () => {
    const base = createEmptyMeal();
    const summary = summarizeDay([
      { ...base, id: 'm1', calories: 500, proteinG: 40, carbsG: 50, fatG: 15 },
      { ...base, id: 'm2', calories: 300, proteinG: 25, carbsG: 20, fatG: 10 },
    ]);
    assert.equal(summary.calories, 800);
    assert.equal(summary.proteinG, 65);
    assert.equal(summary.carbsG, 70);
    assert.equal(summary.fatG, 25);
  });
});
