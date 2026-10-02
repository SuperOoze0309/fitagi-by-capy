import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { destroyStorage, initStorage, resetStorageForTests } from '@/storage';
import { buildRepositories } from '@/repositories';
import type { AiConversationEntry } from '@/repositories/aiConversationRepository';
import { conversationMessages, messageText } from '@/services/ai';
import type { ConversationTurn } from '@/services/ai';

/**
 * Stored AI conversation.
 *
 * The transcript is the only place a user keeps what the model told them, so the
 * two things that matter are that it survives a restart and that a malformed row
 * cannot take the rest of it down. The follow-up memory rules are asserted here
 * too: they are the only thing standing between a long conversation and an
 * unbounded request.
 */

function entry(overrides: Partial<AiConversationEntry> = {}): AiConversationEntry {
  return {
    id: 'e1',
    role: 'coach',
    question: 'How is my bench going?',
    answer: 'It is up 5 kg since March.',
    contextSections: ['recent workouts'],
    contextCharacters: 1_200,
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  };
}

/** The stored shape is intentionally loose on read, so malformed rows are built as plain data. */
function corrupt(rows: readonly unknown[]): readonly unknown[] {
  return rows;
}

describe('AI conversation storage', () => {
  it('saves exchanges and reads them back in the order they arrive', async () => {
    const bundle = await initStorage();
    const repo = buildRepositories(bundle).aiConversation;

    await repo.save([
      entry({ id: 'newest', question: 'third' }),
      entry({ id: 'older', question: 'second' }),
    ]);

    const recent = await repo.recent();
    assert.deepEqual(
      recent.map((row) => row.id),
      ['newest', 'older'],
      'stored order is preserved: newest first',
    );
    assert.equal(recent[0]?.answer, 'It is up 5 kg since March.');
    assert.equal(recent[0]?.contextCharacters, 1_200);
  });

  it('drops a malformed row instead of losing the whole transcript', async () => {
    const bundle = await initStorage();
    const repo = buildRepositories(bundle).aiConversation;
    const store = bundle.scope.kv('aiChat');

    await store.set(
      'conversation.v1',
      corrupt([
        entry({ id: 'good' }),
        null,
        'not an object',
        { id: 'no-answer', role: 'coach', question: 'q' },
        { id: 'bad-role', role: 'wizard', question: 'q', answer: 'a' },
        { id: 'partial', role: 'coach', question: 'q', answer: 'a' },
      ]),
    );

    const recent = await repo.recent();
    assert.deepEqual(
      recent.map((row) => row.id),
      ['good', 'partial'],
      'only rows with an id, a role, a question and an answer survive',
    );
    assert.deepEqual(recent[1]?.contextSections, [], 'a missing field becomes an empty list');
    assert.equal(recent[1]?.contextCharacters, 0, 'a missing count becomes zero, never NaN');
    assert.equal(recent[1]?.createdAt, '');
  });

  it('reads nothing at all from a store that was never written', async () => {
    const bundle = await initStorage();
    assert.deepEqual(await buildRepositories(bundle).aiConversation.recent(), []);
  });

  it('keeps the most recent hundred exchanges', async () => {
    const bundle = await initStorage();
    const repo = buildRepositories(bundle).aiConversation;

    const many = Array.from({ length: 130 }, (_, index) => entry({ id: `e${index}` }));
    await repo.save(many);

    const recent = await repo.recent();
    assert.equal(recent.length, 100, 'a long-running conversation must not grow without bound');
    assert.equal(recent[0]?.id, 'e0', 'the newest end of the list is what is kept');
  });

  it('appends without touching exchanges it never read', async () => {
    /*
     * The page used to save a full snapshot of what it was holding. If its history read
     * had failed, or a second page was open, that snapshot erased everything it had not
     * seen. Appending is the fix: the stored rows survive.
     */
    const bundle = await initStorage();
    const repo = buildRepositories(bundle).aiConversation;

    await repo.save([entry({ id: 'stored-1' }), entry({ id: 'stored-2' })]);
    await repo.append([entry({ id: 'fresh' })]);

    assert.deepEqual(
      (await repo.recent()).map((row) => row.id),
      ['fresh', 'stored-1', 'stored-2'],
      'the new exchange goes to the front and the unread ones stay',
    );
  });

  it('does not duplicate an exchange that is appended twice', async () => {
    const bundle = await initStorage();
    const repo = buildRepositories(bundle).aiConversation;

    await repo.append([entry({ id: 'once' })]);
    await repo.append([entry({ id: 'once', answer: 're-asked and answered again' })]);

    const recent = await repo.recent();
    assert.equal(recent.length, 1, 'the same exchange id is one row');
    assert.equal(recent[0]?.answer, 're-asked and answered again', 'the newest text wins');
  });

  it('keeps both exchanges when two are appended at the same time', async () => {
    const bundle = await initStorage();
    const repo = buildRepositories(bundle).aiConversation;

    await Promise.all([
      repo.append([entry({ id: 'concurrent-a' })]),
      repo.append([entry({ id: 'concurrent-b' })]),
    ]);

    const ids = (await repo.recent()).map((row) => row.id).sort();
    assert.deepEqual(ids, ['concurrent-a', 'concurrent-b'], 'neither append may be lost');
  });

  it('keeps the hundred-exchange cap when appending', async () => {
    const bundle = await initStorage();
    const repo = buildRepositories(bundle).aiConversation;

    await repo.save(Array.from({ length: 99 }, (_, index) => entry({ id: `old-${index}` })));
    await repo.append([entry({ id: 'new-1' }), entry({ id: 'new-2' })]);

    const recent = await repo.recent();
    assert.equal(recent.length, 100);
    assert.equal(recent[0]?.id, 'new-1');
    assert.equal(
      recent.some((row) => row.id === 'old-98'),
      false,
      'the oldest rows fall off the end',
    );
  });

  it('clears the transcript on request', async () => {
    const bundle = await initStorage();
    const repo = buildRepositories(bundle).aiConversation;

    await repo.save([entry()]);
    await repo.clear();

    assert.deepEqual(await repo.recent(), []);
    assert.equal(await bundle.scope.kv('aiChat').get('conversation.v1'), null);
  });

  it('survives a restart, and a v3 database gains the store without losing anything', async () => {
    // A database exactly as the release before this feature left it: version 3,
    // six collections, four key/value stores.
    const v3Request = indexedDB.open('fitness-agent', 3);
    await new Promise<void>((resolve, reject) => {
      v3Request.onupgradeneeded = () => {
        const db = v3Request.result;
        for (const name of ['workouts', 'rules', 'summaries', 'meals', 'reminders', 'plans']) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
        for (const name of ['settings', 'presets', 'images', 'profile']) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      v3Request.onsuccess = () => resolve();
      v3Request.onerror = () => reject(v3Request.error);
    });

    const legacyDb = v3Request.result;
    const workout = {
      id: 'v3-workout',
      startTime: '2026-03-01T09:00:00.000Z',
      endTime: '2026-03-01T10:00:00.000Z',
      durationSec: 3600,
      notes: 'logged before the conversation store existed',
      heartRate: null,
      exercises: [],
      completed: true,
      createdAt: '2026-03-01T09:00:00.000Z',
      updatedAt: '2026-03-01T10:00:00.000Z',
    };
    await new Promise<void>((resolve, reject) => {
      const tx = legacyDb.transaction('workouts', 'readwrite');
      tx.objectStore('workouts').put(workout);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacyDb.close();

    // Open it through the app, which upgrades to v4.
    const bundle = await initStorage();
    const repos = buildRepositories(bundle);

    assert.equal((await repos.training.all()).length, 1, 'the v3 workout survived the upgrade');
    assert.deepEqual(await repos.aiConversation.recent(), [], 'the new store starts empty');

    await repos.aiConversation.save([entry({ id: 'after-upgrade' })]);

    // Restart the app against the same database: close the connection and open a
    // fresh one, rather than destroying storage, which would delete the database
    // and prove nothing.
    await bundle.adapter.close();
    resetStorageForTests();

    const reopened = buildRepositories(await initStorage());
    const recent = await reopened.aiConversation.recent();
    assert.equal(recent.length, 1, 'the conversation is still there after a restart');
    assert.equal(recent[0]?.id, 'after-upgrade');
    assert.equal(recent[0]?.question, 'How is my bench going?');
  });
});

describe('follow-up memory', () => {
  const turn = (question: string, answer: string): ConversationTurn => ({ question, answer });

  it('sends nothing when there is no history', () => {
    const memory = conversationMessages([]);
    assert.deepEqual(memory.messages, []);
    assert.equal(memory.exchanges, 0);
    assert.equal(memory.characters, 0);
  });

  it('keeps the most recent eight exchanges, oldest first', () => {
    const history = Array.from({ length: 12 }, (_, index) =>
      turn(`question ${index}`, `answer ${index}`),
    );

    const memory = conversationMessages(history);
    assert.equal(memory.exchanges, 8);
    assert.equal(memory.messages.length, 16, 'one user and one assistant message per exchange');
    assert.equal(memory.messages[0]?.content, 'question 4', 'the oldest kept turn comes first');
    assert.equal(memory.messages[0]?.role, 'user');
    assert.equal(memory.messages[1]?.role, 'assistant');
    assert.equal(memory.messages[15]?.content, 'answer 11', 'the newest turn comes last');
  });

  it('drops empty halves rather than sending blank turns', () => {
    const memory = conversationMessages([
      turn('', 'an answer with no question'),
      turn('a question with no answer', '   '),
      turn('real question', 'real answer'),
    ]);

    assert.equal(memory.exchanges, 1);
    assert.deepEqual(
      memory.messages.map((message) => message.content),
      ['real question', 'real answer'],
    );
  });

  it('trims an oversized answer instead of dropping the exchange', () => {
    const memory = conversationMessages([turn('q', 'x'.repeat(9_000))]);

    assert.equal(memory.exchanges, 1);
    const answer = messageText(memory.messages[1]!);
    assert.ok(answer.length < 2_600, 'a single answer is capped');
    assert.match(answer, /trimmed/, 'and it says so, rather than ending mid-sentence silently');
    assert.ok(answer.startsWith('xxx'), 'the useful beginning is kept');
  });

  it('stops adding exchanges once the character budget is spent', () => {
    const history = Array.from({ length: 8 }, (_, index) =>
      turn(`question ${index} ${'q'.repeat(1_000)}`, `answer ${index} ${'a'.repeat(2_200)}`),
    );

    const memory = conversationMessages(history);
    assert.ok(memory.exchanges < 8, 'the cap is enforced by size, not only by count');
    assert.ok(memory.characters <= 16_000, 'the request never exceeds the memory budget');
    assert.equal(
      messageText(memory.messages[memory.messages.length - 1]!).startsWith('answer 7'),
      true,
      'the newest exchange is the one that must survive',
    );
  });
});

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetStorageForTests();
});

afterEach(async () => {
  await destroyStorage().catch(() => undefined);
  resetStorageForTests();
});
