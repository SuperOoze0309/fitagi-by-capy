# Changelog / 更新日志

All notable changes to this project, newest first.
本文件记录项目所有值得注意的变更，最新的在最前。

The format follows [Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/).
格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

## [1.0.0] — 2026-10-05

The first release build. **It cannot be installed over 0.9.0**: 0.9.0 was signed with a debug key and
1.0.0 is signed with the project's release key, so Android treats them as different signers. Export a
JSON backup in 0.9.0, uninstall it, install 1.0.0 and restore. The API key, meal photos and chat
history are not in a backup. The APK has still not been run on a real device or an emulator.
第一个 release 构建。**无法覆盖安装在 0.9.0 之上**：0.9.0 使用调试密钥签名，1.0.0 使用项目正式密钥签名，
Android 视为不同签名者。请在 0.9.0 中导出 JSON 备份，卸载后安装 1.0.0 再恢复。API Key、饮食照片和聊天记录
不在备份中。APK 仍未在真机或模拟器上运行过。

### Added / 新增

- **Signed release build.** `npm run android:release` assembles a release APK, signed from a
  git-ignored `android/keystore.properties`. Without that file the build produces an unsigned APK.
  **已签名的 release 构建。** `npm run android:release` 打包 release APK，签名信息来自已被 Git 忽略的
  `android/keystore.properties`；没有该文件时产出未签名 APK。
- **Cancellable chat.** Stop generation, abort on leaving the page, retry failed history loading,
  and show context disclosures in the selected language. Partial answers stay out of memory.
  **可取消的聊天。** 支持停止生成、离开页面取消、历史读取失败重试，上下文说明跟随界面语言；未完成回答不保存。
- **RIR preview editing.** Quick Log preserves and lets you edit reps in reserve before saving.
  **RIR 预览编辑。** 快速记录保留解析出的剩余次数，并允许在确认前修改。

- **On-device AI chat memory.** The latest 100 exchanges persist locally; follow-up requests
  include up to 8 recent exchanges and disclose that context. The AI page now also includes
  the active workout in its training context.
  **本机聊天记忆。** 最近 100 轮对话保存在本机；追问最多携带最近 8 轮，并显示实际发送的前文。
  AI 页面也会把进行中的训练加入训练上下文。

### Changed / 变更

- **Android version metadata.** The APK now reports 1.0.0 (`versionCode` 2). The 0.9.0 APK reported
  "1.0" to Android while the app showed 0.9.0, and the lockfile still said 0.8.0; a test now keeps
  the four places in step.
  **Android 版本信息。** APK 现在向系统报告 1.0.0（`versionCode` 2）。0.9.0 的 APK 向系统报告的是 "1.0"，
  应用内显示 0.9.0，lockfile 还停在 0.8.0；新增测试让这四处保持一致。
- **Request and storage reliability.** SSE supports LF/CRLF/CR, split UTF-8 and terminal DONE;
  model calls have a total deadline. IndexedDB operations abort on timeout, blocked deletion waits
  for completion, and stale reads cannot replace a newer cache.
  **请求与存储可靠性。** 流式解析兼容多种换行、分片中文与结束标记，请求有总时限；本地事务超时会中止，删除受阻不会虚报成功，旧读取不会覆盖新缓存。
- **Correct fitness context and credentials.** Imperial profiles retain stored kilograms;
  future sessions do not enter AI context and weekly totals start on Monday. Restoring a different
  AI endpoint clears its old key and disables AI until reconfigured.
  **训练上下文与凭据修正。** 英制资料按已存的公斤值使用；AI 上下文排除未来训练，周统计从周一开始；恢复到不同 AI 端点会清除原密钥并关闭 AI，等待重新配置。

- **Clearer coaching boundaries.** Coach replies match the user's language and separate logged facts
  from hypothetical progression targets. Exact targets must be grounded in a relevant training
  baseline; injury concerns receive no diagnosis or rehabilitation prescription.
  **教练建议边界更清楚。** 回答跟随用户语言，并将训练记录与假设性进阶目标分开。具体目标必须有相关训练记录作依据；遇到伤痛疑虑不做诊断或康复处方。

### Fixed / 修复

- **WebView inspection is off in release builds.** `capacitor.config.ts` forced
  `webContentsDebuggingEnabled` on for every build, so a release APK would have
  been open to `chrome://inspect` over USB, exposing the local database and the stored API key. The setting is
  removed; Capacitor now enables inspection for debug builds only.
  **release 构建关闭 WebView 调试。** `capacitor.config.ts` 之前对所有构建强制开启
  `webContentsDebuggingEnabled`，release APK 也会允许通过 USB 在 `chrome://inspect` 中打开，暴露本地数据库和
  已保存的 API Key。现已移除该设置，Capacitor 只在 debug 构建中开启调试。

## [0.9.0] — 2026-09-25

### Added / 新增

- **Reminders.** Local notifications scheduled on the device: a time of day plus any set of
  weekdays, six kinds, and a schedule that is rebuilt from the stored list on every launch so a
  reboot, a restored backup or a permission granted later cannot leave the two out of step.
  They can be written by hand or proposed by the AI from your goal, activity level and the times
  you actually train.
  **消息提醒。** 本地通知，由设备自己调度：一个时间点加任意星期组合，六种类型；每次启动都从列表重建排期，
  所以重启、导入备份或后给的权限都不会让两边对不上。可以手写，也可以让 AI 根据你的目标、活动水平
  和实际训练时间给建议。
- **Training plans.** A weekly plan with per-day exercises, sets, a text reps prescription
  (`8-10`, `AMRAP`), and optional target weights. One plan is active at a time; the home screen
  shows today's session and can start a workout with those exercises already in it. An AI can
  draft a plan for review.
  **训练计划。** 周计划，按天安排动作、组数、文本形式的次数（`8-10`、`AMRAP`）和可选目标重量。
  同一时间只有一个当前计划；首页显示今日安排，可一键新建一次已带入动作的训练。也可以让 AI 起草。
- **First-run permission walkthrough.** Camera and photos, then notifications, each explained
  before it is requested, both skippable, and skipped entirely for an install that predates it.
  **首次启动权限引导。** 先相机与相册，再通知；每步先解释用途再请求，都可以跳过；老版本升级上来的用户不会被再问一次。
- **Streaming AI answers.** The AI page is a conversation: the reply is typed onto the screen as it
  arrives, the transcript scrolls to follow it, and the composer is docked at the bottom. Endpoints
  that ignore the streaming flag still work.
  **AI 回答流式输出。** AI 页变成对话形态：回答逐字打进气泡、对话区自动跟随、输入框固定在底部。
  不支持流式返回的端点也能正常使用。
- **Rounded-corner design pass.** Five radius tokens now cover every corner in the app; nested
  surfaces step down a size so the curves stay concentric.
  **R 角设计统一。** 五个圆角 token 覆盖全应用所有圆角；嵌套面板降一级，保证曲线同心。
- Four Android permissions for reminders and the camera, all optional at runtime.
  **Android 权限。** 为提醒和相机新增四项权限，运行时全部可选。

### Fixed / 修复

- Storage could hang forever and leave the app on its splash screen: concurrent initialisation
  opened the database twice and raced on the schema upgrade, and a blocked open never settled.
  Initialisation is now deduplicated, a blocked upgrade fails loudly, and a failed open retries once.
  **存储可能永远挂住、把 App 停在开屏页**：并发初始化会开两次数据库并撞在 schema 升级上，被阻塞的 open
  永远不返回。现在初始化去重、被阻塞的升级明确报错、开库失败重试一次。
- A local read that never settles left pages spinning forever. Every storage operation now has a
  timeout and fails with an error instead of pending indefinitely.
  **读操作不返回会让页面无限转圈。** 现在每个存储操作都有超时上限，超时报错而不是永远 pending。
- The welcome screen never appeared on a fresh install: "not a string" was being read as "field
  absent", so the flag was stamped as legacy before the user ever saw it.
  **新装永远看不到引导页**：把「不是字符串」当成了「字段不存在」，于是引导标记被当成老数据盖章。
- Every boot briefly rendered the welcome branch and rewrote the URL, so a deep link landed on Home.
  **每次启动都会闪一下引导分支并改写 URL**，导致深链接被弹回首页。
- Two sources of truth for settings validation had drifted; the backup importer now delegates to the
  repository's normaliser instead of keeping its own copy.
  **设置校验有两份实现并已漂移**；备份导入改为复用仓储的归一化逻辑，不再自己抄一份。

## [0.8.0] — 2026-09-24

### Changed / 变更

- Renamed the product from *Fitness Agent* to **FitAGI by Capy**, with a hand-drawn ragdoll cat as
  the launcher icon and splash screen. Four identifiers stay on the old name on purpose, because they
  are how existing data is found: the backup format marker, the IndexedDB database name, the SQLite
  file name and the Android package name.
  产品由 *Fitness Agent* 更名为 **FitAGI by Capy**，图标与启动图换成手绘布偶猫。有四个标识符
  故意保留旧名，因为它们是「数据怎么被找到」：备份格式标记、IndexedDB 库名、SQLite 文件名、Android 包名。
- Added a fourth theme, **ragdoll**, matching the icon, and made it the default for new installs.
  新增第四个主题 **ragdoll**（与图标一致），并设为新装默认。
- Themes gained scenery: each theme now decorates the UI with its own motifs (grass, flowers and
  carrots; bamboo; water; paws, yarn and hearts).
  主题新增场景元素：每个主题用自己的图案装饰界面（草丛花朵胡萝卜／竹子／水波／爪印毛线球爱心）。

## [0.7.0] — 2026-09-24

### Added / 新增

- Full internationalisation: Simplified Chinese, English and Spanish, following the device by
  default, switchable in Settings with no reload.
  完整国际化：简体中文、英语、西班牙语；默认跟随系统，设置里可切换且即时生效。
- Meals: manual entry, camera or gallery photos, optional AI estimation with an editable result and
  a correction chat, and a meal history.
  饮食模块：手动记录、拍照或相册、可选的 AI 估算（结果可编辑）与纠错对话，以及饮食历史。
- An optional local-only user profile that is condensed into a short context block for the AI.
  可选的纯本地用户资料，压缩成简短上下文供 AI 使用。
- Theme system rebuilt around design tokens, with three themed pixel mascots.
  主题系统改为围绕 design token 构建，含三个像素吉祥物。
- Responsive layout pass: fluid type scale, breakpoints at 40/56/75rem, a side rail on wide screens.
  响应式改造：流式字号、40/56/75rem 断点、宽屏侧边栏。
- A cancel/discard path for a workout draft.
  训练草稿的取消/丢弃入口。

## [0.6.0] — 2026-09-23

### Added / 新增

- Quality pass: error boundary, paged lists, PR badges, reopen a finished workout.
  质量收尾：错误边界、分页列表、PR 徽章、已完成训练可重新打开。

## Earlier / 更早

Versions before 0.6.0 (manual logging, local persistence, history, exercise history with charts,
kg/lb, backup and export, alias rules, natural-language Quick Log, summaries, the optional AI layer)
were built in sequence without a changelog.
0.6.0 之前的版本（手动记录、本地持久化、历史、动作历史与图表、kg/lb、备份与导出、别名规则、
自然语言快速记录、总结、可选 AI 层）按阶段开发，当时没有维护更新日志。
