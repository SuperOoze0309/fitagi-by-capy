import type { AiRole } from '../domain/types';
import type { KeyValueStore } from '../storage/adapter';

export interface AiConversationEntry {
  id: string;
  role: AiRole;
  question: string;
  answer: string;
  contextSections: string[];
  contextCharacters: number;
  createdAt: string;
}

const CONVERSATION_KEY = 'conversation.v1';
const MAX_SAVED_EXCHANGES = 100;
const AI_ROLES: AiRole[] = ['recorder', 'reminder', 'coach'];

/** Device-local conversation history for the optional AI assistant. */
export class AiConversationRepository {
  constructor(private readonly store: KeyValueStore) {}

  /**
   * Serialises read-modify-write, like every other multi-step write in the app: two
   * saves started in the same tick used to read the same snapshot, so the second
   * replaced the first and an exchange disappeared.
   */
  private writeQueue: Promise<void> = Promise.resolve();
  private generation = 0;

  /** Capture before starting a request; clearing invalidates outstanding answers. */
  get revision(): number {
    return this.generation;
  }

  async recent(): Promise<AiConversationEntry[]> {
    const stored = await this.store.get<unknown>(CONVERSATION_KEY);
    if (!Array.isArray(stored)) return [];
    return stored
      .map(normalizeEntry)
      .filter((entry): entry is AiConversationEntry => entry !== null)
      .slice(0, MAX_SAVED_EXCHANGES);
  }

  /**
   * Add exchanges to the front of the transcript, keeping what is already stored.
   *
   * This is what the AI page uses. A full-snapshot save applied whatever the page
   * happened to be holding, so a page whose history read had failed — or a second page
   * open at the same time — silently erased exchanges it had never seen. Appending
   * cannot destroy rows it did not read.
   */
  async append(entries: readonly AiConversationEntry[], revision = this.generation): Promise<void> {
    const incoming = entries
      .map(normalizeEntry)
      .filter((entry): entry is AiConversationEntry => entry !== null);
    if (incoming.length === 0) return;

    await this.withWriteLock(async () => {
      if (revision !== this.generation) return;
      const existing = await this.recent();
      if (revision !== this.generation) return;
      const incomingIds = new Set(incoming.map((entry) => entry.id));
      const merged = [...incoming, ...existing.filter((entry) => !incomingIds.has(entry.id))].slice(
        0,
        MAX_SAVED_EXCHANGES,
      );
      await this.store.set(CONVERSATION_KEY, merged);
    });
  }

  /** Replace the whole transcript, for a caller that knows it holds every entry. */
  async save(entries: readonly AiConversationEntry[]): Promise<void> {
    const normalized = entries
      .map(normalizeEntry)
      .filter((entry): entry is AiConversationEntry => entry !== null)
      .slice(0, MAX_SAVED_EXCHANGES);
    await this.withWriteLock(async () => {
      await this.store.set(CONVERSATION_KEY, normalized);
    });
  }

  async clear(): Promise<void> {
    this.generation += 1;
    await this.withWriteLock(async () => {
      await this.store.remove(CONVERSATION_KEY);
    });
  }

  private async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    const run = previous.then(work, work);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function normalizeEntry(value: unknown): AiConversationEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.question !== 'string' ||
    typeof row.answer !== 'string' ||
    !AI_ROLES.includes(row.role as AiRole)
  ) {
    return null;
  }

  return {
    id: row.id,
    role: row.role as AiRole,
    question: row.question,
    answer: row.answer,
    contextSections: Array.isArray(row.contextSections)
      ? row.contextSections.filter((section): section is string => typeof section === 'string')
      : [],
    contextCharacters:
      typeof row.contextCharacters === 'number' && Number.isFinite(row.contextCharacters)
        ? Math.max(0, row.contextCharacters)
        : 0,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
  };
}
