# DS-01 修复复核与继续执行要求 · 2026-10-01

复核基线：`805840b`。原任务单见 [review-2026-10-01.md](review-2026-10-01.md)，协作约定见 [README.md](README.md)。用户已授权继续优化与修复；本文件是下一轮交接要求。

## 结论

**DS-01 的连接注册顺序修复成立，但整项尚未完成验收。** 当前 SQLite 定向测试 10 项通过；原生打开失败时自动转到另一份 IndexedDB 的风险仍能复现。其余 21 项继续按原任务单处理，不需要每完成一项再向用户请求继续授权。

本轮只新增本反馈文件，未修改产品代码、原任务单或 `handoff.md`，避开对方登记中的 A 批写锁。对方继续拥有已登记的实现文件。

## 1. 已独立复跑的证据

### 1.1 连接顺序回归

命令：

```powershell
node --test --experimental-transform-types --import ./scripts/register-ts.mjs src/test/sqlite.test.ts
```

结果：**10 tests / 1 suite / 10 pass / 0 fail，exit 0**。覆盖注册在先、重复注册、关闭后重开、训练与聊天读回等替身行为。

没有复跑全套测试，不能把提交说明中的 286 项当成本轮独立验收结果；没有跑完整 verify、浏览器冒烟或安装 APK。

### 1.2 DS-01 剩余风险：打开失败仍静默换库

代码位置：`src/storage/index.ts:40–49`。`createAdapter()` 捕获所有 SQLite 初始化异常，只写 console warning，然后继续打开 IndexedDB。提交说明里“其他错误会成为响亮失败”的说法只对 adapter 内部传播成立，在应用启动入口仍被捕获并降级。

下面探针在独立 Node 进程中使用内存 SQLite 替身和 fake-indexeddb，先存一条训练，再注入原生 open 失败。不会连接真实原生插件、真实模型或用户数据库。

```powershell
@'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { FakeSqlitePlugin } from './src/test/FakeSqlitePlugin.ts';
import { SqliteAdapter, setSqlitePluginForTests } from './src/storage/sqliteAdapter.ts';
import { initStorage, resetStorageForTests } from './src/storage/index.ts';
import { buildRepositories } from './src/repositories/index.ts';
import { createWorkout } from './src/domain/workout.ts';
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.Capacitor = { isNativePlatform: () => true };
const fake = new FakeSqlitePlugin();
setSqlitePluginForTests(fake.asPlugin());
const original = await initStorage(new SqliteAdapter());
await buildRepositories(original).training.put(createWorkout());
await original.adapter.close();
resetStorageForTests();
fake.open = async () => { throw new Error('AUDIT_SQLITE_OPEN_FAILURE'); };
const warnings = [];
const oldWarn = console.warn;
console.warn = (...args) => warnings.push(String(args[0]));
try {
  const next = await initStorage();
  const visible = await next.workouts.all();
  const persisted = await fake.query({ statement: 'SELECT json FROM workouts' });
  console.log(JSON.stringify({
    injectedFailure: 'AUDIT_SQLITE_OPEN_FAILURE',
    selectedBackend: next.adapter.kind,
    visibleWorkouts: visible.length,
    sqliteWorkouts: persisted.values.length,
    warnings,
  }));
  await next.adapter.close();
} finally {
  console.warn = oldWarn;
  resetStorageForTests();
  setSqlitePluginForTests(null);
}
'@ | node --experimental-transform-types --import ./scripts/register-ts.mjs --input-type=module
```

实际输出，exit 0：

```json
{"injectedFailure":"AUDIT_SQLITE_OPEN_FAILURE","selectedBackend":"indexeddb","visibleWorkouts":0,"sqliteWorkouts":1,"warnings":["[storage] SQLite unavailable, falling back to IndexedDB"]}
```

**这是错误行为复现，不是修复通过。** 原 SQLite 记录没有被删除，但用户会看到空训练库；继续录入又会形成两份不一致的数据。

## 2. DS-01 收尾要求

1. **收窄自动降级。** 原生插件可用、已有数据库打不开、建表失败等情况不能被当作“正常空库”继续写入另一个后端。保留原库，进入明确的启动失败/重试路径。浏览器正常使用 IndexedDB；如果保留“原生插件完全不可用”的降级，明确其适用条件和数据来源，不以一次 console warning 代替用户可见状态。
2. **补启动入口测试。** 经 `initStorage()` 自动选后端，分别注入 createConnection/open/execute 失败；断言不会静默展示另一份空库，也不会改写原训练、资料和聊天。测试重试恢复后读回原数据；不要只传入 adapter 绕开 `createAdapter()`。
3. **覆盖真正的冷启动与旧库。** 当前 close/reopen 测试仍使用同一个 FakeSqlitePlugin、已有进程内注册。另加“磁盘有旧记录、连接注册为空”的冷启动场景，以及含旧训练的 SQLite v3 → v4 加表、重开、聊天读写场景。替身测试和真机验证分开记载。
4. **收窄重复连接识别。** `src/storage/sqliteAdapter.ts:245–247` 的 `/already exists/i` 会接受任意含该短语的异常。只接受当前数据库的明确重复连接消息，考虑桥接前缀；对其他数据库、文件冲突、无关初始化错误补负例，不要吞掉它们。
5. **修正替身契约说明。** 已安装原生源码 `SQLite/Database.java` 在 `open()` 中调用 `openOrCreateDatabase`；`createConnection()` 注册对象并不等于已经创建数据库文件。FakeSqlitePlugin 当前在 createConnection 中将 fileExists 设为 true。应区分注册、文件和已打开状态，让针对这三者的测试有真实意义。不要将“所有方法除 createConnection 都要求连接”的概括推广到插件的全部 API。
6. **补完整交接。** 标注 DS-01 哪部分通过、哪部分未通过；当前 `handoff.md` 最新状态仍为“正在写”。最终交付按固定格式记录验证与未验证项。测试数变化后同步约定所列文档；原审查文件里的 283 是历史基线，保留它。

以上 1–3 属于原 DS-01 验收范围；4–5 是本次对补丁的补充审查，尚未作为新的真实设备故障复现，不另编造缺陷数量。

## 3. 后续安排：继续做，按风险交付

**继续 A 批，下一项 DS-02 恢复原子性合理；同时把 DS-03 的完整预校验作为恢复流程前置条件。** 每项的完成标准仍按原任务单；不要先清空数据再依赖可能失败的补偿写回。

“DS-02 是唯一能真正丢数据的一项”需要纠正。原审查已包含这些独立风险：

| 任务 | 丢失/覆盖路径 | 后续要求 |
| --- | --- | --- |
| DS-03 | 备份非法行被静默过滤；错误可在清空之后才暴露 | 拒绝非法输入，指出位置，验证之前不得开始恢复 |
| DS-08 | 同一训练并发读取旧快照，各自回写，后写覆盖前写 | 保留两个修改，并验证失败后队列仍可继续 |
| DS-09 | 待保存标记先清除，写失败后没有可靠重试；结束与在途写入竞争 | 保存失败保留修改，结束/丢弃后旧写入不能复活训练 |
| DS-22 | 聊天读取失败被当作空历史，新快照覆盖原历史 | 区分失败与空，加载失败不能破坏性覆盖历史 |

这些项维持 P1。DS-08/09 与 DS-12/22 各自联动验收。DS-04 的端点换 Key 泄漏和 DS-07 的身体单位错误也维持 P1。DS-10 的流式方法名修复继续做，但不能用它取代上述数据风险。

完成 A 后继续 B，再做 C、D；若安排并行调查，先按文件划分写锁，AiPage 等共享文件仍只有一个写者，重活仍串行。无需为了每一项完成而停下来问用户，但遇到确实无法从既有约定决定的数据语义取舍，要列出具体方案与影响。

## 4. 本轮交接

- 状态：已交待验收（反馈已交；DS-01 未整项验收）
- 改动：新增 `notes/review-feedback-2026-10-01.md`。
- 已自测：SQLite 定向测试 10/10；上述启动入口故障探针复现换库；`git diff --check` 通过。
- 没验证：完整 verify、浏览器冒烟、APK 冷启动/迁移、真实模型、原生对话框和通知。
- 需要对方：先收尾 DS-01 的启动降级与缺失测试，再继续 DS-02/03 和其余批次，填写实际验证结果。
- 已知风险：10 项替身测试通过不能证明原生运行或整项验收通过；当前启动失败仍可导致另一份数据库被选中。未触碰用户数据或对方锁定的实现文件。
