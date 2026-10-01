# 隔离复现附录 · 2026-10-01

对应 [DeepSeek 修复任务单](review-2026-10-01.md)，基线 `5a2eaa5`。

## 已执行结果

现有单元测试单独运行：

```text
npm test
tests 283
suites 55
pass 283
fail 0
cancelled 0
skipped 0
exit 0
```

隔离探针结果（不是修复成功报告）：

```text
{"probes":20,"reproduced":20,"errors":0}
exit 0
```

| 探针 | 关联任务 | 基线实际观察 |
| --- | --- | --- |
| native-connection-contract | DS-01 | 只调用 isDBExists 即抛 No available connection |
| restore-write-failure | DS-02 | 注入写失败，原训练 1 → 0 |
| malformed-and-filtered-backup | DS-03 | 坏嵌套形状进入解析结果，预览 TypeError；坏 id 被无提示过滤 |
| malformed-reminder-after-clear | DS-03/02 | weekdays 非数组进入恢复，filter TypeError，原数据已清空 |
| key-follows-restored-endpoint | DS-04 | 假 Key 进入其他域名的模拟请求 header |
| reset-call-chain | DS-05 | 现 UI 的清空链后 chat/plans/reminders 仍各 1 条 |
| imperial-double-conversion | DS-07 | 150 lb → 存 68 kg → AI 显示约 30.8 kg |
| concurrent-workout-mutations | DS-08 | 同时追加 A、B，最终仅 B |
| facade-not-streaming | DS-10 | askStreaming 发 stream=false，回调一次 |
| sse-crlf | DS-11 | 两个 CRLF delta 最后报无消息内容 |
| sse-done-pending | DS-11 | DONE 后 body 不关闭，调用仍 pending |
| wrong-calendar-week | DS-13 | 周一当前周段包含上周六的 1 次训练 |
| future-context | DS-13 | 未来记录进入七天/周/月上下文 |
| stale-cache-read | DS-14 | 内部记录 1 条，缓存 count=0 |
| null-profile-restore | DS-15 | 备份资料 null，恢复后仍 OLD_PERSON |
| two-active-plans | DS-16 | 并发激活得到 A、B 双 active |
| rir-roundtrip | DS-17 | parser 的四个 RIR=2，preview/materialize 后四个 null |
| destroy-init-stale-bundle | DS-18 | 重开返回旧 bundle，而 getStorage 报未初始化 |
| blocked-idb-destroy | DS-18 | delete 已报告成功，另一个连接仍能读 1 条 |
| history-load-failure-overwrite | DS-22 | 读失败后保存新快照，旧问答被替换 |

DS-05/07/22 重放的是页面采用的实际仓储/换算链，不是已执行的 DOM 点击。DS-01 使用符合本机安装插件 Java 前置条件的替身，不是 APK 实测。DS-06/09/12/19/20/21 的组件/原生路径只做静态审查，不在这份运行结果里。

## 如何重放

在仓库根目录运行 Node 的原有 TypeScript resolver。复制下面 JavaScript 到 PowerShell 的单引号 here-string，并通过标准输入运行：

```powershell
@'
<下面的 JavaScript>
'@ | node --experimental-transform-types --import ./scripts/register-ts.mjs --input-type=module
```

这些断言针对**当前错误现象**。修复后探针不再复现是预期，需要把对应缺陷写成正常行为的回归测试；不要把本脚本直接当作产品测试。

脚本不读取用户数据库：环境固定使用 MemoryAdapter，IDB 探针显式替换为新 IDBFactory，fetch 全部是注入的 Response。所有 Key 都是 `AUDIT_FAKE_KEY`，没有 HTTP 调用。

```javascript
import assert from 'node:assert/strict';
import { MemoryAdapter } from '@/test/MemoryAdapter';
import { initStorage, resetStorageForTests, destroyStorage, getStorage } from '@/storage';
import { CollectionCache } from '@/storage/adapter';
import { buildRepositories } from '@/repositories';
import { createWorkout, createExerciseEntry } from '@/domain/workout';
import { createEmptyPlan, createEmptyReminder } from '@/repositories/planRepository';
import { EMPTY_PROFILE } from '@/repositories/settingsRepository';
import { createBackup, applyBackup, parseBackup, summarizeBackup } from '@/services/backup';
import { AiService } from '@/services/ai/index';
import { OpenAiCompatibleProvider } from '@/services/ai/openaiProvider';
import { ContextBuilder } from '@/services/ai/contextBuilder';
import { AiConversationRepository } from '@/repositories/aiConversationRepository';
import { lbToKg } from '@/domain/units';
import { resolveMetrics } from '@/services/ai/userContext';
import { parseWorkoutText } from '@/services/ai/localParser';
import { draftToPreview, previewToDraft, materializeDraft } from '@/services/ai/materialize';
import { SqliteAdapter, setSqlitePluginForTests } from '@/storage/sqliteAdapter';
import { IndexedDbAdapter } from '@/storage/idbAdapter';
import { IDBFactory } from 'fake-indexeddb';

async function env() {
  resetStorageForTests();
  const memory = new MemoryAdapter();
  const bundle = await initStorage(memory);
  return { memory, bundle, repos: buildRepositories(bundle) };
}
const reports = [];
async function probe(id, run) {
  try { reports.push({ id, status: 'BUG_REPRODUCED', details: await run() }); }
  catch (error) { reports.push({ id, status: 'NOT_REPRODUCED_OR_ERROR', error: error.message }); }
}
const row = id => ({ id, role: 'recorder', question: id, answer: id,
  contextSections: [], contextCharacters: 0, createdAt: '' });
const config = { baseUrl: 'https://mock.example/v1', apiKey: '', model: 'audit' };
const emptyContext = { build: async () => ({ text: '', sections: [], characters: 0 }) };

await probe('native-connection-contract', async () => {
  let connected = false;
  const calls = [];
  setSqlitePluginForTests({
    isDBExists: async () => {
      calls.push('isDBExists');
      if (!connected) throw new Error('No available connection for database fitness_agent');
      return { result: true };
    },
    createConnection: async () => { calls.push('createConnection'); connected = true; },
    open: async () => { calls.push('open'); },
    execute: async () => { calls.push('execute'); },
  });
  let error;
  try { await new SqliteAdapter().init(); } catch (e) { error = e.message; }
  finally { setSqlitePluginForTests(null); }
  assert.match(error ?? '', /No available connection/);
  assert.deepEqual(calls, ['isDBExists']);
  return { calls, error };
});

await probe('restore-write-failure', async () => {
  const { repos } = await env();
  await repos.training.put(createWorkout());
  const doc = await createBackup(repos);
  repos.training.putMany = async () => { throw new Error('INJECTED_WRITE_FAILURE'); };
  await assert.rejects(applyBackup(doc, { repos }), /INJECTED_WRITE_FAILURE/);
  const remaining = await repos.training.count();
  assert.equal(remaining, 0);
  return { originalWorkouts: 1, remaining };
});

await probe('malformed-and-filtered-backup', async () => {
  const { repos } = await env();
  const base = await createBackup(repos);
  const malformed = parseBackup(JSON.stringify({ ...base,
    workouts: [{ id: 'bad', startTime: 'invalid' }] }));
  assert.equal(malformed.workouts.length, 1);
  assert.throws(() => summarizeBackup(malformed), TypeError);
  const filtered = parseBackup(JSON.stringify({ ...base,
    workouts: [{ id: 42, startTime: '2026-10-01' }] }));
  assert.equal(filtered.workouts.length, 0);
  return { malformedAccepted: 1, silentlyDropped: 1 };
});

await probe('malformed-reminder-after-clear', async () => {
  const { repos } = await env();
  await repos.training.put(createWorkout());
  const base = await createBackup(repos);
  const doc = parseBackup(JSON.stringify({ ...base, workouts: [],
    reminders: [{ id: 'bad', time: '19:00', weekdays: 7 }] }));
  await assert.rejects(applyBackup(doc, { repos }), /filter is not a function/);
  assert.equal(await repos.training.count(), 0);
  return { originalWorkouts: 1, remaining: 0 };
});

await probe('key-follows-restored-endpoint', async () => {
  const { repos } = await env();
  await repos.settings.patch({ aiEnabled: true, aiApiKey: 'AUDIT_FAKE_KEY',
    aiBaseUrl: 'https://trusted.example/v1', aiModel: 'audit' });
  const doc = await createBackup(repos);
  doc.settings.aiBaseUrl = 'https://other.example/v1';
  const { settings } = await applyBackup(doc, { repos });
  let captured;
  const ai = new AiService(repos, settings, async (url, options) => {
    captured = { url, authorization: options.headers.Authorization };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { headers: { 'Content-Type': 'application/json' } });
  });
  await ai.ask('test', 'recorder');
  assert.equal(captured.url, 'https://other.example/v1/chat/completions');
  assert.equal(captured.authorization, 'Bearer AUDIT_FAKE_KEY');
  return captured;
});

await probe('reset-call-chain', async () => {
  const { repos } = await env();
  await repos.reminders.save({ ...createEmptyReminder(), title: 'old reminder' });
  await repos.plans.save({ ...createEmptyPlan(), name: 'old plan' });
  await repos.aiConversation.save([row('old')]);
  await repos.training.clear(); await repos.rules.clear();
  await repos.summaries.clear(); await repos.meals.clear(); await repos.profile.clear();
  const result = { chat: (await repos.aiConversation.recent()).length,
    plans: await repos.plans.count(), reminders: await repos.reminders.count() };
  assert.deepEqual(result, { chat: 1, plans: 1, reminders: 1 });
  return result;
});

await probe('imperial-double-conversion', async () => {
  const storedKg = Math.round(lbToKg(150) * 10) / 10;
  const actualKg = resolveMetrics({ ...EMPTY_PROFILE, unitSystem: 'imperial',
    weightKg: storedKg }).weightKg;
  assert.equal(storedKg, 68);
  assert.ok(Math.abs(actualKg - 30.84428116) < 0.0001);
  return { enteredLb: 150, storedKg, actualKg };
});

await probe('concurrent-workout-mutations', async () => {
  const { repos } = await env();
  const workout = await repos.training.put(createWorkout());
  await Promise.all(['A', 'B'].map((name, index) => repos.training.upsertExercise(
    workout.id, createExerciseEntry(workout.id, name, index))));
  const actual = (await repos.training.get(workout.id)).exercises.map(e => e.rawName);
  assert.deepEqual(actual, ['B']);
  return { expected: ['A', 'B'], actual };
});

await probe('facade-not-streaming', async () => {
  const { repos } = await env();
  const settings = { ...await repos.settings.get(), aiEnabled: true,
    aiModel: config.model, aiBaseUrl: config.baseUrl };
  let sent;
  const ai = new AiService(repos, settings, async (url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'whole answer' } }] }),
      { headers: { 'Content-Type': 'application/json' } });
  });
  const deltas = [];
  await ai.askStreaming('hello', 'coach', delta => deltas.push(delta));
  assert.equal(sent.stream, false);
  assert.equal(deltas.length, 1);
  return { stream: sent.stream, callbacks: deltas.length };
});

await probe('sse-crlf', async () => {
  const payload = ['data: {"choices":[{"delta":{"content":"A"}}]}', '',
    'data: {"choices":[{"delta":{"content":"B"}}]}', '', 'data: [DONE]', '', ''].join('\r\n');
  const provider = new OpenAiCompatibleProvider(config, emptyContext,
    async () => new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(provider.chatStream([{ role: 'user', content: 'hello' }], () => {}),
    /no message content/);
  return { expected: 'AB', actual: 'no message content' };
});

await probe('sse-done-pending', async () => {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: [DONE]\n\n'));
  } });
  const provider = new OpenAiCompatibleProvider(config, emptyContext,
    async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  const result = await Promise.race([
    provider.chatStream([{ role: 'user', content: 'test' }], () => {}).then(() => 'completed'),
    new Promise(resolve => setTimeout(() => resolve('still pending'), 40)),
  ]);
  assert.equal(result, 'still pending');
  return result;
});

await probe('wrong-calendar-week', async () => {
  const { repos } = await env();
  await repos.training.put({ ...createWorkout(), completed: true,
    startTime: '2026-10-03T12:00:00-07:00', durationSec: 600 });
  const ctx = await new ContextBuilder(repos).build({ now: new Date('2026-10-05T12:00:00-07:00') });
  const weekly = ctx.text.split('## This week so far')[1];
  assert.match(weekly, /Sessions: 1/);
  return { monday: '2026-10-05', previousSaturday: '2026-10-03', weekly: weekly.trim() };
});

await probe('future-context', async () => {
  const { repos } = await env();
  await repos.training.put({ ...createWorkout(), completed: true,
    startTime: '2026-10-20T12:00:00-07:00' });
  const ctx = await new ContextBuilder(repos).build({ now: new Date('2026-10-05T12:00:00-07:00'),
    includeMonthly: true });
  assert.ok(ctx.text.includes('2026-10-20'));
  assert.ok(ctx.sections.includes('last 7 days'));
  return { futureIncluded: true, sections: ctx.sections };
});

await probe('stale-cache-read', async () => {
  const rows = []; let release; let first = true;
  const inner = {
    all: async () => {
      if (first) { first = false; const snapshot = rows.slice();
        return new Promise(resolve => { release = () => resolve(snapshot); }); }
      return rows.slice();
    },
    put: async record => { rows.push(record); },
  };
  const cache = new CollectionCache(inner);
  const slowRead = cache.all();
  await cache.put({ id: 'new' });
  release(); await slowRead;
  assert.equal(await cache.count(), 0);
  return { persistentRows: rows.length, cacheRows: await cache.count() };
});

await probe('null-profile-restore', async () => {
  const { repos } = await env();
  await repos.profile.save({ ...await repos.profile.get(), name: 'OLD_PERSON' });
  const doc = { ...await createBackup(repos), profile: null };
  await applyBackup(doc, { repos });
  const name = (await repos.profile.get()).name;
  assert.equal(name, 'OLD_PERSON');
  return { backupProfile: null, actualName: name };
});

await probe('two-active-plans', async () => {
  const { repos } = await env();
  await Promise.all(['A', 'B'].map(name => repos.plans.save({ ...createEmptyPlan(), name, active: true })));
  const active = (await repos.plans.all()).filter(p => p.active).map(p => p.name);
  assert.equal(active.length, 2);
  return active;
});

await probe('rir-roundtrip', async () => {
  const { repos } = await env();
  const draft = parseWorkoutText('bench 80 8 8 7 6 rir2', { defaultUnit: 'kg' });
  let sequence = 0;
  const preview = draftToPreview(draft, [], prefix => prefix + sequence++);
  const reviewed = previewToDraft(preview, '', 'local');
  const { workout } = await materializeDraft(reviewed, createWorkout(), repos);
  const parsed = draft.exercises[0].sets.map(s => s.rir);
  const saved = workout.exercises[0].sets.map(s => s.rir);
  assert.deepEqual(parsed, [2, 2, 2, 2]);
  assert.deepEqual(saved, [null, null, null, null]);
  return { parsed, saved };
});

await probe('destroy-init-stale-bundle', async () => {
  const { bundle } = await env();
  await destroyStorage();
  const reopened = await initStorage(new MemoryAdapter());
  assert.equal(reopened, bundle);
  assert.throws(() => getStorage(), /Storage not initialised/);
  return { returnedOldBundle: true, getStorageThrows: true };
});

await probe('blocked-idb-destroy', async () => {
  globalThis.indexedDB = new IDBFactory();
  const first = new IndexedDbAdapter(); const second = new IndexedDbAdapter();
  await first.init(); await second.init();
  await second.scope().collection('workouts').put({ id: 'isolated-data' });
  await first.destroy();
  const remaining = await second.scope().collection('workouts').count();
  await second.close();
  assert.equal(remaining, 1);
  return { destroyResolved: true, stillPresent: remaining };
});

await probe('history-load-failure-overwrite', async () => {
  const { bundle } = await env();
  const kv = bundle.scope.kv('aiChat');
  const chat = new AiConversationRepository(kv);
  await chat.save([row('old')]);
  const get = kv.get.bind(kv);
  kv.get = async () => { throw new Error('INJECTED_READ_FAILURE'); };
  let displayed = [];
  try { displayed = await chat.recent(); } catch { /* AiPage catches and enables asking */ }
  kv.get = get;
  await chat.save([row('new'), ...displayed]);
  const ids = (await chat.recent()).map(x => x.id);
  assert.deepEqual(ids, ['new']);
  return { oldExchanges: 1, afterFailedLoad: displayed.length, storedIds: ids };
});

resetStorageForTests();
console.log(JSON.stringify(reports, null, 2));
const reproduced = reports.filter(x => x.status === 'BUG_REPRODUCED').length;
console.log(JSON.stringify({ probes: reports.length, reproduced, errors: reports.length - reproduced }));
if (reproduced !== reports.length) process.exitCode = 1;
```

真实组件时序、OS 通知与输入法的复现要求见任务单。不要用复制页面代码的模拟代替最终组件回归测试；上述路径模拟用于定位，修复验收应调用真实业务入口。
