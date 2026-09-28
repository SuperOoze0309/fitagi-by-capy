import type { Collection } from '../storage/adapter';
import type { AliasRule } from '../domain/types';
import { nowIso } from '../domain/datetime';
import { newRuleId } from '../domain/ids';
import { exerciseGroupKey } from '../domain/workout';

/**
 * User-owned exercise alias rules.
 *
 * Priority order when resolving a name (Phase 3 wires the LLM in, but the order
 * is fixed now so the LLM can never override the user):
 *   1. explicit user rule   ← this repository
 *   2. previously confirmed mapping
 *   3. LLM suggestion
 *   4. the raw name
 */
export class RuleRepository {
  constructor(private readonly collection: Collection<AliasRule>) {}

  async all(): Promise<AliasRule[]> {
    const rows = await this.collection.all();
    return rows.sort((a, b) => a.match.localeCompare(b.match));
  }

  async get(id: string): Promise<AliasRule | null> {
    return this.collection.get(id);
  }

  async count(): Promise<number> {
    return this.collection.count();
  }

  /** Longest match wins, so "incline bench" beats "bench". */
  async resolve(name: string): Promise<string | null> {
    const key = exerciseGroupKey(name);
    if (key === '') return null;
    const rules = await this.all();
    let best: AliasRule | null = null;
    for (const rule of rules) {
      const match = rule.match.toLowerCase();
      if (key === match || key.includes(match)) {
        if (!best || match.length > best.match.length) best = rule;
      }
    }
    return best ? best.normalized : null;
  }

  async save(input: { id?: string; match: string; normalized: string }): Promise<AliasRule> {
    const rule: AliasRule = {
      id: input.id ?? newRuleId(),
      match: exerciseGroupKey(input.match),
      normalized: input.normalized.trim(),
      createdAt: nowIso(),
    };
    await this.collection.put(rule);
    return rule;
  }

  async remove(id: string): Promise<void> {
    await this.collection.remove(id);
  }

  async clear(): Promise<void> {
    await this.collection.clear();
  }
}
