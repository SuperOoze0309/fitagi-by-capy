# 交接记录 · Handoff log

协作方式见 [`README.md`](README.md)。每次交活**追加**一条，不要删旧记录。

---

## 2026-09-29 · AI 聊天记忆（对方实现，已验收）

- 状态：已验收
- 改动：
  - `src/repositories/aiConversationRepository.ts`（新增，读写 `aiChat` 键值区，最多 100 轮）
  - `src/storage/adapter.ts`（`KeyValueName` 加 `aiChat`）
  - `src/storage/idbAdapter.ts` / `src/storage/sqliteAdapter.ts`（`DB_VERSION` 与 `SCHEMA_VERSION` 一起 3 → 4，新增 `ai_chat` 表）
  - `src/repositories/index.ts`（注入 `aiConversation`）
  - `src/services/ai/{index,prompts,provider}.ts`（追问携带最多 8 轮、16,000 字符上限；提示词声明历史不作为事实）
  - `src/pages/AiPage.tsx`（对话持久化、清空、隐私说明）
  - `src/i18n/{en,zh-CN,es}.ts`、`src/test/FakeSqlitePlugin.ts`
- 已自测（对方）：`typecheck` 通过；`lint` 无错误（`AppContext.tsx` 两条既有警告）
- **没跑**：单元测试、浏览器冒烟（对方明确说明）
- 验收方补充：
  - `src/test/aiConversation.test.ts`（新增）：存取与顺序、坏行只丢那一行、100 轮上限、
    清空、**v3 → v4 迁移**（手工造 v3 库 → 应用打开 → 旧训练还在 → 存对话 → 重开连接仍在）、
    追问记忆的 8 轮 / 16,000 字符上限与超长截断
  - `src/test/sqlite.test.ts`：补一条 Android 侧 `ai_chat` 表的重启读回与清空
  - 测试数 271/53 → **283/55**，六处文档计数同步更新
- 结论：`npm test` 283 通过 0 失败；浏览器冒烟手机 165、桌面 166 全过，控制台零错误
- 已知取舍（**有意为之，非遗漏**）：聊天记录**不进备份**。`src/services/backup.ts` 未改动，
  导出不含、恢复不清空，README / ARCHITECTURE 三处已写明。恢复备份不会带走聊天记录，
  这是可接受的取舍。
- 环境事故（记录在案）：验收时并行跑了 `npm test`，把冒烟测试的开发服务器（端口 5199）
  挤掉，桌面那轮以 `net::ERR_CONNECTION_REFUSED` 失败；单独重跑即全过。**一次只跑一个重活。**

## 2026-09-29 · 教练建议的事实边界与安全提示

- 状态：已交待验收
- 改动：
  - `src/services/ai/prompts.ts`（消除记录事实与未来建议的数字规则冲突；补充语言匹配和保守训练边界）
  - `docs/ARCHITECTURE.md` / `docs/ARCHITECTURE.zh-CN.md`（说明新的教练提示词约束）
  - `CHANGELOG.md`（记录本次改进）
  - `notes/handoff.md`（追加本次交接记录）
- 已自测：`npm run typecheck` 通过；`npm run lint` 0 错误、2 条 `AppContext.tsx` 既有警告；`git diff --check` 通过
- 没验证：单元测试、浏览器冒烟、真实模型是否遵循提示词
- 需要对方：按约定复验完整 verify 和两种视口冒烟，核对文档后提交推送
- 已知风险：模型端点可能不完全遵循提示词；此修改不提供医疗诊断或伤病康复建议

## 2026-10-01 · 教练建议约束验收补记

- 状态：已验收
- 改动：
  - `src/services/ai/prompts.ts`（核实记录事实与假设目标的边界、语言匹配和安全提示）
  - `README.md` / `README.zh-CN.md`（同步用户可见的教练能力说明）
  - `docs/ARCHITECTURE.md` / `docs/ARCHITECTURE.zh-CN.md`、`CHANGELOG.md`（同步技术说明与更新记录）
- 已自测：验收结果记载于提交 `b1b6213`：`npm run verify` 通过；浏览器冒烟手机 165 项、桌面 166 项通过，控制台无错误。首次手机冒烟遇到 `ERR_CONNECTION_REFUSED`，重跑后两种视口均通过。
- 没验证：真实模型端点是否始终遵循这些提示词
- 需要对方：无
- 已知风险：这是提示词约束，无法保证所有模型每次都遵守；仓库真话清单中的真机和原生功能限制仍适用

## 2026-10-01 · 仓库缺陷审查与 DeepSeek 修复任务

- 状态：已交待验收
- 改动：
  - `notes/review-2026-10-01.md`（新增：22 项任务、代码位置、证据等级、优先级、四个批次和逐项验收要求）
  - `notes/review-repro-2026-10-01.md`（新增：可复制执行的隔离复现代码和实际输出摘要）
  - `notes/handoff.md`（本次审查与任务交接）
- 已自测：`npm test` 283 通过 / 55 套件 / 0 失败，exit 0；从复现附录运行 20 个隔离探针，20 项错误现象全部复现，exit 0；`git diff --check` 通过
- 没验证：6 项静态任务的真实组件/原生路径；本轮未跑完整 verify 或浏览器冒烟，未安装 APK，未访问真实模型服务
- 需要对方：DeepSeek 按任务单四个批次实施 22 项修复，新增必要行为回归测试并逐项填写交接；涉及组件/原生的任务补对应验证或如实列出仍未验证部分
- 已知风险：现有测试通过不等于这些问题已修复。任务单区分 API 隔离复现、页面调用链重放和原生契约替身；产品代码和用户数据库本轮未修改

## 2026-10-01 · 批次 A 开工登记（DS-01 起）

- 状态：**正在写**
- 写者：验收方
- 本轮要改的文件：`src/storage/sqliteAdapter.ts`、`src/test/FakeSqlitePlugin.ts`、
  `src/test/sqlite.test.ts`；批次 A 后续任务还会用到 `src/storage/index.ts`、
  `src/storage/adapter.ts`、`src/storage/idbAdapter.ts`、`src/services/backup.ts`
- 开工前完成的独立复核（源码 + 插件原生实现，结论与任务单一致）：
  DS-01（`CapacitorSQLite.java:1049` 的 `isDBExists` 无连接即抛，而 `sqliteAdapter.ts:41`
  第一步就调用它）、DS-07（表单存 kg，`userContext` 又按 lb 二次换算）、
  DS-10（接口 `streamChat` 与实现 `chatStream` 名称不一致，可选属性让编译不报错）、
  DS-17（预览模型无 `rir`，`previewToDraft` 固定 null）、DS-16（`putMany` 绕过 active 唯一约束）
- 请勿同时编辑上面列出的文件；批次 B / C / D 的文件暂未触碰
- 任务单中 DS-06 / 09 / 12 / 19 / 20 / 21 仍只有静态审查，修复时需补组件或原生路径验证，
  或如实标注仍未验证

## 2026-10-01 · DS-01 收尾（按 review-feedback 第 2 节）

- 状态：已交待验收（本轮为 DS-01 的完整交付，含反馈要求的 1–5 项）
- 改动：
  - `src/storage/index.ts`（**取消原生静默降级**：原生构建下 SQLite 打不开＝启动失败，只保留一次
    重试；浏览器仍用 IndexedDB，那是它自己的存储而不是替补）
  - `src/storage/sqliteAdapter.ts`（顺序改为注册连接 → 问文件 → open → schema；
    `isAlreadyConnected` 现在同时要求**库名**与 already exists 措辞；
    新增 `hasExistingDatabase()`，在 open 之前询问，用于区分新装与老库）
  - `src/test/FakeSqlitePlugin.ts`（区分「注册」与「文件」：`createConnection` 不再创建文件，
    文件由 `open()` 创建，对应原生 `Database.open` → `openOrCreateDatabase`）
  - `src/test/storageBoot.test.ts`（**新增 6 项启动入口测试**：走 `initStorage()` 自动选后端，
    注入 open/schema 失败，断言启动失败而不是换库、重试后读回原训练、不声明 fallback）
  - `src/test/sqlite.test.ts`（调用顺序断言更新为 注册 → 问文件 → open → schema）
  - `src/i18n/{en,zh-CN,es}.ts`（启动失败文案改写：数据还在设备上、别清除应用数据）
  - 六处测试计数 283 → 292（README 中英、DEVELOPING 中英、ARCHITECTURE 中英）
- 已自测：`npm test` **292 通过 / 56 套件 / 0 失败**；`npm run verify` exit 0；
  浏览器冒烟手机 165 / 桌面 166，控制台零错误
- 复核证据：重跑反馈文件里那段「注入 open 失败」的探针，输出已变为
  `{"booted":false,"error":"AUDIT_SQLITE_OPEN_FAILURE","sqliteWorkoutsStillOnDisk":1,"announcedFallback":false}`
  —— 不再选中另一份空库，原记录仍在磁盘上
- 没验证：真实 APK 冷启动与 v3 → v4 真机迁移；原生插件在本机不可用（无设备/模拟器）。
  替身测试通过不等于真机通过，这一条继续保持未验证
- 需要对方：复核第 3 点的冷启动与旧库场景是否已足够（本轮用 `seedExistingDatabaseFile()`
  模拟「磁盘有旧记录、连接注册为空」，未在真实 SQLite 文件上做 v3 → v4）
- 已知风险：`isDBExists` 的返回值只作信息展示，不参与任何数据决策；若插件消息措辞变化，
  `isAlreadyConnected` 会退化为「当作真实失败」——方向是响亮而不是静默

## 2026-10-01 · DS-02 恢复原子性 + DS-03 备份校验

- 状态：已交待验收
- 改动：
  - `src/services/backup.ts`：
    - **新增 `validateBackup()`**（严格校验，返回全部问题及路径）与 `describeBackupProblems()`
    - `parseBackup()` 改为委托严格校验：非法文件**拒绝并列出位置**，不再静默 filter 掉坏行
    - `applyBackup()` 重写：**先写入、后删除**；进入前再校验一次（手工构造的文档也拦）；
      失败时用**写前快照（journal）**回滚并恢复旧行、删除新行；照片按 `image:<id>` 键删除，
      既不读入内存也不改变「恢复后保留数字、丢弃图片」的既有约定
    - 新增 `BackupRestoreError`，消息明确说明数据被放回去了
    - 删除 7 个宽松类型守卫（`isWorkout` 等），它们正是「静默丢行」的来源
  - `src/repositories/ruleRepository.ts` / `settingsRepository.ts`：补 `putMany`（恢复不再逐条 save）
  - `src/repositories/settingsRepository.ts`：`ProfileRepository.clear()` 改为**删除该行**并返回
    共享的空资料，不再写入一个「刚刚更新过」的空资料
  - `src/pages/DataPage.tsx` + `src/i18n/{en,zh-CN,es}.ts`：被拒绝的文件弹窗列出每个问题位置，
    并提供「换一个文件」
  - `src/test/restore.test.ts`（**新增 10 项**）：注入写失败后原训练/饮食/规则仍在、正常恢复
    覆盖正确、空资料覆盖旧资料、照片随餐删除、逐条问题路径、重复 id 拒绝、`applyBackup`
    同样拦非法文档、真实 IndexedDB 下的写失败回滚
  - 两处旧测试按新契约改写（`backup.test.ts`、`migration.test.ts` 的「丢弃坏行」→「拒绝并指出位置」）
  - 六处测试计数 292 → 302 / 59 套件
- 已自测：`npm test` **302 通过 / 59 套件 / 0 失败**；`npm run verify` exit 0；
  浏览器冒烟手机 165 / 桌面 166，控制台零错误
- 与任务单的对应：DS-02 要求「恢复必须完整提交或保留原数据」——本轮采用「先写后删 + 写前快照
  回滚」；存储接口没有暴露跨集合事务，因此不是数据库级原子提交，这一点如实记录
- 没验证：真机上的大备份（数千条）恢复耗时与内存占用；原生分享/选择器路径
- 需要对方：DS-02 的回滚方案是否达到验收标准（若要求数据库级事务，需要先给
  `StorageAdapter` 增加事务能力，那属于接口变更，建议单独排一项）
- 已知风险：回滚本身失败时抛 `BackupRestoreError` 并在消息里说明，不会谎报成功；
  照片按 id 推导键名，若将来照片键规则改变需同步此处

## 2026-10-01 · DS-08 + DS-16 + DS-22 + DS-10

- 状态：已交待验收
- 改动：
  - **DS-08** `src/repositories/trainingRepository.ts`：`mutate()` 按 **workout id 串行**
    （每次更新重新读取，所以能看到上一次写入的结果；不同训练互不阻塞；队列尾部是
    catch 过的 Promise，一次失败不毒害后续）。`moveExercise` 对**不存在的动作 id** 改为
    抛错（原来静默 no-op，调用方拿到"成功"却是空操作）
  - **DS-16** `src/repositories/planRepository.ts`：`save()` 与 `putMany()` 统一走写锁，
    `putMany` 补上「至多一个 active」——导入多 active 计划时**文件里最后一个 active 胜出**，
    其余被停用（原来批量写完全绕过该约束）
  - **DS-22** `src/repositories/aiConversationRepository.ts` + `src/pages/AiPage.tsx`：
    新增 `append()`（读取失败或另一页面同时打开时，不再用本页快照覆盖未读到的历史），
    页面改用 append；**历史读取失败不再等同于「没有历史」**——置 `historyFailed`，
    阻止提问/总结并允许重试，输入框提示读取失败
  - **DS-10** `src/services/ai/openaiProvider.ts`：实现从 `chatStream` 改名为 **`streamChat`**，
    与接口和 `AiService` 的调用一致（此前可选属性让 TS 放行，流式**整条从未生效**）
  - 新增测试：`src/test/concurrency.test.ts`（7 项：并发加动作、并发编辑+完成、不同训练互不阻塞、
    失败后队列继续、真实 IndexedDB 下的并发）、`src/test/streaming.test.ts`（5 项：请求带
    stream:true、逐片段回调、**响应未结束就收到第一段**、忽略 stream 的端点降级为单段、
    真实 provider 暴露 `streamChat`）、`reminders.test.ts` 增 2 项计划唯一性、
    `aiConversation.test.ts` 增 4 项 append 语义
  - 六处测试计数 302 → 320 / 63 套件
- 已自测：`npm test` **320 通过 / 63 套件 / 0 失败**；`npm run verify` exit 0；
  浏览器冒烟手机 165 / 桌面 166，控制台零错误
- 回归证明：把 `streamChat` 改回旧名字 `chatStream`，流式套件 4 项失败、1 项通过（走降级），
  还原后 5 项全过——这条守卫确实能抓住改名
- 没验证：真实端点的流式行为（仓库从未连过真实模型）；真机上的并发节奏
- 已知风险：DS-08 的串行只在**同一仓储实例**内生效（应用只有一个实例，符合预期）；
  DS-22 的 append 不去重历史中的旧重复行，只保证新写入不重复

## 2026-10-04 · Codex 接手调试与功能改进

- 状态：正在写
- 写者：Codex；用户本轮已授权直接实现、验收并 push。
- 范围：AI provider/facade/context、AiPage、聊天仓储、资料单位、Quick Log 预览、备份端点凭据、缓存和存储生命周期；对应回归测试、三语文案、浏览器冒烟与文档。
- 协调：此前 A 批“正在写”已由后续交付记录覆盖；当前工作区干净，以 `197c61e` 为基线。此轮上述文件由 Codex 写入。
- 已自测：尚未运行。
- 没验证：本轮完整验证、真机与真实模型。
- 需要对方：此轮不要同时编辑上述文件或运行重活。
- 已知风险：DS-02 当前只有内存补偿回滚，尚不满足持久化原子恢复的验收要求；不把这项标为已修。

## 2026-10-04 · Codex 调试与功能改进交付

- 状态：已验收（本轮改动；原 22 项清单尚未全部关闭）。解除本轮写锁。
- 改动：
  - `src/services/ai/{provider,openaiProvider,index,requestSession}.ts`、`src/pages/AiPage.tsx`：停止生成、退出取消、完整请求时限、稳健 SSE、历史重试、IME 判断。
  - `src/repositories/aiConversationRepository.ts`：清空版本使旧请求无法重新追加历史；页面仅存本次新回答。
  - `src/services/ai/{contextBuilder,contextLabels,userContext,materialize}.ts`、`src/pages/QuickLogPage.tsx`：日期范围、稳定上下文 ID 与旧标签兼容、正确公斤语义、RIR 保留/编辑、避免延迟保存强制跳回旧页。
  - `src/services/backup.ts`、`src/pages/DataPage.tsx`：恢复端点变化时清 Key 并关闭 AI，预览说明行为。
  - `src/storage/{adapter,idbAdapter,index}.ts`：缓存读取版本、操作时限与事务 abort、销毁/启动协调、删除受阻不虚报成功；没有改记录格式或存储区。
  - `src/i18n/{en,zh-CN,es}.ts`：全部新增界面文案。
  - `src/test/debugImprovements.test.ts`（新增 38 项 / 8 套件）；`aiServices.test.ts`、`mealAi.test.ts` 更新正确语义；`src/dev/browserSmoke.ts` 补真实页面回归。
  - README 中英、DEVELOPING 中英段落、ARCHITECTURE 中英、CHANGELOG、`notes/README.md`、`notes/debug-2026-10-04.md`：功能、当前测试计数和真实限制。
- 已自测：最终 `npm run verify` exit 0，**358 通过 / 71 套件 / 0 失败**；lint 0 error、2 条既有 warning，typecheck/build 通过；最终 `npm run test:browser` 手机 **181**、桌面 **182** 全通过、控制台零错误、exit 0；提交前 `git diff --check` 通过。
- 验证中的失败：首轮浏览器各 16 条失败，修复了 Quick Log 的延迟跳转，并纠正两个新断言的 StrictMode/details 处理；RIR 新断言首轮误检查“last set”的第 1 组，改为检查第 4 组后复跑通过。具体过程见本轮调试记录。
- 没验证：真机/模拟器、原生通知和对话框、真实模型、断电/进程中断恢复、删除超时后的完整 UI 恢复流程；测试使用隔离数据和假凭据。
- 需要对方：后续从 `notes/debug-2026-10-04.md` 的剩余项接手；不要把本轮绿色验收扩大为全部缺陷修复。
- 已知风险：DS-02 仍不具备持久化原子恢复；DS-05/06/09 与训练全快照写入协调仍待处理。模型两分钟总时限可能中断较慢端点，可再次发问；缓存写入后重新加载以保证一致性。

## 2026-10-04 · Codex 修正 CI 日期测试

- 状态：正在写；写锁为 `src/test/aiServices.test.ts`、本交接文件和 `notes/debug-2026-10-04.md`。
- 改动：首次推送 `75c1d99` 的 GitHub CI 有两条日期测试失败；固定测试参考时间为当地周三中午，并把同一个参考时间传给上下文与总结服务。
- 原始证据：`gh run view 37259524135 --repo SuperOoze0309/fitagi-by-capy --log-failed`；`aiServices.test.ts:131` 报 `AssertionError [ERR_ASSERTION]: sections: last7Days`，`:151` 报 `AssertionError [ERR_ASSERTION]: sections:`。CI 共 356 通过 / 2 失败。
- 原因：服务器 UTC 已到周一，前两天的训练属于上周；另一条用“本周一 09:00”构造数据，在 UTC 凌晨属于未来。产品对本周与未来记录的筛选符合要求，原测试依赖执行时间。
- 已自测：等待修正后的串行复验。
- 没验证：修正后的 CI；此前原生与真实模型限制继续有效。
- 需要对方：复验期间不要同时修改上述文件或运行重活。
- 已知风险：这是测试时间夹具修正，不能据此宣称新增原生验证。

## 2026-10-04 · Codex 日期夹具修正交付

- 状态：已交；解除上述三份文件写锁。
- 改动：仅固定两条单测的参考日期并追加问题证据，产品代码未变。
- 已自测：`TZ=UTC` 下完整 `npm run verify` exit 0，358 / 71 全通过；`TZ=America/Los_Angeles` 下 `aiServices.test.ts` 24 / 3 全通过。两个验证串行运行。首批产品代码已有手机 181 / 桌面 182 的浏览器验收。
- 没验证：再次推送后的 GitHub CI 正等待运行；此次只改测试与记录，未另跑浏览器；原生与真实模型仍未验证。
- 需要对方：按首批剩余事项接手，CI 结果以对应提交的 GitHub 输出为准。
- 已知风险：首次 CI 的两项失败已留原始证据，不能把首次推送说成 CI 全绿。

## 2026-10-04 · 中文 README 文案整理

- 状态：正在写；写者 Codex；写锁为 `README.zh-CN.md` 和本交接文件。
- 改动：按用户反馈重写中文版项目介绍，减少生硬口语、重复说明和实现细节，保留主要功能、数据规则与未验证事项。
- 已自测：尚未检查修改后的文档。
- 没验证：本轮不涉及产品功能验证；此前真机、原生集成与真实模型仍未验证。
- 需要对方：本轮不要同时编辑上述两份文件。
- 已知风险：中文版本不再逐段对应英文版；共同的功能事实与限制保持一致，最新调试记录优先于旧文档的保证性描述。

## 2026-10-04 · 中文 README 文案交付

- 状态：已交；解除本轮两份文件写锁。
- 改动：重写 `README.zh-CN.md`，分为介绍、安装、功能、隐私、已知限制和开发文档；合并重复内容，以文档链接代替图标、安全区、圆角等长篇实现细节。改用自然中文，解释 RPE/RIR，去除“放行即可”“不来烦你”“不是嘴上说说”等表述。
- 事实核对：保留主要功能和四个冻结标识；修正图标素材、视觉能力判断、存储占用与设备兼容性的过度保证；补充计划/提醒请求的数据范围及现有恢复/清理限制。
- 已自测：人工核对功能与最新调试记录，检查本地链接目标和开发指南锚点；`git diff --check` 通过。
- 没验证：仅文档变更，未运行产品测试、构建或浏览器检查；未新增真机、原生和真实模型验证。358 项等数字引用上一轮结果。
- 需要对方：无；后续新增功能时更新对应段落。
- 已知风险：中文版本按中文阅读习惯重组，与英文版本不逐段对齐；旧版本 APK 不保证包含仓库最新功能，下载段已说明。
