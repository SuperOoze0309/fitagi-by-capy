# 协作约定 · FitAGI by Capy

> 这份文件是**同一个仓库里两个 AI 助手之间的协作约定**，由人类用户在中间转达消息。
> 双方直接在 `D:\DSHWorkspace\FitnessAgent` 这个工作区里交接：改动落在文件上，结论落在
> `notes/handoff.md` 里。任何人（包括后来的贡献者）都可以读它。
>
> 最后更新：2026-10-04

**English** | [简体中文](#协作约定--fitagi-by-capy)

---

## 1. 为什么不直接对话

双方都没有可调用的对方接口，浏览器侧工具访问 `http://127.0.0.1:3080` 会被安全策略拒绝。

**不要试图绕过它。** 设备所有权和用户授权都不能解除客户端策略；也不要为此搭代理、隧道或中转。
用户转达消息已经够用。谁把结论写进文件，谁就完成了交接。

## 2. 硬规矩（违反即回退，不讨论）

1. **数据第一。** 绝不丢用户数据。结构变更只做增量，迁移只补默认值，旧版本写出的备份永远能导入。
2. **冻结标识不许改名**（改掉会让用户既有的数据找不到）：
   - `fitness-agent-backup`（`src/services/backup.ts`，备份文件标记）
   - `fitness-agent`（`src/storage/idbAdapter.ts`，IndexedDB 库名）
   - `fitness_agent`（`src/storage/sqliteAdapter.ts`，SQLite 文件名）
   - `app.fitnessagent.tracker`（`capacitor.config.ts`、`build.gradle`，Android 包名）
   - 用户可见的文件名（导出）用 `fitagi-*`，那是标签不是键。
3. **组件里不出现面向用户的字符串。** 每条文案进 `src/i18n/en.ts` + `zh-CN.ts` + `es.ts`，
   三份目录缺键或整句照抄英文，`src/test/i18n.test.ts` 会让构建失败。
4. **存储改动必须三个地方同时改**：`src/storage/adapter.ts` 的类型、`idbAdapter.ts`
   （`DB_VERSION`）、`sqliteAdapter.ts`（`SCHEMA_VERSION`）。两个版本号必须一起 +1，
   `src/test/FakeSqlitePlugin.ts` 的 `DEFAULT_TABLES` 也要跟。
5. **新增存储/仓储要有测试**，尤其是**迁移**：老库能打开、旧记录一行不少、新区域可用。
   同类功能之前就是这样丢过数据的。
6. **不许自称验证过没跑过的测试。** 「类型检查通过」不是「测试通过」。
7. **一次只跑一个重活。** 别在冒烟测试跑的时候并行跑 `npm test`——浏览器冒烟会启动一个
   开发服务器占住 5199 端口，并行会把资源抢没，桌面那一轮就会以
   `net::ERR_CONNECTION_REFUSED` 挂掉。要并行就先把端口和进程状态看一眼。

## 3. 分工

| | 写改动的一方 | 验收的一方 |
| --- | --- | --- |
| 职责 | 实现功能、写测试、跑 `typecheck` / `lint` / `npm test` | 跑完整 `npm run verify` + 两种视口的浏览器冒烟，核对文档与代码是否一致，提交推送 |
| 允许 | 改 `src/`、`src/test/`、`docs/`、`README*` | 同上，另加 `git add/commit/push` |
| 必须写 | `notes/handoff.md` 里的交接记录 | 验收结论与遗留问题 |
| 不许做 | 绕过浏览器策略、替对方跑验收、改对方未提交的改动 | 在对方还在写的时候编辑同一批文件 |

**同一文件同一时间只有一个写者。** 谁先开始改，谁在 `notes/handoff.md` 里写一行「正在写」，
改完写「已交，待验收」。看到「正在写」就别碰那些文件。

## 4. 交接口径：`notes/handoff.md`

每次交活都按这个格式追加一条（旧的不要删，留痕）：

```markdown
## YYYY-MM-DD HH:mm · <一句话标题>

- 状态：正在写 / 已交待验收 / 已验收 / 已打回
- 改动：<文件列表，一个文件一行，附一句为什么>
- 已自测：<跑过什么命令，结果如何。没跑就写「没跑」>
- 没验证：<诚实列出>
- 需要对方：<要对方做什么，或写「无」>
- 已知风险：<可能影响数据、迁移、性能的地方>
```

三条要求：**改动范围要能对上文件**；**「没验证」必须写**；**风险宁可写多**。

## 5. 流程

```
收到活儿 → 写「正在写」 → 实现 + 自测 → 写「已交待验收」 → 对方复跑并验收
   ↑                                                              ↓
   └────────── 判为「已打回」时，附上失败命令与原始输出 ──────────────┘
```

打回时必须给出**可复现的证据**：命令、原始报错、涉及的文件行号。不接受「感觉不对」。

## 6. 冲突怎么办

1. 谁先动手谁继续，后来者让开并写进交接记录。
2. 判断依据是**代码、测试输出、文件时间戳**，不是谁说得更肯定。
3. 文件被对方改过时，`edit`/`write` 前先重读，不要凭记忆覆盖。
4. 说不拢就停下来，把两种方案各自的代价写进 `notes/handoff.md`，交给人类用户裁决。

## 7. 本仓库的实际环境

- 包管理：`npm`。常用命令：`npm run dev` / `build` / `test` / `test:browser` / `typecheck` /
  `lint` / `verify` / `cap:sync` / `android:apk`。
- 单元测试：`node --test --experimental-transform-types`，目前 **358 个测试、71 个套件**。
  这个数字写在 README（中英）、`docs/DEVELOPING.md`（中英）和 `docs/ARCHITECTURE.md`（中英）
  六处，**改动测试数量后要一起更新**，否则文档立刻过期（已经发生过一次）。
- 浏览器冒烟：`scripts/smoke.ps1` 拉起 Vite（端口 **5199**，`--strictPort`）后跑两遍
  （手机 390×844、桌面 1280×900），每遍独立浏览器配置目录。当前 181 / 182 项。
  报告落在 `%TEMP%\fa-smoke-report-{phone,desktop}.json`。
- 平台：Windows + PowerShell。`pwsh` 里**没有 heredoc**，多行提交信息写进临时文件再 `git commit -F`。
  控制台打印中文/破折号会出现乱码，那是显示问题，文件本身是 UTF-8。
- 提交流程：写改动的一方不自作主张 `push`；由验收方在验证通过后提交。提交信息中英不限，但要
  说清「改了什么、为什么、验证到什么程度」。

## 8. 真话清单（写文档时也要照这个口径）

目前**没有**在真机或模拟器上装过 APK；**没有**打开过任何原生对话框（分享、文件选择、相机）；
**没有**在设备上见过状态栏上色、返回键接管、通知真正弹出；**没有**连过任何真实 LLM 或视觉端点。
这些一律照实写，不软化、不省略。

---

## English

This file records the working agreement between two AI assistants that share one checkout
(`D:\DSHWorkspace\FitnessAgent`) and coordinate through the human user.

1. **Do not bypass browser or tool policy.** `127.0.0.1:3080` is refused by the client's own
   policy; device ownership does not lift it, and building a proxy or relay to get around it is
   not acceptable. Relaying through the user is sufficient.
2. **Data first.** Additive schema changes only, migrations fill defaults, older backups keep
   importing. Never rename the four frozen identifiers (see above).
3. **No user-visible string in a component** — every label lives in the three catalogues.
4. **A storage change touches three files at once:** the `CollectionName` / `KeyValueName`
   unions, `DB_VERSION` and `SCHEMA_VERSION` (both bumped together), plus the fake plugin's
   `DEFAULT_TABLES`.
5. **New storage needs tests, migrations especially:** an old database opens, keeps every row,
   gains the new area.
6. **Never claim a test passed when it was not run.** A green type-check is not a green suite.
7. **One heavy job at a time.** The browser smoke test holds port 5199; running `npm test`
   concurrently starves it and the desktop pass fails with `ERR_CONNECTION_REFUSED`.
8. One writer per file at a time, declared in `notes/handoff.md`; handoffs state what was
   changed, what was self-tested, what was **not** verified, and the known risks.
9. The verifier re-runs everything (`npm run verify`, both smoke viewports) and owns
   `git commit` / `push`. Disagreements are settled with commands and output, not confidence.
10. The honesty list above is the wording used in user-facing docs.
