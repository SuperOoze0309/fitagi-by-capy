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
