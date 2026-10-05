import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CollectionCache } from '@/storage/adapter';
import { destroyStorage, initStorage, resetStorageForTests } from '@/storage';
import { buildRepositories, type Repositories } from '@/repositories';
import { MemoryAdapter } from '@/test/MemoryAdapter';
import { EMPTY_PROFILE, DEFAULT_SETTINGS } from '@/repositories/settingsRepository';
import { createWorkout } from '@/domain/workout';
import { lbToKg } from '@/domain/units';
import { ContextBuilder } from '@/services/ai/contextBuilder';
import { OpenAiCompatibleProvider } from '@/services/ai/openaiProvider';
import { AiService } from '@/services/ai';
import { buildProfileBlock, describeWeightForDisplay, resolveMetrics } from '@/services/ai/userContext';
import { RequestSession, shouldSendOnEnter } from '@/services/ai/requestSession';
import { contextSectionLabel } from '@/services/ai/contextLabels';
import { createTranslator } from '@/i18n';
import { draftToPreview, materializeDraft, previewToDraft } from '@/services/ai/materialize';
import { parseWorkoutText } from '@/services/ai/localParser';
import { applyBackup, createBackup, sameAiEndpoint } from '@/services/backup';
import { AiConversationRepository, type AiConversationEntry } from '@/repositories/aiConversationRepository';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbAdapter } from '@/storage/idbAdapter';
import { SummaryService } from '@/services/summaries/summaryService';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let repos: Repositories;
beforeEach(async () => { resetStorageForTests(); repos = buildRepositories(await initStorage(new MemoryAdapter())); });
afterEach(() => resetStorageForTests());

function provider(response: Response, timeout = 1000) {
  return new OpenAiCompatibleProvider({ baseUrl: 'https://model.test/v1', model: 'test', apiKey: '', requestTimeoutMs: timeout },
    new ContextBuilder(repos), (async () => response) as typeof fetch);
}
function event(text: string) { return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`; }
function streamResponse(bytes: Uint8Array[], close = true, onCancel = () => {}) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of bytes) controller.enqueue(chunk); if (close) controller.close(); },
    cancel: onCancel,
  }), { headers: { 'content-type': 'text/event-stream' } });
}
const encode = (text: string) => new TextEncoder().encode(text);

describe('AI transport termination and cancellation', () => {
  for (const separator of ['\n', '\r\n', '\r']) {
    it(`accepts ${JSON.stringify(separator)} SSE framing split one byte at a time`, async () => {
      const bytes = encode(`${event('你好')}${separator}${separator}data: [DONE]${separator}${separator}`);
      const chunks = [...bytes].map((byte) => new Uint8Array([byte]));
      const deltas: string[] = [];
      const result = await provider(streamResponse(chunks)).streamChat([], (text) => deltas.push(text));
      assert.equal(result, '你好'); assert.deepEqual(deltas, ['你好']);
    });
  }
  it('finishes on DONE without waiting for the gateway to close and ignores later text', async () => {
    let cancelled = false;
    const response = streamResponse([encode(`${event('A')}\n\ndata: [DONE]\n\n${event('BAD')}\n\n`)], false, () => { cancelled = true; });
    assert.equal(await provider(response).streamChat([], () => {}), 'A');
    assert.equal(cancelled, true); assert.equal(response.body!.locked, false);
  });
  it('accepts a final event without a blank line', async () => {
    assert.equal(await provider(streamResponse([encode(event('tail'))])).streamChat([], () => {}), 'tail');
  });
  it('joins multiline data fields and ignores comments and unrelated fields', async () => {
    const body = ': ping\r\nevent: message\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"joined"}}]}\r\n\r\n';
    assert.equal(await provider(streamResponse([encode(body)])).streamChat([], () => {}), 'joined');
  });
  it('cancels and releases a stalled stream reader', async () => {
    const first = deferred<void>(); let cancelled = false;
    const response = streamResponse([encode(`${event('partial')}\n\n`)], false, () => { cancelled = true; });
    const controller = new AbortController();
    const request = provider(response).streamChat([], () => first.resolve(), { signal: controller.signal });
    await first.promise; controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    assert.equal(cancelled, true); assert.equal(response.body!.locked, false);
  });
  it('bounds a stream that never produces a response body', async () => {
    const response = streamResponse([], false);
    await assert.rejects(provider(response, 15).streamChat([], () => {}), /timed out/);
    assert.equal(response.body!.locked, false);
  });
  it('cancels a nonstreaming response body', async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } });
    const request = provider(response).chat([], { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
  });
  it('passes cancellation to a provider without streaming support', async () => {
    const service = new AiService(repos, { ...DEFAULT_SETTINGS, aiEnabled: true, aiBaseUrl: 'https://model.test/v1', aiModel: 'test' });
    const controller = new AbortController(); let received: AbortSignal | undefined;
    service.llm.streamChat = undefined;
    service.llm.chat = async (_messages, options) => { received = options?.signal; controller.abort(); return 'late'; };
    const deltas: string[] = [];
    await assert.rejects(service.askStreaming('q', 'coach', (text) => deltas.push(text), { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(received, controller.signal); assert.deepEqual(deltas, []);
  });
});

describe('AI page request and history lifetime', () => {
  const row: AiConversationEntry = { id: 'new', role: 'coach', question: 'q', answer: 'a', contextSections: [], contextCharacters: 0, createdAt: '2026-10-04T12:00:00Z' };
  it('ignores an old completion after cancellation and starting another request', () => {
    const session = new RequestSession(); const old = session.begin()!;
    assert.equal(session.isActive, true);
    assert.equal(session.begin(), null); session.cancel();
    assert.equal(session.isActive, false);
    const next = session.begin()!;
    assert.equal(old.signal.aborted, true); assert.equal(session.isCurrent(old), false);
    assert.equal(session.finish(old), false); assert.equal(session.isCurrent(next), true);
  });
  it('does not resurrect chat when an old request completes after clear', async () => {
    const revision = repos.aiConversation.revision;
    await repos.aiConversation.clear();
    await repos.aiConversation.append([row], revision);
    assert.deepEqual(await repos.aiConversation.recent(), []);
    await repos.aiConversation.append([row]);
    assert.equal((await repos.aiConversation.recent()).length, 1);
  });
  it('invalidates an append already waiting for its history read', async () => {
    const adapter = new MemoryAdapter(); const store = adapter.scope().kv('aiChat');
    const gate = deferred<void>(); const entered = deferred<void>(); const get = store.get.bind(store);
    store.get = async <T>(key: string): Promise<T | null> => { entered.resolve(); await gate.promise; return get<T>(key); };
    const conversation = new AiConversationRepository(store);
    const append = conversation.append([row]); await entered.promise;
    const clear = conversation.clear(); gate.resolve(); await append; await clear;
    assert.equal(await get('conversation.v1'), null);
  });
  it('only sends a plain Enter, never IME confirmation or Shift+Enter', () => {
    const event = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 };
    assert.equal(shouldSendOnEnter(event), true);
    assert.equal(shouldSendOnEnter({ ...event, isComposing: true }), false);
    assert.equal(shouldSendOnEnter({ ...event, keyCode: 229 }), false);
    assert.equal(shouldSendOnEnter({ ...event, shiftKey: true }), false);
  });
  it('localizes stable section IDs and previously saved English labels', () => {
    for (const locale of ['en', 'zh-CN', 'es'] as const) {
      const { t } = createTranslator(locale);
      assert.equal(contextSectionLabel('currentWorkout', t), t('ai.contextCurrent'));
      assert.equal(contextSectionLabel('current workout', t), t('ai.contextCurrent'));
      assert.equal(contextSectionLabel('previous conversation (3 exchanges)', t), t('ai.contextConversation', { count: 3 }));
      assert.equal(contextSectionLabel('exerciseSessions:5', t), t('ai.contextExercise', { count: 5 }));
      assert.equal(contextSectionLabel('unrecognized old label', t), t('ai.contextUnknown'));
    }
  });
});

describe('fitness values and context date windows', () => {
  it('keeps form-stored kilograms in an imperial profile', async () => {
    const weightKg = Math.round(lbToKg(150) * 10) / 10;
    const profile = await repos.profile.save({ ...EMPTY_PROFILE, unitSystem: 'imperial', weightKg, goalWeightKg: 60 });
    assert.equal(resolveMetrics(profile).weightKg, 68);
    assert.equal(resolveMetrics(profile).goalWeightKg, 60);
    assert.match(buildProfileBlock(profile), /Weight: 68 kg \(149.9 lb\)/);
    assert.match(describeWeightForDisplay(profile), /149.9 lb/);
    assert.equal(resolveMetrics({ ...profile, unitSystem: 'metric' }).weightKg, 68);
  });
  it('preserves RIR from parser through preview edits and materialization', async () => {
    const draft = parseWorkoutText('bench 80kg 8 8 7 6 rir2', { defaultUnit: 'kg' });
    const preview = draftToPreview(draft, [], (prefix) => prefix);
    assert.equal(preview[0]!.sets[0]!.rir, 2);
    preview[0]!.sets[0]!.rir = 3;
    const result = await materializeDraft(previewToDraft(preview, '', 'local'), createWorkout(), repos);
    assert.deepEqual(result.workout.exercises[0]!.sets.map((set) => set.rir), [3, 2, 2, 2]);
  });
  it('keeps the prior weekend in last 7 days but excludes it from Monday weekly totals', async () => {
    const weekend = { ...createWorkout(), completed: true, startTime: new Date(2026, 9, 3, 12).toISOString() };
    await repos.training.put(weekend);
    const context = await new ContextBuilder(repos).build({ now: new Date(2026, 9, 5, 12) });
    assert.ok(context.sections.includes('last7Days'));
    assert.ok(!context.sections.includes('weeklyComputed'));
  });
  it('excludes future workouts from recent, exercise, weekly and monthly context', async () => {
    const draft = parseWorkoutText('Future lift 80kg 8', { defaultUnit: 'kg' });
    const result = await materializeDraft(draft, { ...createWorkout(), completed: true, startTime: new Date(2026, 9, 5, 18).toISOString() }, repos);
    await repos.training.put(result.workout);
    const context = await new ContextBuilder(repos).build({ now: new Date(2026, 9, 5, 12), includeMonthly: true, exerciseNames: ['Future lift'] });
    assert.equal(context.text, ''); assert.deepEqual(context.sections, []);
  });
});

describe('saved summaries exclude future context', () => {
  it('does not reuse a daily summary containing a future workout', async () => {
    const now = new Date(2026, 9, 5, 12);
    const past = await materializeDraft(parseWorkoutText('Past lift 60kg 8', { defaultUnit: 'kg' }),
      { ...createWorkout(), completed: true, startTime: new Date(2026, 9, 5, 8).toISOString() }, repos);
    const future = await materializeDraft(parseWorkoutText('Future lift 999kg 8', { defaultUnit: 'kg' }),
      { ...createWorkout(), completed: true, startTime: new Date(2026, 9, 5, 18).toISOString() }, repos);
    await repos.training.putMany([past.workout, future.workout]);
    await new SummaryService(repos).refreshForWorkout(future.workout, 'kg');
    const context = await new ContextBuilder(repos).build({ now, includeMonthly: true });
    assert.ok(context.text.includes('Past lift'));
    assert.ok(!/Future lift|999/.test(context.text));
  });
});

describe('backup endpoint credential trust', () => {
  it('normalizes harmless URL differences while preserving endpoint path boundaries', () => {
    assert.equal(sameAiEndpoint('https://MODEL.test:443/v1/', 'https://model.test/v1'), true);
    assert.equal(sameAiEndpoint('https://model.test/v1', 'https://model.test/v2'), false);
    assert.equal(sameAiEndpoint('https://model.test/v1', 'https://other.test/v1'), false);
    assert.equal(sameAiEndpoint('not a url', 'not a url'), false);
  });
  it('clears credentials and disables AI when a backup redirects the endpoint', async () => {
    await repos.settings.patch({ aiEnabled: true, aiBaseUrl: 'https://trusted.test/v1', aiApiKey: 'FAKE_KEY', aiModel: 'test' });
    const backup = await createBackup(repos); backup.settings.aiBaseUrl = 'https://other.test/v1';
    const restored = await applyBackup(backup, { repos });
    assert.equal(restored.settings.aiApiKey, ''); assert.equal(restored.settings.aiEnabled, false);
    let requests = 0;
    const service = new AiService(repos, restored.settings, (async () => { requests += 1; throw Error('unexpected network'); }) as typeof fetch);
    await assert.rejects(service.askStreaming('q', 'coach', () => {})); assert.equal(requests, 0);
  });
  it('preserves the device key for the same endpoint', async () => {
    await repos.settings.patch({ aiEnabled: true, aiBaseUrl: 'https://trusted.test/v1/', aiApiKey: 'FAKE_KEY' });
    const backup = await createBackup(repos); backup.settings.aiBaseUrl = 'https://trusted.test/v1';
    assert.equal((await applyBackup(backup, { repos })).settings.aiApiKey, 'FAKE_KEY');
  });
});

describe('cache generation and storage reset', () => {
  it('deduplicates parallel initial reads', async () => {
    const inner = new MemoryAdapter().scope().collection<{ id: string }>('workouts');
    const gate = deferred<{ id: string }[]>(); let reads = 0;
    inner.all = () => { reads += 1; return gate.promise; };
    const cache = new CollectionCache(inner);
    const first = cache.all(); const second = cache.all(); gate.resolve([{ id: 'one' }]);
    assert.deepEqual(await first, await second); assert.equal(reads, 1);
  });
  it('does not publish a stale initial read after a write', async () => {
    const inner = new MemoryAdapter().scope().collection<{ id: string }>('workouts');
    const all = inner.all.bind(inner); const gate = deferred<{ id: string }[]>(); let reads = 0;
    inner.all = () => ++reads === 1 ? gate.promise : all();
    const cache = new CollectionCache(inner); const initial = cache.all();
    await cache.put({ id: 'new' }); assert.equal(await cache.count(), 1);
    gate.resolve([]); assert.deepEqual(await initial, [{ id: 'new' }]); assert.equal(await cache.count(), 1);
  });
  it('does not publish old rows after clear or invalidation', async () => {
    const inner = new MemoryAdapter().scope().collection<{ id: string }>('workouts');
    await inner.put({ id: 'old' }); const all = inner.all.bind(inner);
    const gate = deferred<{ id: string }[]>(); let reads = 0;
    inner.all = () => ++reads === 1 ? gate.promise : all();
    const cache = new CollectionCache(inner); const pending = cache.all();
    await cache.clear(); cache.invalidate(); gate.resolve([{ id: 'old' }]);
    assert.deepEqual(await pending, []);
  });
  it('initializes a fresh bundle after destroying storage', async () => {
    await repos.training.put(createWorkout()); await destroyStorage();
    const next = await initStorage(new MemoryAdapter());
    assert.equal(await next.workouts.count(), 0);
  });
});

describe('storage lifecycle coordination', () => {
  it('coordinates destruction with an in-flight boot and a new initialization', async () => {
    resetStorageForTests(); const adapter = new MemoryAdapter();
    const gate = deferred<void>(); adapter.init = () => gate.promise;
    const boot = initStorage(adapter); const deletion = destroyStorage();
    const replacement = new MemoryAdapter(); const reopen = initStorage(replacement);
    gate.resolve(); await boot; await deletion;
    assert.equal((await reopen).adapter, replacement);
  });
});

describe('IndexedDB bounded operations and deletion', () => {
  const operations = ['all', 'get', 'count', 'put', 'clear', 'remove', 'kvGet', 'kvSet', 'kvRemove'] as const;
  for (const operation of operations) {
    it(`times out and aborts a stalled ${operation} transaction`, async (context) => {
      globalThis.indexedDB = new IDBFactory();
      const adapter = new IndexedDbAdapter(); await adapter.init();
      const db = (adapter as unknown as { db: IDBDatabase }).db;
      let aborted = 0;
      const request = {} as IDBRequest;
      const store = { get: () => request, getAll: () => request, count: () => request,
        put: () => request, clear: () => request, delete: () => request };
      db.transaction = (() => ({ objectStore: () => store, abort: () => { aborted += 1; } })) as unknown as IDBDatabase['transaction'];
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const scope = adapter.scope(); const rows = scope.collection<{ id: string }>('workouts'); const kv = scope.kv('aiChat');
      const work = operation === 'all' ? rows.all() : operation === 'get' ? rows.get('x')
        : operation === 'count' ? rows.count() : operation === 'put' ? rows.put({ id: 'x' })
        : operation === 'clear' ? rows.clear() : operation === 'remove' ? rows.remove('x')
        : operation === 'kvGet' ? kv.get('x') : operation === 'kvSet' ? kv.set('x', 'value') : kv.remove('x');
      const failure = assert.rejects(work, /timed out/);
      context.mock.timers.tick(8001); await failure;
      assert.equal(aborted, 1); await adapter.close();
    });
  }
  it('does not report a blocked deletion as successful', async () => {
    globalThis.indexedDB = new IDBFactory();
    const adapter = new IndexedDbAdapter(); await adapter.init();
    await adapter.scope().collection<{ id: string }>('workouts').put({ id: 'original' });
    const extra = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fitness-agent');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    let finished = false; const deletion = adapter.destroy().then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(finished, false);
    const persisted = await new Promise<number>((resolve) => {
      const request = extra.transaction('workouts').objectStore('workouts').count();
      request.onsuccess = () => resolve(request.result);
    });
    assert.equal(persisted, 1); extra.close(); await deletion;
    assert.equal(finished, true);
  });
});
