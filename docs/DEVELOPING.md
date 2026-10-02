# Developing FitAGI by Capy / 开发 FitAGI by Capy

Everything in this file is for people who want to **build, run or change the code**. If you only want
to install the app, the [README](../README.md) is the place to be.

本文件面向想**构建、运行或修改代码**的人。只想安装应用的话，看 [README](../README.zh-CN.md)。

**English** | [简体中文](#中文)

---

## Running it in a browser

The web build is not a separate product — it is the same code the APK runs, on IndexedDB instead of
SQLite. It is the fastest way to see a change.

```bash
npm install
npm run dev          # http://localhost:5173
```

Browser development goes through the same repository interface that Android satisfies with SQLite
(`src/storage/`), so a page behaves identically in both. The interface starts in the device's language
when it is one of the three shipped ones, and Settings switches language and theme immediately — no
reload, no restart. The default theme is `ragdoll`.

## npm scripts

| Script | What it does |
| --- | --- |
| `dev` | Vite dev server on http://localhost:5173 |
| `build` | `tsc -b` then a production Vite build |
| `preview` | Serve the production build locally |
| `test` | Unit tests: `node --test` over `src/**/*.test.ts` |
| `test:browser` | Headless Chrome drives the real app at a phone and a desktop viewport |
| `typecheck` | `tsc -b` only |
| `lint` | ESLint over the whole tree |
| `verify` | lint + typecheck + test + build — run this before opening a pull request |
| `cap:sync` / `cap:copy` | Copy web assets and plugins into the Android project |
| `android:apk` | build + `cap sync` + `gradlew assembleDebug` |

## Building the Android APK

```bash
npm run android:apk    # build the web assets, sync Capacitor, assemble a debug APK
```

The three steps separately, if you prefer to run them yourself:

```bash
npm run build                              # type-check + build the web assets
npm run cap:sync                           # copy assets and plugins into the Android project
cd android && gradlew.bat assembleDebug    # assemble the debug APK
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`.

Install it on a device or emulator with:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Requirements: JDK 17+ (21 verified) and the Android SDK with **platform 35** and build-tools.
Gradle is provided by the wrapper; it downloads its distribution on first run.

## Verify

```bash
npm run verify         # lint + typecheck + test + production build
npm run test           # 320 unit tests in 63 suites (node --test)
npm run test:browser   # headless Chrome drives the real app at a phone and a desktop viewport
```

The browser suite runs 165 checks at the phone viewport and 166 at the desktop one, and asserts at each
width that exactly one navigation is shown and that nothing overflows.

## House rules

1. **No user-visible string in a component.** Every label lives in `src/i18n/en.ts` and its two
   translations; `src/test/i18n.test.ts` fails the build if a catalogue is incomplete or a phrase was
   copied from English.
2. **Never lose user data.** Schema changes are additive, migrations fill defaults, and a file written
   by an older version still imports. The frozen identifiers listed in the README exist for that
   reason — do not rename them.

## Where to read next

| Document | What is in it |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`中文`](ARCHITECTURE.zh-CN.md) | Why the code is shaped the way it is: the storage contract, the migration rules, the theme and i18n architecture, the vision rules, the test harness. |
| [`../design/README.md`](../design/README.md) | The artwork sources and the scripts that generate the icons and splash screens. |
| [`../CHANGELOG.md`](../CHANGELOG.md) | What changed in each release. |

---

## 中文

本文件里的内容都面向想**构建、运行或修改代码**的人。只想装应用的话，看 [README](../README.zh-CN.md)。

### 在浏览器里运行

Web 版不是一个独立产品 —— 它跑的是 APK 里的同一份代码，只是把 SQLite 换成了 IndexedDB。看改动效果它最快。

```bash
npm install
npm run dev          # http://localhost:5173
```

浏览器开发走的是 Android 上由 SQLite 实现的那同一套仓储接口（`src/storage/`），所以同一个页面在两端行为一致。如果设备语言属于已内置的三种之一，界面会直接以该语言启动；在设置里切换语言和主题立即生效，无需刷新，也不用重启。默认主题是 `ragdoll`。

### npm 脚本

| 脚本 | 作用 |
| --- | --- |
| `dev` | Vite 开发服务器，http://localhost:5173 |
| `build` | 先 `tsc -b`，再做生产构建 |
| `preview` | 在本地预览生产构建产物 |
| `test` | 单元测试：`node --test` 跑 `src/**/*.test.ts` |
| `test:browser` | 无头 Chrome 在手机和桌面两种视口下驱动真实应用 |
| `typecheck` | 只跑 `tsc -b` |
| `lint` | 对整棵树跑 ESLint |
| `verify` | lint + typecheck + test + build —— 提交 pull request 前先跑这个 |
| `cap:sync` / `cap:copy` | 把 Web 资源和插件复制进 Android 工程 |
| `android:apk` | build + `cap sync` + `gradlew assembleDebug` |

### 构建 Android APK

```bash
npm run android:apk    # 构建 Web 资源、同步 Capacitor、打包 debug APK
```

如果想自己一步步来，这三步可以拆开：

```bash
npm run build                              # 类型检查 + 构建 Web 资源
npm run cap:sync                           # 把资源和插件复制进 Android 工程
cd android && gradlew.bat assembleDebug    # 打包 debug APK
```

APK 输出在 `android/app/build/outputs/apk/debug/app-debug.apk`。

安装到设备或模拟器：

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

环境要求：JDK 17+（已在 21 上验证），以及带 **platform 35** 和 build-tools 的 Android SDK。Gradle 由 wrapper 提供，首次运行时会自行下载。

### 验证

```bash
npm run verify         # lint + typecheck + test + 生产构建
npm run test           # 320 个单元测试，63 个测试套件（node --test）
npm run test:browser   # 无头 Chrome 在手机和桌面两种视口下驱动真实应用
```

浏览器用例在手机视口下执行 165 项检查，在桌面视口下执行 166 项，并在每种宽度下断言只显示一个导航、没有任何横向溢出。

### 项目规矩

1. **组件里不出现面向用户的字符串。** 每条文案都在 `src/i18n/en.ts` 和它的两份翻译里；目录不完整，或者某句话是从英文照抄过来的，`src/test/i18n.test.ts` 都会让构建失败。
2. **绝不丢用户数据。** 结构变更只做增量，迁移会补上默认值，旧版本写出的文件仍然能导入。README 里列出的那些冻结标识就是为此存在的——不要改它们的名字。

### 接下来读什么

| 文档 | 内容 |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`中文`](ARCHITECTURE.zh-CN.md) | 代码为什么长成这样：存储契约、迁移规则、主题与 i18n 架构、视觉能力规则、测试装置。 |
| [`../design/README.md`](../design/README.md) | 美术素材的来源，以及生成图标和启动画面的脚本。 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 每个版本的改动。 |
