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
