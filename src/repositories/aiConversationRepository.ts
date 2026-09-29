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

  async recent(): Promise<AiConversationEntry[]> {
    const stored = await this.store.get<unknown>(CONVERSATION_KEY);
    if (!Array.isArray(stored)) return [];
    return stored
      .map(normalizeEntry)
      .filter((entry): entry is AiConversationEntry => entry !== null)
      .slice(0, MAX_SAVED_EXCHANGES);
  }

  async save(entries: readonly AiConversationEntry[]): Promise<void> {
    const normalized = entries
      .map(normalizeEntry)
      .filter((entry): entry is AiConversationEntry => entry !== null)
      .slice(0, MAX_SAVED_EXCHANGES);
    await this.store.set(CONVERSATION_KEY, normalized);
  }

  async clear(): Promise<void> {
    await this.store.remove(CONVERSATION_KEY);
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
