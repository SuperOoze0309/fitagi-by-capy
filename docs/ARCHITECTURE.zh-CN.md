**简体中文** | [English](ARCHITECTURE.md)

# 架构

FitAGI by Capy —— 一个本地优先的训练与饮食记录应用。以 Android 为先，使用 Capacitor + React + TypeScript + Vite 构建。没有账号、没有服务器、没有云同步、没有遥测。

产品在 0.8.0 之前叫 *Fitness Agent*。有四个标识符有意保留旧名，因为它们是「用来找到既有数据」的方式，而不是应用自我介绍的方式：备份格式标记 `fitness-agent-backup`、IndexedDB 数据库 `fitness-agent`、SQLite 文件 `fitness_agent`，以及 Android 包名 `app.fitnessagent.tracker`。重命名其中任何一个，都会让设备上已经存在的数据变成孤儿。用户在文件列表里看到的文件名确实改了，改成 `fitagi-*`。

## 分层

```
src/
  domain/        Pure data model and math. No I/O, no React, no storage.
  storage/       StorageAdapter abstraction + IndexedDB and SQLite implementations.
  repositories/  One class per concern, the only thing pages talk to.
  services/      Cross-cutting logic that reads several repositories (outlier checks, backup,
                 image compression, meal analysis), plus `nativeShell.ts` for the two places
                 that talk to the Android shell (status bar, hardware back button).
  state/         React context: preferences + language + profile, active workout session, toasts.
  theme/         Theme tokens, the pixel mascots and the per-theme motifs + scenes. Data only.
  i18n/          Translation catalogues, locale detection, the active-locale mirror.
  styles/        The stylesheet: token variables, a fluid type scale, the breakpoints.
  components/    Reusable UI (sheet, fields, exercise card, pickers, pixel-art renderer).
  pages/         One component per route.
  dev/           Opt-in browser smoke test. Never part of the normal boot path.
```

依赖只朝一个方向指：`pages → state → repositories → storage → domain`。`domain` 不依赖任何东西，这正是它可以被轻松测试的原因。`theme` 与 `i18n` 同样是叶子：目录是普通的嵌套对象，`theme/tokens.ts` 只依赖精灵数据与 `ThemeId` 类型，因此组件读取其中任何一个，都不必把存储或 React 状态拉进来。

## 数据模型

`src/domain/types.ts` 是唯一的真相来源。

```
Workout
  id, startTime, endTime|null, durationSec, notes, heartRate|null
  completed            false while the session is still being recorded
  exercises: ExerciseEntry[]
  createdAt, updatedAt

ExerciseEntry
  id, workoutId
  rawName              exactly what the user typed, never rewritten
  normalizedName       display/canonical name after alias rules
  order                0-based, contiguous
  notes, sets: SetEntry[], supersetGroup|null

SetEntry
  weight|null, weightKg|null, unit      entered value + canonical kg value
  reps|null, durationSec|null, distance|null, distanceUnit|null
  restSec|null, rpe|null, rir|null
  isFailure, isWarmup, isDropSet, notes
```

派生类型，它们**不是**真相来源：

- `TrainingSummary` —— 属于 `SummaryRepository`（`kind` 区分 `daily` / `weekly` / `monthly`）。删除一条总结永远不会碰到训练记录。
- `Settings` —— 一个文档，包含可选的 AI 配置、主题、语言偏好与视觉能力覆盖开关。
- `AliasRule` —— 用户自己拥有的 `{ match, normalized }` 重命名规则。
- `UserProfile` —— 一个可选文档。每个字段都可以为空；一个都不填，应用也完全可用。

饮食是独立的聚合，与训练记录并列，而不是放在它们内部：

```
Meal
  id, eatenAt, name, portion
  items: MealItem[]      one food per row, each with its own figures
  calories, proteinG, carbsG, fatG
  notes, source, confidence, imageKey, aiNote
  createdAt, updatedAt

MealItem
  id, name, portion, calories, proteinG, carbsG, fatG
```

- `source` 取值为 `manual | ai | ai-edited`，`confidence` 是模型自己给出的 `high | medium | low`。它们存在的原因是：来自照片的营养数据是**估计值**：UI 必须能说明一个数字从哪来，而不是把它当作实测值呈现。
- 一餐的总量永远是它各项之和（`sumItems`），因此屏幕上醒目的总量与明细不可能互相矛盾。未知的值保持 `null` 而不是变成 `0`，这样「未知」永远不会被渲染成「零卡路里」。
- `imageKey` 指向 `images` 键值存储中的一行，而不是一个路径：这里没有文件系统参与，也没有孤儿文件需要清理。

设计规则：*把确定的字段结构化，把模糊的部分留作文本。* 这里刻意没有内置动作库，也没有试图一开始就把所有健身语义建模出来。

### 单位

`weight` + `unit` 是用户输入的原始值，永远不会被改写。`weightKg` 是用于比较、容量与 1RM 的规范值。切换显示单位只改变渲染；历史记录保留每一组当时记录所用的单位。`src/domain/workout.ts` 中的 `withSetWeight()` 是唯一写入 `weightKg` 的函数，因此两者不可能发生漂移。

## 存储

`StorageAdapter`（`src/storage/adapter.ts`）是一份刻意收窄的契约：

- `collection<T>(name)` → `all / get / put / putMany / remove / clear / count`
- `kv(name)` → `get / set / remove`

两种实现：

| 适配器 | 使用场景 | 说明 |
| --- | --- | --- |
| `IndexedDbAdapter` | 浏览器开发 + 兜底 | `DB_VERSION = 4`。集合 `workouts`、`rules`、`summaries`、`meals`、`reminders`、`plans`；键值存储 `settings`、`presets`、`images`、`profile`、`aiChat`。 |
| `SqliteAdapter` | Android（生产） | `@capacitor-community/sqlite`，`SCHEMA_VERSION = 4`。表 `workouts`、`alias_rules`、`summaries`、`meals`、`reminders`、`plans`、`settings`、`presets`、`profile`、`images`、`ai_chat`、`meta`。 |

存储区名称只在 `src/storage/adapter.ts` 的 `CollectionName` 与 `KeyValueName` 联合类型里枚举一次，因此不可能只为某一个后端新增集合。SQLite schema 还会建一张 `meta` 表，适配器从不读写它；它是预留的，不属于应用的契约。

**SQLite 的连接契约必须排在前面。** 在插件 v7 里，除注册连接之外，每个方法都会先从进程内的连接表里取连接，取不到就抛 `No available connection for database …`——`isDBExists` 也一样，它读文件只是为了回答一个「连接必须已经存在」的问题。所以 `SqliteAdapter.init()` 的顺序是：先注册连接（`createConnection`），再打开（`open`），最后执行增量 schema。同一个名字第二次注册会被插件拒绝（`Connection … already exists`），但在这里不算失败：重试、热重载、或者 `close()` 没送到插件，都会留下一个仍然有效的注册，因此这一条特定错误会被接受，启动继续往下走。`FakeSqlitePlugin` 强制同样的前置条件——把顺序写错的适配器能骗过宽松的替身，却会在真机上崩，这件事已经发生过一次。

每个关注点拥有自己的存储区：

| 存储区 | 存放内容 | 为什么要独立 |
| --- | --- | --- |
| `workouts` | Workout 聚合 | 原始记录。迁移永远不会删除它。 |
| `rules` | 别名规则 | 归用户所有；解析不能依赖对训练记录的扫描。 |
| `summaries` | 派生的日/周/月总结 | 让「删除总结不可能影响原始训练数据」成为结构性事实。 |
| `meals` | 一条饮食记录一个文档 | 与训练记录相同的本地优先契约。 |
| `images` | 每张饮食照片一个压缩后的 data URL | 照片自占一行，因此写入新照片永远不会重写其他照片，删除饮食记录也会删除它的图片。 |
| `profile` | 可选的用户资料 | 从不是必需，也从不会阻塞。 |
| `aiChat` | 最近最多 100 轮 AI 对话 | 本机保存以支持跨页面和重启后的追问；独立于训练记录，且不进入备份。 |
| `settings` / `presets` | 偏好设置，以及冒烟测试的运行状态 | `presets` 与用户数据一样能在刷新后存活。 |
| `reminders` | 提醒文档 | 应用拥有列表，操作系统拥有排期，两者会各自漂移，因此必须能从存储整体重建。 |
| `plans` | 训练计划文档 | 计划是「意图」，与训练历史完全分离。 |

记录以 JSON 文档形式存放（`id`、`json`，外加用于排序与未来分析的冗余列）。一条训练记录永远是作为整体聚合读取的，因此文档存储与访问模式吻合，也让迁移保持简单。如果将来做聚合分析真的需要 SQL，那项工作应该放在这个接口之后——没有任何页面或仓储需要改动。

SQLite 插件以 type-only 导入加运行时动态 import 的方式引入，因此它永远不会进入 Web 产物，浏览器开发也不需要原生模块。插件 v7 的 API 是扁平的：每次调用都携带 `database`（`query({ database, statement, values })`），没有需要保持的连接句柄。`setSqlitePluginForTests()` 注入一个替身，让适配器真实的 SQL 也被测试覆盖。

`CollectionCache` 用一张内存映射包住每个集合。真实的本地历史是几千次训练，因此这使 History/Exercise/Home 的读取几乎免费。键值存储不缓存：它们只存少量文档，需要时读一次即可。

由于各存储区彼此独立，「删除总结不可能影响原始训练数据」与「删除一条饮食记录会删除它的照片」是结构性保证，而不是约定。

## 仓储层

| 仓储 | 职责 |
| --- | --- |
| `TrainingRepository` | 训练记录聚合：创建、写入动作（upsert）、移动、完成、重开、删除。 |
| `ExerciseRepository` | 以动作为中心的视图，从训练记录折叠而来：建议、历史、摘要、PR。 |
| `RuleRepository` | 用户的别名规则。最长匹配胜出。 |
| `SettingsRepository` | 应用偏好，单个键值文档。`patch()` 是读取—合并—写入，并通过内部 promise 链**串行化**，因为设置页每敲一次键都会写一个 patch，两个重叠的 patch 都从同一份快照出发——第二次写入曾经会丢掉第一次的改动。`ProfileRepository` 使用同一条队列。 |
| `SummaryRepository` | 派生的每日总结，放在它们自己的集合里。 |
| `ProfileRepository` | 可选的用户资料，单个键值文档（`settingsRepository.ts`）。 |
| `MealRepository` | 饮食记录及其照片：按天列出、保存、删除（同时删除图片），以及纯函数辅助 `createEmptyMeal`、`createEmptyMealItem`、`sumItems`、`summarizeDay` 与 `imageKeyFor`。 |
| `ReminderRepository` | 提醒文档：列出（已启用优先，再按时间排序）、保存时的规范化、批量写入。 |
| `PlanRepository` | 训练计划：同一时刻只允许一个启用中的计划、按星期取当天安排、每周组数统计。 |

`buildRepositories()` 从 `StorageBundle` 装配整套仓储；页面调用 `repositories()`，从不自己构造。

名称解析的优先级现在就被固定下来，这样未来的 LLM 永远无法凌驾于用户之上：

1. 用户显式的别名规则
2. 此前确认过的映射
3. LLM 建议（只对没有任何规则覆盖的名称询问模型）
4. 原始名称

规则在记录过程中通过重命名对话框（`RenameExerciseSheet`）创建，也可以直接在规则页创建。`RuleRepository.resolve()` 以大小写不敏感的子串方式匹配，并优先选择最长的匹配，因此「incline bench」胜过「bench」。解析只改写 `normalizedName`；`rawName` 保留用户输入的原文，这就是规则永远无法悄悄改写历史的原因。

## 国际化

出厂三种语言：`zh-CN`、`en`、`es`。运行时不做任何翻译，调用点也不通过字符串查找解析任何键。

| 模块 | 职责 |
| --- | --- |
| `src/i18n/en.ts` | 参考目录：一个嵌套对象，28 个顶层分组。其他每种语言都按它的形状做类型检查，因此在这里新增一个键却不翻译，会是一个编译错误。 |
| `src/i18n/zh-CN.ts`、`src/i18n/es.ts` | 按 `en` 做类型检查，因此缺失或拼错的键在到达用户之前就会让类型检查失败。`src/test/i18n.test.ts` 断言键的齐备性、占位符一致，以及没有任何长字符串仍是英文。 |
| `src/i18n/types.ts` | `Messages`（把字面量放宽后的英文形状）、`MessageKey`（只指向叶子的点分路径）、`MessageParams`、`Catalogue`。像 `home.nope` 这样的笔误是类型错误，而不是一块空白标签。 |
| `src/i18n/index.ts` | `translate`、`translatePlural`、`createTranslator`（返回 `t`、`tPlural` 与该语言的 `intlTag`），以及 `CATALOGUES`——消息加上用于 `Intl` 的 BCP-47 标签。 |
| `src/i18n/locales.ts` | `LOCALES`、`LOCALE_LABELS`、`isLocale`、`localeFromTag`（任何中文标签或西班牙语标签都映射到该语言唯一的那份目录，其他一切映射到英文）与 `detectSystemLocale`。 |
| `src/i18n/runtime.ts` | 当前语言的同步镜像。`AppProvider` 在每次变化时写入它；崩溃界面读取它，因为类组件无法调用 hook，而设置文档只能异步拿到。 |
| `src/i18n/presets.ts` | 本地化的入门动作名。刻意是**数据，不是 UI 文案**：它们会作为动作名写进训练记录，因此住在字符串目录之外。 |

保持这套东西诚实的规则：

- 组件里不存在任何用户可见的字符串；`t('key')` 是唯一来源。
- 只需要两种复数形式（one/other），三种语言在这些字符串上一致，因此目录里显式带一个 `<key>One` 变体，由 `translatePlural` 挑选。这里没有 ICU 引擎。
- 未知占位符会原样显示为 `{count}`，而不是被替换成 `undefined`：可见的占位符是明显的 bug 报告，缺失的数字却会被静默地读成正确。
- `translate` 在开发环境发出警告，并依次回退到英文、再回退到键本身——缺口是响亮的，而不是隐形的。
- 模型生成的文本（AI 的回答、饮食估计自带的说明）**原样**展示，不翻译。那是模型的措辞，不是应用的文案。
- 日期、时间与数字格式化都走 `Intl`，使用该语言的 `intlTag`（`zh-CN`、`en-US`、`es-ES`）；`AppProvider` 还会设置 `document.documentElement.lang`，让屏幕阅读器与字体选择跟随这一选择。

切换语言会写入 `settings.language`（`'system' | 'zh-CN' | 'en' | 'es'`），而 provider 在每次渲染时解析 `'system'`，而不是存下解析结果：设备语言变化无需迁移就能被接住，显式选择则永久保留。什么都不需要重新加载——翻译器按语言做了 memo，因此切换只是让整棵树重新渲染，仅此而已。

## 主题、吉祥物与场景

主题即数据。`src/theme/tokens.ts` 里放着 `ThemeTokens`（背景、表面、输入框、文本颜色，主色/次色/强调色，语义色，状态栏）、`ThemeDefinition`（id、名称与提示的翻译键、三色色板、tokens）、`THEMES`（`ragdoll`、`bunny`、`panda`、`orca`）、`DEFAULT_THEME_ID`、`getTheme`、`getMascot`、`cssVarsFor`、`applyTheme` 与 `statusBarColor`。

- 组件从不引用原始颜色，也从不按主题 id 分支；它们消费 tokens。`cssVarsFor()` 把 tokens 映射到样式表已经在用的 `--*` 变量名上，`applyTheme()` 把它们写到 `:root`、设置 `data-theme` 并更新 `<meta name="theme-color">` 的值，让浏览器外壳跟随主题。因此 `src/styles/global.css` 里没有任何硬编码的配色——只有那个让首屏在设置加载之前仍有样式的兜底块。
- Android 状态栏通过 `src/services/nativeShell.ts` 跟随主题，它由 provider 的主题 effect 调用：`applyStatusBarForTheme()` 用 `statusBarColor()` 设置状态栏颜色，并根据颜色的相对亮度挑选图标样式（`statusBarIconStyle()`，有单元测试），而不是依赖一张逐主题的表，因此新增第五个主题时这里也不用改。整个模块由 `Capacitor.isNativePlatform()` 与 try/catch 保护：在浏览器里它什么都不做，缺少插件也不能弄坏启动路径。
- 吉祥物是手绘的像素画。`src/theme/pixel.ts` 定义 `Palette` 与 `PixelSprite`（由单字符调色板键组成的网格，`.` 表示透明），并且刻意不含 JSX，这样精灵数据与 tokens 可以引用这个类型，而不必把 `.tsx` 文件拉进非 JSX 的上下文。`src/theme/mascots.ts` 放着四张 16×16 的角色网格（布偶猫是应用自己的吉祥物，也是默认主题），`src/components/PixelArt.tsx` 用 `shapeRendering="crispEdges"` 把它们渲染成 `<rect>`。应用里没有任何图片文件、没有 base64 blob，也没有第三方素材。

### 场景：把母题组合成一幅画面

`src/theme/motifs.ts` 给每个主题一套小词汇——`ground`（沿底部平铺）、`accents`（立在其上）与 `specks`（飘在空中）：兔子的草、花与胡萝卜；熊猫的竹子与爪印；虎鲸的水、鱼与气泡；布偶猫的爪子、毛线球与爱心。`src/theme/scenery.ts` 把它们组合成一张宽幅精灵，`src/components/ThemeScenery.tsx` 负责绘制它（Home 的主视觉卡片、空状态）。

有三个细节是承重的：

- **整幅构图是一张精灵，而不是十几个组件。** 由十二张精灵组成的条带意味着十二个布局盒子和十二个纯装饰用的 SVG；合并之后只是一个 SVG 里的几百个 `<rect>`。
- **调色板键必须是一个字符。** 网格的一行是字符串，因此 `scene.palette['aG']` 永远无法用 `row[i]` 取到。合并那些调色板共用字母的精灵时（`G` 在一个主题里是草，在另一个主题里是绿色），必须把每个来源键重新映射到字符池里一个唯一的字符。这一点做错，场景就会渲染成*什么都没有*——第一版实现正是如此，因此 `src/test/theme.test.ts` 断言每个组合出来的场景都只有单字符键，且没有无法解析的像素。
- **排布是固定的，不是随机的。** 每次渲染都重新洗牌的场景读起来是噪声，而不是设计。

浏览器冒烟测试会对 Home 上场景的已绘制像素做指纹，跨三个主题断言它们互不相同，这样「每个主题绘制自己的场景」就不会悄悄退化成「每个主题给同一幅场景重新上色」。

### 启动器图标与启动画面

图标是手绘的布偶猫，按原稿使用，而不是重画：`design/icon-candidates/source/cat-sketch.jpg`。`render-android-icons.ps1` 把它裁剪成 350×350 的正方形（保留整只猫，去掉爱心和右边缘相邻的那幅画），从草图自己的四角采样纸张颜色，并用 `System.Drawing` 合成每个密度——`ic_launcher` 与 `ic_launcher_round` 用 48/72/96/144/192，自适应图层用 108/162/216/324/432。`render-splashes.mjs` 用同一份裁剪图渲染各密度与各方向的启动画面。这两步都不需要图像库或设计工具。

两个结构性决定：

- **原画是自适应图标的背景层。** 草图没有透明通道，因此作为前景层时，它自己的白色方块会压在背景色上，接缝可见。作为背景层它则是满幅的；遮罩裁掉的是纸，而不是猫。这颠倒了通常的排布（彩色背景 + 前景原画），也正是 `mipmap-anydpi-v26/ic_launcher.xml` 把 `<background>` 指向位图、把 `<foreground>` 指向透明占位图的原因——这也意味着启动器的视差效果没有东西可移动。
- **猫占传统方形图标的 88%、圆形图标的 78%、自适应图层的 78%。** 自适应图标保证可见的区域是 108dp 中居中的 72dp，且其中内接一个圆形遮罩；78% 让耳朵、眼睛和鼻子都留在这个区域内。圆形遮罩会裁掉最外侧的胡须，因为草图是画到边的——替代方案是一只猫看起来迷失在自己图标的中央。
- **入图时会用 `ImageAttributes.SetGamma(1.35)` 加深画面。** 这是一张浅色铅笔草图，在 48px 下毛发本来会消失进纸张里。Gamma 是这里正确的旋钮，对比度曲线则是错误的那个：毛发是位于中灰之上的浅灰，加对比度会把它推向白色，而 gamma 压暗中间调、让接近白色的纸张留在原处。随后再从调整后的原画重新采样留白颜色，使平铺填充与裁剪边缘的色调相差不超过一两个色阶，两者相接处不会出现可见的方块。

`design/icon-candidates/alternates/` 保留了最早绘制的矢量猫（与像素吉祥物同一族），`uc-monogram/` 保留了更早的字母形方案；两者都没有随包发布。

应用内的主题吉祥物仍然是像素画。它是 16×16，必须与兔子、熊猫、虎鲸的精灵相匹配，而且它在选择器里就挨着它们——把一张 JPEG 草图放进那一行会看起来像个错误，因此草图是应用的身份，像素猫是布偶猫主题的吉祥物。

- 新增第五个主题只需要一个 `ThemeDefinition`、一张精灵和几个母题；不需要改任何页面、组件或样式表。`src/test/theme.test.ts` 把精灵当作数据来校验（正方形网格、每个调色板键都有定义、十六进制颜色、有真实轮廓、熊猫保持单色），并检查每个主题的文本/背景对比度。

主题纯粹是表现层。`settings.theme` 与 `profile.gender` 在构造上就是独立的：`normalizeSettings()` 没有 `gender` 字段，`normalizeProfile()` 没有 `theme` 字段，单元测试与浏览器冒烟测试都对此做了断言。

## 用户资料

`src/pages/ProfilePage.tsx` 编辑 `UserProfile`；`ProfileRepository` 把它作为单个键值文档存进 `profile` 键值存储。它的「可选」是最强意义上的：每个字段都可以为空，没有任何东西以它为门槛，未填写的资料在备份里写成 `null`，而不是一个空对象。

`src/services/ai/userContext.ts` 把它变成模型真正会看到的那个短块：

- `resolveMetrics()` 把身高/体重/目标体重解析成公制值。`unitSystem` 决定存储的数字如何被**解读**（在英制模式下，存下的 `weightKg: 130` 意味着用户输入的 130 lb），而这是唯一发生该换算的地方。
- `resolveAge()` 优先使用直接输入的年龄，否则从生日推导。`parsePlainDate()` 从各个部分构造 `YYYY-MM-DD`，而不是用 `new Date('2005-06-16')`——后者会被 JavaScript 解析成 UTC 午夜，从而在任何位于 UTC 以西的时区把生日（以及年龄）偏移一天。
- `buildProfileBlock()` 只输出填好的那些行；空资料产生空字符串，`buildUserContext()` 随后会整体省略 `## User profile` 标题，而不是向模型宣告「Sex: unknown」。资料页原样展示这个块，因此将要发送的内容永远不会是意外。
- 性别只出现在这里，别处没有。它是给模型的上下文，永远不是主题或行为的输入。

## 动作历史

`ExerciseRepository.history(name)` 把每一条已存训练记录折叠成 `ExerciseHistoryEntry[]`（最新在前，带有效组数、容量与最佳一组），`summary(name)` 再把它归约成页头统计。`/exercise/:name` 页面自己不持有数据——它渲染这两次调用的结果，外加一张无依赖的 SVG 折线图，展示每次训练的最佳一组。

## 备份与恢复

`src/services/backup.ts` 拥有格式；`src/services/fileTransfer.ts` 拥有把字节移入移出设备的过程。

```
BackupDocument {
  format: 'fitness-agent-backup', version, exportedAt, app
  settings: Omit<Settings, 'aiApiKey'>   // the key is structurally excluded
  workouts[], aliasRules[], summaries[]
  meals[], reminders[], plans[], profile: UserProfile | null
}
```

- API key 在 `createBackup` 里通过解构剥离，而 `BackupDocument` 根本没有声明这个字段。`src/test/helpers/assertBackupSource.ts` 对源码断言这两点，因此把 key 加回去会让测试失败，而不是悄悄泄漏。
- `parseBackup` 严格校验（格式标记、版本、workouts 数组），并拒绝来自更新格式的备份，而不是静默丢弃字段。个别畸形记录会被过滤掉，因此一行坏数据无法让一次本来良好的恢复失败。
- `applyBackup` 只支持替换：一次恢复被期望精确复现备份，而静默合并两份已经分叉的历史正是人们丢数据的方式。恢复之后会使存储缓存失效。
- 饮食照片刻意**不**放进文档：它们会主导文件的体积，而且它们不是记录本身。恢复后的饮食记录保留每一个数字，只是没有图片。
- 什么都没填时 `profile` 为 `null`（`hasProfileContent()`），并且导入时只接受形状正确的资料对象；其他任何东西都变成 `null`，而不是被强制转换进线上资料。
- 导出在 Android 上写入应用缓存目录，并把文件交给系统分享面板；在浏览器里就是一次普通下载。导入永远是文件选择器。

## 迁移与向后兼容

应用已经有带着数据的安装实例，因此新增字段绝不能弄坏其中任何一个。三层机制负责这件事，每一层都由 `src/test/migration.test.ts` 覆盖：

- **文档。** `normalizeSettings()` 与 `normalizeProfile()` 显式解析每个字段，而不是盲目合并：未知的主题、语言、单位、角色、性别、目标或活动水平都会回退——回退到默认值，或者对天生可选的资料枚举回退到 `null`——不合理的数值（0 kg 体重、400 岁年龄）会变成 `null`，而不是一个会悄悄污染每次 AI 请求的数字；主题出现之前那个已废弃的 `colorScheme` 值则直接丢弃，改用默认主题。`SettingsRepository.ensureInitialized()` 会把规范化后的文档写回去，因此迁移是完成的，而不是每次读取都重新推导一遍。
- **存储。** IndexedDB 以 `DB_VERSION = 4` 打开，SQLite 以 `SCHEMA_VERSION = 4` 打开。两次升级都是增量的：`onupgradeneeded` 只创建缺失的对象存储，SQLite schema 是一串 `CREATE TABLE IF NOT EXISTS`。因此一个 1 级数据库会保留它原有的每一行——测试会手工构造这样一个数据库（以及一个 2 级数据库），保存一条训练记录，再通过应用打开它，断言那条记录仍在，并且新的存储区可用。`meals` 是 v2 来的，`reminders` 和 `plans` 是 v3，`aiChat` 是 v4；`src/test/aiConversation.test.ts` 用同样的方式走了一遍 v3 → v4，并在之后再开一次连接，断言存下的对话仍然读得出来。
- **备份。** 一个格式版本 1 的备份没有 `meals`，也没有 `profile`，并且可能带有 `theme: 'dark'`。它仍然能导入：缺失的数组变成空数组，profile 变成 `null`，已废弃的主题值回退到默认主题，训练记录原样恢复。

迁移永远不会删除训练历史；升级路径中没有任何东西会发出 `DELETE` 或 `clear()`。

## 训练记录

`WorkoutSessionProvider`（`src/state/WorkoutSessionContext.tsx`）拥有当前会话：

- 每次编辑都立刻在本地生效，然后**以 300 ms 防抖**写入存储，并在卸载时与 `visibilitychange` 时冲刷。关掉应用或刷新页面永远不会丢失一组。
- 计时时钟由 `startTime` 推导，并每秒重新走一次；它不会每个 tick 都持久化。
- `finish()` 打上 `endTime` 并冻结 `durationSec`，随后这条训练记录成为历史。
- 未完成的训练可以通过 `TrainingRepository.inProgress()` 再次找到，Home 的「Resume workout」就是这么来的。
- `addSet()` 在 React 状态更新函数之外组装新的一组（包括它的 id），因为 StrictMode 会把更新函数调用两次，而 id 生成必须恰好发生一次。

### 离开、完成与丢弃

训练一开始草稿就写入存储，因此存在三种不同的退出方式，它们之间的差别很重要：

- **Home**（页头按钮）只是导航离开。草稿留在存储里，Home 提供「Resume workout」，这正是中途离开仍然安全的原因。
- **Finish & save** 先跑异常值复核，然后 `finish()` 打上结束时间，这条记录成为历史。
- **Discard workout** 是移除草稿的唯一方式。它在完成面板里提供，会请求确认，然后调用 `WorkoutSessionContext.discard()`：待执行的防抖写入会在删除*之前*被丢弃，因此定时器无法在行刚被删除后立刻把它重新建出来。没有这个顺序，中途走开会让一条未完成的训练永远留在 Home 上，并且没有办法摆脱它。

误存的训练记录不是被丢弃，而是从它的详情页（`/history/:id`）删除，那里同时也是 **Reopen as in-progress** 所在之处——「已完成」是一种状态，不是一把锁。

## 异常值检测

`src/services/validation.ts` 里的 `findAnomalies()` 把每个记录的重量与同一动作过去几次训练的中位数比较。它至少需要 3 次既往训练才会开口，而且它只**标记**：

- 它从不阻止保存，
- 它从不改写数值（600 kg 不会被悄悄改成 60 kg）。

建立在它之上的确认/编辑/忽略 UI 就是下面「异常值复核」一节。

## 提醒

一条提醒是一份小文档（`src/repositories/planRepository.ts`）加上一个由**操作系统**保管的承诺。应用拥有这份列表，操作系统拥有排期，而两者会各自漂移——重启会丢掉闹钟，稍后才授予的权限会改变可排期的内容，从备份恢复回来的提醒则完全没有排期。与其追踪它们分叉的每一种方式，`src/services/reminderScheduler.ts` 干脆从存储重建整份排期：

- `sync()` 清除这个应用排期的一切，再重新加入已启用的提醒。它是幂等的，因此在启动时（由 provider 在设置就绪后调用）、权限被授予之后，以及导入之后都会被调用。
- 通知 id 是提醒 id 的哈希（`notificationIdFor`），这让重新排期变成替换而不是重复。一条按三个工作日重复的每周提醒会占三个 id，从基准 id 依次偏移。
- 编辑会先取消再排期：在某些 Android 版本上，用已存在的 id 调用 `schedule()` 并不是替换，而重复的提醒比漏掉的提醒更糟。
- 每个入口都由 `Capacitor.isNativePlatform()` 与 try/catch 保护。在浏览器里这个模块是惰性的，正因如此整条流程——包括权限那一步——都能在冒烟测试里跑通，由 Web Notifications API 顶替。

规范化放在仓储里，而不是各个调用点，因为一条提醒可能来自三个地方：编辑器、AI 提议和备份文件。未知的类型变成 `custom`，不可能的时间变成默认值，星期会被去重、排序并做范围检查——因此一个畸形的文件无法把操作系统会拒绝的排期交给它。

## 训练计划

计划是一周的*意图*。它永远不碰训练历史：从计划开始一次训练会把当天的动作复制进一份**新的训练记录**（`createWorkout` + `upsertExercise`），之后用户照常记录。因此一个后来发现不对的计划，代价只是一次编辑，别无其他；删除计划也不会影响由它记录下来的任何一次训练。

- `PlanRepository.save()` 强制「恰好一个启用中的计划」，而不是信任页面：Home 卡片与预填都需要对「我这周练什么」有唯一的答案。
- `reps` 处方是**文本**（`"8-10"`、`"5"`、`"AMRAP"`），因为训练计划本来就是这么写的。从计划开始一次训练时，只有开头的数字会变成次数，其余部分留给用户——对「AMRAP」做猜测会把一个错误的数字写进记录。
- 目标重量像其他所有重量一样以 kg 存储，因此切换显示单位永远不会改写计划。

## 首次启动引导

全新安装时 `settings.onboardedAt` 为 null，这就是把应用导到 `/welcome` 的依据；该页面先请求相机与照片权限，再请求通知权限，每次请求前都会解释，并且两步都可以跳过。

有两个细节是承重的：

- **这道关卡会等待设置加载完成。** `AppProvider` 从 `DEFAULT_SETTINGS` 起步，而它的 `onboardedAt` 是 null，同时 provider 暴露一个 `ready` 标志。不等它就绪，欢迎分支会在*每一次*启动时渲染一瞬——而由于该分支以 `<Navigate to="/welcome" replace />` 结尾，它会重写 URL：一个深入应用内部的链接会落在 Home 上。
- **「不是字符串」不等于「字段不存在」。** 全新安装会显式存下 `onboardedAt: null`，而这个页面出现之前的安装则完全没有该字段。把两种情况都当成「旧文档」会把全新安装标记成历史遗留，于是引导再也不出现——第一次读取与 `ensureInitialized` 自己的写入竞争一次就足以触发。现在 `normalizeSettings` 区分这三种情况（时间戳／显式 null／缺失），`src/test/reminders.test.ts` 对三者都做了固定。

## AI 层（可选）

一切都放在 `src/services/ai/` 下。这个目录之外没有任何东西知道用的是哪家厂商，也没有任何页面需要特判「AI 已关闭」。

| 模块 | 职责 |
| --- | --- |
| `provider.ts` | `LlmProvider` 接口、`LlmConfig`、`ChatMessage`/`ContentPart`（只有文本与图片两种 part）、草稿/建议类型，以及一个 `DisabledLlmProvider`：它解释如何打开 AI，而不是在调用点抛错。 |
| `openaiProvider.ts` | `POST {baseUrl}/chat/completions`。`fetch` 可注入，因此这个客户端完全可以离线测试。消息按原样发出，这正是多模态消息能不变地通过的原因。 |
| `prompts.ts` | 三个角色的系统提示，以及解析/规范化/总结的提示。 |
| `localParser.ts` | 离线解析器。中文与英文，可自由混用。 |
| `contextBuilder.ts` | 组装能回答该问题的最小上下文。 |
| `materialize.ts` | 把*已确认*的草稿变成记录。 |
| `proposals.ts` | 提醒与训练计划的 AI 提议：只提议，逐字段校验，什么都不写入存储。 |
| `vision.ts` | 模型能力检测：根据模型名家族得出 `supported` / `unsupported` / `unknown`，外加用户覆盖、`image_url` content part 与 `looksLikeVisionRejection()`。 |
| `mealAnalysis.ts` | 照片 → 可编辑的饮食提议（`analyseMealPhoto`、`parseAnalysis`、`extractJson`）以及更正循环（`reviseMeal`），并把 `VisionNotSupportedError` / `VisionRejectedError` 作为不同的结果。 |
| `userContext.ts` | 资料 → 简短的模型上下文块（`buildUserContext`、`buildProfileBlock`、`resolveMetrics`、`resolveAge`、`parsePlainDate`）。 |
| `index.ts` | `AiService` 门面：设置 → provider，并且是唯一决定何时涉及 AI 的地方。还暴露 `visionCapability`、`analyseMeal`、`reviseMeal` 与 `userContext`。聊天会携带最多 8 轮先前问答，并限制上下文字符数。 |
| `src/repositories/aiConversationRepository.ts` | 在 `aiChat` 本地键值区保存、读取和清除最近 100 轮聊天记录。 |

### 视觉能力

不存在标准方式去问一个 OpenAI 兼容端点是否接受图片，因此 `src/services/ai/vision.ts` 给出显式的三态答案，而不是把猜测装扮成事实：

| 状态 | 含义 | 应用怎么做 |
| --- | --- | --- |
| `supported` | 模型名匹配已知的多模态家族（或用户覆盖了这个判断）。 | 发送图片。 |
| `unsupported` | 模型名匹配确定纯文本的家族（或用户覆盖了这个判断）。 | 完全拒绝附加图片，并说明是哪个模型的问题。 |
| `unknown` | 没有可靠信号。 | 让用户尝试，并如实报告端点的回答。 |

- 家族列表匹配的是子串，而不是精确版本号，因此一个新的小版本不会把一个可用的配置悄悄翻成「不支持」。视觉家族先被检查，所以 `qwen2.5-vl` 不会被纯文本的 `qwen2.5` 条目截走；纯文本列表刻意保持很短，因为一个错误的条目会挡住一个可用的功能。
- `settings.aiVisionOverride`（`true | false | null`）永远优先：配置这个端点的人比一张子串表更清楚。设置页会显示检测到的状态、原因和覆盖开关。
- `looksLikeVisionRejection()` 能识别那些用散文而不是可用状态码拒绝图片的网关——一条同时提到 image/vision/modality *和* 拒绝的消息——于是「400 Bad Request」变成「这个模型可能不接受图片输入」。
- 检查在请求**之前**进行（纯文本模型给出的是一条解释，而不是一个不透明的 API 错误），并且手工填写饮食的表单在任何情况下都保持可用。

### AI 绝不能成为必需

- 离线解析器会被**优先**尝试；一次本地匹配不花任何请求，也不可能幻觉。只有它什么都解析不出来时，才会去问模型。
- `DisabledLlmProvider` 返回与真实 provider 相同的形状，因此 AI 关闭时 Quick Log 的表现完全一致。
- 如果模型返回不可用的数据，用户的文本会作为训练记录的备注保留下来，而不是丢失。
- 建议会与用户实际输入的内容做比对过滤，因此幻觉出来的动作名会被丢弃，而不是被提供出来。

### 未经确认，任何东西都不会写入记录

`draftToPreview` → 用户编辑 → `previewToDraft` → `materializeDraft`。解析器完全无法访问存储；`materialize.ts` 是唯一把草稿变成记录的模块，而且它在用户按下确认之后才运行。这让「模型永远不会自己写入你的记录」成为结构性属性，而不是一句承诺。

### Context Builder 的优先级

1. 当前正在记录的那次训练
2. 涉及动作最近 3–5 次训练
3. 最近 7 天的训练（滚动窗口，而不是「从周一起」），存在已存日报时使用它们
4. 每周汇总——优先使用**已存**的总结，并以实时计算作为兜底，这样上下文不会仅仅因为总结还没生成就是空的
5. 每月汇总，仅在问题涉及更长趋势时使用

上下文渲染为紧凑的纯文本，而不是原始 JSON：token 少得多、模型更容易读，也让隐私审查变得轻而易举。`TrainingContext.sections` 记录包含了哪些内容，AI 页会在每个回答下面展示它。

AI 页面会在发问时读取本地进行中的训练并传入其 ID，因此当前训练确实会加入上下文。聊天记录单独保存在 `aiChat`，重新打开页面后仍可查看；新请求至多携带最近 8 轮问答，并受 16,000 字符上限约束。历史回答只帮助解析追问，不作为训练事实来源。每条回答的上下文披露会包含这些前文；聊天记录不进入备份。

### 角色

`recorder` 解析与查找，不给建议；`reminder` 报告实际记录了什么；`coach` 则把训练记录和假设性的进阶目标分开。教练的两段标题会跟随用户最新问题的语言。只有在相关历史记录提供依据时才给出具体数字目标，并明确标成建议；缺少依据时会先简短追问，或只给非数字选项。提示词也明确禁止建议冲极限、强迫次数、带痛训练、诊断和康复处方。

资料块只附加在**饮食**请求上。训练上下文构建器保持不变、不包含它，因此关于训练的问题只用训练数据回答。

## 饮食

```
/meals          MealsPage        grouped by local day, paged 40 at a time, searchable
/meals/new      MealDetailPage   editor; the same component edits an existing meal
/meals/:mealId  MealDetailPage   loads the meal and its stored photo
```

流程是 `photo → analysis → editable result → correction loop → confirm → save`，并且每一步都保持两条性质：

- **用户确认之前，任何东西都不会进入存储。** 分析产出的草稿保存在组件状态里；只有 `save()` 会写入，它也是图片唯一的写入者。
- **每个字段都能直接编辑。** 对话式更正是加速器，不是关卡：AI 关闭时，或者出于偏好，整张表单都可以手工填写。

| 模块 | 职责 |
| --- | --- |
| `src/repositories/mealRepository.ts` | `MealRepository`（`all`、`get`、`forDate`、`between`、`count`、`save`、`putMany`、`remove`、`clear`，外加 `saveImage` / `loadImage` / `removeImage`），以及纯函数辅助 `createEmptyMeal`、`createEmptyMealItem`、`sumItems`、`summarizeDay`、`imageKeyFor`。 |
| `src/services/imageInput.ts` | `pickImage(source)` 打开一个隐藏的 `<input type="file">`，来源是相机时带 `capture="environment"`；`compressImage()` 通过 canvas 把最长边缩到 1280 px 并以质量 0.72 重新编码为 JPEG，因此不需要随包发布图像库。用户取消选择器时得到 `null`，这不是错误。 |
| `src/services/ai/mealAnalysis.ts` | 两条提示（`MEAL_ANALYSIS_SYSTEM`、`MEAL_REVISION_SYSTEM`）、`analyseMealPhoto()`、`reviseMeal()` 以及宽容的 JSON 解析。 |

值得保留的决定：

- **一张照片自占一行。** `imageKeyFor(mealId)` 是确定性的（`image:<mealId>`），因此一条饮食记录最多有一张照片，重新分析会替换它而不是让旧照片变成孤儿。写入新照片永远不会重写别人的。
- **删除饮食记录会删除它的照片**，而 `MealRepository.clear()` 会先遍历一遍：当图片住在另一个存储区时，清空集合并不够。
- **总量来自各项。** `sumItems()` 在模型返回各项时使用，也在手工编辑某一项之后使用，因此屏幕上醒目的总量与明细不可能互相矛盾。处处未知的值保持 `null`——「未知」永远不会被显示成「零卡路里」。
- **更正只做调整，不重新开始。** `reviseMeal()` 把当前数字连同更正一起发送，因此「米饭大约 150 g」会重新缩放那一项，而用户没提到的每一项都原样保留。被更正过的饮食记录标记为 `ai-edited`，因为用户参与了它。
- **解析对包装宽容，对数值严格。** `extractJson()` 接受带围栏或带填充的回复；不是有限非负数的数字变成 `null`，因此幻觉出来的字符串无法以 `NaN` 的形式写进饮食记录；没有名称的条目会被丢弃，而不是存成空白；完全不是 JSON 的回复会产生一份空提议，而不是抛异常。
- **估计值必须看起来像估计值。** 提示词这么要求，`source` 与 `confidence` 把它存下来，UI 也重复它（`estimate · medium`，外加一行说明这些数字是估算的）。
- 照片被有意**排除在备份之外**。备份保持为数据的记录；恢复后的饮食记录保留数字、丢掉图片。

## 总结

派生数据，**本地**生成——这正是它们在 AI 关闭时仍然可用的原因。LLM 之后可以改写总结的正文，但数字、要点与对比永远来自 `src/services/summaries/`。

各层向上压缩，每一层只读它下面的一层：

```
Workout ──► Daily Summary ──► Weekly Summary ──► Monthly Summary
```

这就是让一个月总结保持廉价的原因：它从不重读每一条训练记录，也永远不会把整月的 JSON 交给模型。

| 模块 | 职责 |
| --- | --- |
| `buildSummary.ts` | 纯构建器：`aggregate`、`describeFocus`、`describeMainLifts`、`describeChanges`、`buildDailySummary`、`buildRollupSummary`，以及周期键的运算（`weekKey`、`monthKey`、`weekDayKeys`、`monthWeekKeys`、`previousPeriodKey`）。 |
| `summaryService.ts` | 自底向上持久化它们：刷新一天也会刷新它所在的周与月。`rebuildAll()` 从历史重新生成全部内容。 |

值得保留的设计决定：

- **总结从不编造数字。** 未知的动作名对当天标题没有贡献，而不是被猜一个；小于 1 kg（英制下 2 lb）的变化不会被当作变化报告。
- **关注点归属是每个动作一组**，因此「Overhead Press」不会被同时算作胸部和肩部训练。
- **比较使用真实训练记录，而不是总结。** 「vs before」的基线来自历史计算出的该动作此前最佳一组，因此缺失或被删除的总结永远无法掩盖一次退步。
- **没有记录任何内容的一天会删除它的总结**，而不是留下过期的总结。
- **重新生成即替换**（id 形如 `sum_<kind>_<periodKey>`），因此永远不会产生重复。
- 周期键遵循**用户的本地日历**；日为 `YYYY-MM-DD`，周为该周的周一，月为 `YYYY-MM`。

删除一条总结只会碰到这条总结。这是结构性的——总结住在自己的集合里——并且从仓储层和浏览器两侧都有断言。

## 异常值复核

`src/services/validation.ts` 里的 `findAnomalies()` 把每个记录的重量与同一动作过去几次训练的中位数比较。它至少需要三次既往训练才会开口，并排除正在检查的那次训练，因此编辑一条旧记录时不会把它自己的数字当成基线。

`useOutlierReview`（`src/state/useOutlierReview.tsx`）是共享的 UI 契约，结构化记录器与 Quick Log 都用它——事实上 Quick Log 才是最可能被打出「600kg」这类笔误的地方：

- 检查**从不阻止保存**；无论用户怎么回答，调用方的保存都会执行；
- 除非用户输入替代值，否则数值**从不被改写**，而更正会走 `applyWeightCorrections`，因此 `weightKg` 是被重新推导而不是被补丁式修改；
- 如果检查本身抛错，训练记录仍然会被保存。

## 可读导出

JSON（`services/backup.ts`）是用于**恢复**的格式。`services/export/` 产出用于**阅读**的格式，而且它们刻意是单向的：

| 格式 | 形状 | 说明 |
| --- | --- | --- |
| Markdown | 总量、按动作分列的表，然后每条训练记录及其各组 | 可以直接粘贴进笔记；存在当日总结时会包含它 |
| CSV | 每组一行，19 列 | 可以在电子表格里打开；在显示的重量与单位旁边给出规范的 `weightKg` |

`csvCell()` 会给开头的 `=`、`+`、`-` 或 `@` 加上一个引号前缀，因此用户写进某一组备注里的文本无法被 Excel 或 Sheets 当作公式执行。

两者都建立在同一个 `selectWorkouts()` 范围过滤器上，并共用 `aggregateForExport()`，因此两种格式在一条训练记录的数字上永远一致。

## 总结的补算与润色

`SummaryService.catchUp()` 在 Home 页运行。它为当前与上一周/月补齐缺失的总结——也就是历史通过导入进来，或来自早于总结功能的构建的情况。它是有界的（只看当前/上一个周期，并对每日回填设上限）且幂等的，因此第二次启动不会创建任何东西。

`services/summaries/polish.ts` 是建立在它之上的可选 AI 层：

- 本地的 `body` 在设备上由真实的组生成，并且**永远不会被覆盖**；
- AI 关闭时 `polishSummary()` 是一个 no-op，报告 `AI is off`；
- 不可用的回复（为空、过短或超过 1200 个字符）会被拒绝，本地文本继续生效；
- 端点失败会被吞掉——总结绝不会因为网络问题而变成空白；
- `displayBody()` 在存在 `llmBody` 时优先使用它，`clearPolish()` 可以还原。

只有正在被润色的那一条总结会被发送出去；有一个测试断言另一天的训练不会被包含进请求。

## 响应式布局

`src/styles/global.css` 顶部有两条规则，它们就是整个设计系统：颜色只来自主题 tokens，尺寸是流式的。固定像素值只出现在确实具有固定尺寸的地方（触摸目标、图标按钮、导航栏）；其他一切都是 `rem`、`fr`、`clamp()` 或 `min()`，因此没有任何东西假定一台 360×800 的手机。

| 变量 / 断点 | 值 | 效果 |
| --- | --- | --- |
| `--font-base` … `--font-xl` | `clamp(...)` | 随视口增长的字号阶梯，在手机上仍然易读。 |
| `--measure` | `42rem` → `46rem`（≥40rem）→ `58rem`（≥56rem）→ `66rem`（≥75rem） | 一列内容的阅读宽度。它让一行保持可读，也让卡片不会在桌面上横向拉长。 |
| `--rail` | `13.5rem` → `15rem`（≥75rem） | 侧边导航存在时的宽度。 |
| `--tap` | `2.5rem` | 触摸目标永远不会小于这个值。 |
| `@media (min-width: 40rem)` | 竖屏平板、展开的折叠屏、横屏手机 | 更宽的 measure、更宽松的内边距、两列的 `.split`，面板不再贴底。 |
| `@media (min-width: 56rem)` | 大平板与接近桌面的宽度 | `.app-shell` 变成 `rail + main`，侧栏在 `100dvh` 上 sticky，底部栏隐藏，`.card-grid` 变成三列。 |
| `@media (min-width: 75rem)` | 接近桌面的比例 | 更宽的 measure 与侧栏；多出来的空间给内容列，而不是给行长。 |
| `@media (max-height: 30rem) and (orientation: landscape)` | 横屏手机 | 压缩导航与页头高度，让栏条不吞掉屏幕。 |
| `@media (max-width: 22.5rem)` | 很窄的手机（≈320 px） | 收紧间距，并把 `.stat-grid` 收成一列，而不是溢出。 |

- **一份导航列表，两种呈现。** `src/App.tsx` 里只有一个 `NAV_ITEMS` 数组；手机底部栏渲染 `primary` 条目，侧边栏渲染每一个目的地。两者都不是独立组件，因此一条路由不可能在一种形态上可达、在另一种形态上缺失。
- **网格是 `auto-fit` + `minmax`**，因此 `.stat-grid` 与宏量营养素网格用一条规则就能在手机上给两列、在平板上给四列，不需要媒体查询，也没有固定的卡片数量。
- **面板是适配而不是缩放。** 面板在手机上贴底（拇指可达），在 ≥40rem 时变成居中对话框，`max-width: 34rem`；键盘弹出时 `dvh` 让它留在屏幕上。Toast 的宽度上限是 `min(92vw, 30rem)`。
- 一个 `prefers-reduced-motion` 块会关闭面板动画。

浏览器冒烟测试把整套用例跑两遍——390×844 与 1280×900——因此底部栏与侧边栏两个分支都被覆盖，并在每个宽度断言：恰好有一个导航可见、它就是 56rem 断点所暗示的那一个、没有任何东西横向溢出、宽屏上内容有宽度上限并居中。

## 健壮性

有三样东西存在，是因为用户的历史是他们数据的唯一副本，而显示问题绝不能看起来像数据丢失：

- **`ErrorBoundary`** 包住整个应用。React 在未捕获的渲染错误时会拆掉整棵树，因此没有它，一条畸形的训练记录——手工编辑过的 JSON、写了一半的导入、未来的迁移 bug——就会让屏幕变白。兜底界面会说明数据仍在设备上，提供重新加载，直接链接到 Data 页去导出备份，并且绝不自行「清理」任何东西。一个浏览器测试通过真实的边界渲染一个故意崩溃的组件，并断言恢复界面出现。
- **先启动画面，再应用。** 打开数据库与读取设置是异步的；在历史很大时冷启动并非瞬间完成，而什么都不渲染会让应用看起来启动失败。
- **分页列表。** History 一次渲染 60 条训练记录，Meals 一次 40 条，各自带一个「show more」按钮。多年的历史是几千张卡片，全部渲染会让手机上的滚动与编辑变得迟钝。饮食列表还只为当前这一页的行加载缩略图，因此很长的饮食记录不会一次性把每张照片都从数据库里读出来。

崩溃界面是翻译过的，这正是 `i18n/runtime.ts` 存在的原因：类组件无法调用 `useI18n()`，而所选语言住在一个只能通过异步存储调用拿到的设置文档里。`AppProvider` 把解析后的语言镜像进那个模块，因此恢复界面能立刻以用户的语言渲染，完全不依赖那个可能刚刚失败过的存储。它是纯 DOM——没有路由、没有 context、没有存储——因为崩溃可能来自其中任何一个，而它唯一的逃生口（`#/data`）是一个用户即使按钮点不到也能手动输入的 hash。

`TrainingRepository.complete()` 在没有 `endTime` 时总是打上墙上时钟作为结束时间，因此时长永远不会是负数。训练详情页为「误点完成」的情况提供 **Reopen as in-progress**——「已完成」是一种状态，不是一把锁。

## 测试

| 命令 | 覆盖内容 |
| --- | --- |
| `npm test` | `src/**/*.test.ts` 中的 302 个测试、59 个套件：仓储、单位与格式化、指标、别名规则、动作历史与个人最佳、异常值检测与更正路径、总结构建器 / 服务 / 补算 / 润色、Markdown 与 CSV 导出、备份/恢复与 v1 兼容、迁移、设置写入的串行化、**提醒排期算术与计划规范化**、**AI 提议解析**、**流式分块读取**、**本机聊天记录与前文记忆的上限**、离线解析器、上下文构建器、针对 mock `fetch` 的 OpenAI 客户端、主题 tokens、状态栏图标选择、像素精灵、**母题与场景组合**、三种语言的目录齐备性**与完整度**、视觉能力检测、饮食分析与资料上下文，通过 `fake-indexeddb` 测试的**真实** `IndexedDbAdapter`，以及通过伪造的 Capacitor 插件测试的 `SqliteAdapter` 真实 SQL。 |
| `npm run test:browser` | `scripts/smoke.ps1` 启动一个一次性的 Vite 服务器，并通过 CDP 驱动无头 Chrome（或 Edge）跑过带 `?smoke=1` 的真实应用，跑两遍：手机视口（390×844）与桌面视口（1280×900），各自使用独立的浏览器配置目录，因此两次运行不会互相影响。`src/dev/browserSmoke.ts` 里的页内套件会跨两次页面重载记录并完成一次训练，走一遍动作历史（图表指标切换、PR 徽章）、规则、备份往返、Markdown/CSV 导出、浏览器下载路径、Quick Log 预览 + 确认、AI 关闭时的 AI 页、总结、异常值复核、手工录入/编辑/删除饮食、视觉能力特有的拒绝、双向语言切换、主题切换以及响应式布局——然后通过真实的错误边界让一个组件崩溃，并断言 React 没有向控制台输出任何错误。每项检查都必须在两个视口下通过。 |
| `npm run verify` | lint + typecheck + tests + 生产构建。 |

测试跑在 `node --test` 上，使用 Node 原生的 TypeScript 转换，以及一个用于无扩展名导入的小解析钩子（`scripts/ts-resolve-loader.mjs`）——不依赖任何测试框架。

存储替身实现同一份 `StorageAdapter` 契约：`MemoryAdapter`（快速的仓储测试）与 `FakeSqlitePlugin`（在内存表上执行 SQLite 适配器真实的 SQL）。因此 IndexedDB 与 SQLite 两个适配器都得到了真正的覆盖，而不是假定的行为。

### 固化进测试脚手架的经验

浏览器冒烟测试对自己的脚手架刻意采取对抗姿态，因为下面每一条在开发过程中都曾产生过*假绿*：

- 断言的作用域限定在 `#root` 内并做大小写不敏感匹配。脚手架自己的结果面板里就包含检查名，而 CSS 的 `text-transform: uppercase` 会反映到 `innerText` 里——任何一条都会让断言轻易通过。
- 面板被钉在角落并设置 `pointer-events: none`，因为全屏覆盖层会让 `innerText` 报告面板而不是页面。
- `console.error` 会被捕获并断言为空：React 报告非法 DOM 嵌套时并不抛错，History 列表里嵌套的 `<a>` 元素就是这样被抓到的。
- 除非面板报告 `note: "done"`，否则包装脚本判定本次运行失败，因此失败或未完成的运行永远不会被报告成成功。
- 驱动器等待的是那个 `done` 标记，而不是面板的存在；PowerShell 包装脚本会预热 Vite 的模块图——对整个冒烟测试图做按需转换比脚手架愿意等待的时间更慢，看起来和挂起一模一样。
- 两次重载之间的协同使用应用自己的 IndexedDB，因为 `sessionStorage` 在无头 Chrome 中无法在重载后存活。
- 期望的 UI 字符串从翻译目录里读取，而不是复制进脚手架，因此语言检查断言的是*运行中的应用*与随包发布的翻译一致，而不是去比较第二份硬编码副本。套件用英文驱动 UI，并通过真实的选择器切换语言。
- 界面语言在第一次运行**之前被固定为英文**。应用默认跟随设备语言，因此在设置为中文或西班牙语的机器上，所有英文断言会同时失败——一次看起来像应用坏了的运行，其实是假设坏了。`src/dev/smokeEntry.ts` 写入该偏好，如果不是 `en` 就重载一次；`runBrowserSmoke()` 里的重载预算涵盖了这次额外访问。
- 设置是通过**真实表单**修改的，而不是直接写仓储。provider 在挂载时读取偏好，因此直接写入对正在运行的页面不可见：视觉检查曾配置了一个纯文本模型，而饮食页从未看到它。
- 布局事实（哪个导航可见、是否有东西溢出、内容列多宽、主题网格有几列）都从实时视口读取，并且整套用例在两个宽度下运行——一个只在手机上跑过的检查，会悄悄在一个它从未见过的桌面布局上通过。可见性从渲染盒子测量，而不是 `offsetParent`：底部栏是 `position: fixed`，完全可见时 `offsetParent` 也是 null。
- 跨两个行内元素的文本断言作用在元素上，而不是页面文本上。`innerText` 会把日期和紧挨着的徽章无分隔地拼接起来（「…2026PR」），因此对整页做词边界搜索看不到那个徽章。
- 除了面板之外，脚手架还会写 `document.title = SMOKE:PASS | SMOKE:FAIL`，因此仅凭标签页标题就能诊断一次运行。
- Vite 在构建时把冒烟测试引导代码从 `index.html` 里剥离，因此发布的包里永远不含测试入口或 `src/dev/*` 模块。`main.tsx` 里最后的启动报告器由 `import.meta.env.DEV` 保护，因此生产环境的启动失败会显示可读的恢复界面，而不是一个 JSON 面板。（这个仓库里没有任何东西驱动 APK 本身；见 README 里的硬件说明。）
- PowerShell 包装脚本以显式的 `exit` 结尾，并杀掉开发服务器的**进程树**（`taskkill /T`）：`npx vite` 是一个包着子 node 进程的包装器，让那个子进程活着会让脚本的 stdout 管道保持打开，于是一次完全通过的运行会挂住调用方。当进程已经退出时 `taskkill` 还会写 stderr，而在 `ErrorActionPreference = 'Stop'` 下这会把一次通过的运行变成退出码 1——因此只对清理阶段放宽这一偏好。

脚本里记录了两个 Windows 特有的坑：Windows PowerShell 5.1 会把没有 BOM 的脚本按 ANSI 解码（因此 `smoke.ps1` 只含 ASCII 并以 BOM 保存），而 `Get-Content -Raw` 也按 ANSI 解码文件（因此报告 JSON 用显式的 UTF-8 解码器读取）。

## 隐私

所有数据都在设备上。没有项目服务器、没有账号、没有遥测。应用唯一可能发起的网络请求，是发往用户自己配置的 OpenAI 兼容端点，而且只在用户显式触发某个 AI 动作时。Android manifest 声明 `INTERNET` 是因为可选的 AI 功能与开发期的热重载需要它；其他任何东西都没用到它。

有三件事值得明确写出来，因为它们正是评判一个本地优先应用的标准：

- **饮食照片永远不会离开设备，除非在用户主动发起的那次分析请求里。** 它以 data URL 的形式存放在应用自己的键值存储中，在那一次请求里作为 `image_url` content part 发送，除此之外绝不上传到任何地方。它也不在备份里。
- **资料只存在本地**，它到达模型的唯一形式是附在饮食请求上的那个短块——从来不是整份设置文档，也从来不用于训练问题。
- **API key 存储在本地，并在结构上被排除在导出之外。** `BackupDocument` 没有声明这个字段，并且有一个测试对源码断言这一点。
