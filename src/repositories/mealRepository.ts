import type { Collection, KeyValueStore } from '../storage/adapter';
import type { Meal, MealItem, MealSource } from '../domain/types';
import { nowIso } from '../domain/datetime';
import { newId } from '../domain/ids';
import { localDateKey } from '../domain/datetime';

/**
 * Meal records.
 *
 * Same local-first contract as workouts: one document per meal, stored on the
 * device, no account and no server. Deleting a meal also deletes its image.
 */
export class MealRepository {
  constructor(
    private readonly collection: Collection<Meal>,
    private readonly images: KeyValueStore,
  ) {}

  /** Newest first. */
  async all(): Promise<Meal[]> {
    const rows = await this.collection.all();
    return rows.sort((a, b) => new Date(b.eatenAt).getTime() - new Date(a.eatenAt).getTime());
  }

  async get(id: string): Promise<Meal | null> {
    return this.collection.get(id);
  }

  async forDate(dateKey: string): Promise<Meal[]> {
    return (await this.all()).filter((meal) => localDateKey(meal.eatenAt) === dateKey);
  }

  async between(fromKey: string, toKey: string): Promise<Meal[]> {
    return (await this.all()).filter((meal) => {
      const key = localDateKey(meal.eatenAt);
      return key >= fromKey && key <= toKey;
    });
  }

  async count(): Promise<number> {
    return this.collection.count();
  }

  async save(meal: Meal): Promise<Meal> {
    const next: Meal = { ...meal, id: meal.id, updatedAt: nowIso() };
    await this.collection.put(next);
    return next;
  }

  async putMany(meals: Meal[]): Promise<void> {
    await this.collection.putMany(meals);
  }

  /** Deleting a meal removes its photo too, so nothing is orphaned on disk. */
  async remove(id: string): Promise<void> {
    const existing = await this.collection.get(id);
    if (existing?.imageKey) await this.images.remove(existing.imageKey);
    await this.collection.remove(id);
  }

  async clear(): Promise<void> {
    // Photos live in their own store, so wiping the collection is not enough.
    for (const meal of await this.collection.all()) {
      if (meal.imageKey) await this.images.remove(meal.imageKey);
    }
    await this.collection.clear();
  }

  // -- photos ------------------------------------------------------------------

  /**
   * Store a compressed data URL under the meal's own key.
   *
   * Each photo is its own row rather than one blob holding every photo: writing a
   * new picture would otherwise rewrite every existing one. The key is derived
   * from the meal id, so a meal has at most one photo and re-analysing replaces it.
   */
  async saveImage(mealId: string, dataUrl: string): Promise<string> {
    const key = imageKeyFor(mealId);
    await this.images.set(key, dataUrl);
    return key;
  }

  async loadImage(key: string): Promise<string | null> {
    return this.images.get<string>(key);
  }

  async removeImage(key: string): Promise<void> {
    await this.images.remove(key);
  }
}

/** Deterministic key so a meal has at most one photo, and re-analysing replaces it. */
export function imageKeyFor(mealId: string): string {
  return `image:${mealId}`;
}

/** An empty meal with sensible defaults, used by the editor. */
export function createEmptyMeal(options: { eatenAt?: string; source?: MealSource } = {}): Meal {
  const timestamp = nowIso();
  return {
    id: newId('meal'),
    eatenAt: options.eatenAt ?? timestamp,
    name: '',
    portion: '',
    items: [],
    calories: null,
    proteinG: null,
    carbsG: null,
    fatG: null,
    notes: '',
    source: options.source ?? 'manual',
    confidence: null,
    imageKey: null,
    aiNote: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createEmptyMealItem(): MealItem {
  return {
    id: newId('item'),
    name: '',
    portion: '',
    calories: null,
    proteinG: null,
    carbsG: null,
    fatG: null,
  };
}

/**
 * Sum an item list into meal totals.
 *
 * Used when the AI returns items, and after a manual edit of one item: the meal's
 * own totals are always the sum of what is on screen, so the two can never
 * disagree. A null everywhere stays null rather than becoming 0, so "unknown"
 * is not displayed as "zero calories".
 */
export function sumItems(items: MealItem[]): {
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
} {
  const sum = (pick: (item: MealItem) => number | null): number | null => {
    let total = 0;
    let seen = false;
    for (const item of items) {
      const value = pick(item);
      if (value === null || !Number.isFinite(value)) continue;
      total += value;
      seen = true;
    }
    return seen ? Math.round(total * 10) / 10 : null;
  };

  return {
    calories: sum((item) => item.calories),
    proteinG: sum((item) => item.proteinG),
    carbsG: sum((item) => item.carbsG),
    fatG: sum((item) => item.fatG),
  };
}

/** Daily nutrition totals for the meals list header. */
export function summarizeDay(meals: Meal[]): {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
} {
  const total = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  for (const meal of meals) {
    total.calories += meal.calories ?? 0;
    total.proteinG += meal.proteinG ?? 0;
    total.carbsG += meal.carbsG ?? 0;
    total.fatG += meal.fatG ?? 0;
  }
  return {
    calories: Math.round(total.calories),
    proteinG: Math.round(total.proteinG * 10) / 10,
    carbsG: Math.round(total.carbsG * 10) / 10,
    fatG: Math.round(total.fatG * 10) / 10,
  };
}
