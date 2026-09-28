# design

Source artwork and the scripts that turn it into app assets.
图标与美术资源的源文件，以及把它们生成应用资源的脚本。

Nothing here ships directly: every file is either a source the app reads at runtime
(`../src/theme/`) or an input to a generator. The generated Android assets live in
`../android/app/src/main/res/`.
这里的文件不会直接打包：要么是运行时读取的源（`../src/theme/`），要么是生成器的输入。
生成出来的 Android 资源在 `../android/app/src/main/res/`。

| Path | What it is / 说明 |
| --- | --- |
| `icon-candidates/source/cat-sketch.jpg` | The original hand-drawn ragdoll cat, supplied by the project owner. The single source for the launcher icon and the splash screens. 手绘布偶猫原稿，图标与启动图的唯一来源。 |
| `icon-candidates/source/cat-crop.png` | The 350×350 crop with the paper colour sampled and the midtones deepened; generated, committed because every density is rendered from it. 裁切并压深中间调后的 350×350 图；由脚本生成，但各密度都由它渲染，所以一并提交。 |
| `icon-candidates/render-android-icons.ps1` | Crops, adjusts and composites every launcher and adaptive-icon density. 裁切、调色并合成全部启动图标密度。 |
| `icon-candidates/render-splashes.mjs` | Renders the splash screens for every density and orientation. 生成全部尺寸与方向的启动图。 |
| `icon-candidates/preview-icons.mjs` | Draws the icon under the three launcher mask shapes, so a crop can be judged before it ships. 把图标放在三种启动器遮罩下渲染，发布前就能看出裁切是否合适。 |
| `icon-candidates/alternates/` | A vector cat drawn in the same family as the pixel mascots. Superseded by the sketch; kept for reference. 与像素吉祥物同族的矢量猫，已被手绘稿取代，留作参考。 |
| `icon-candidates/uc-monogram/` | The earlier letterform concepts (a muscle arm built from the letters U and C). Not used. 更早的字母造型方案（用 U 和 C 组成肌肉手臂），未采用。 |
| `theme-art/preview.mjs` | Renders every mascot, motif and composed scene to `preview.png` for review. 把全部吉祥物、图案和合成场景渲染成 `preview.png` 便于检查。 |
| `theme-art/shot.mjs` | A small CDP driver for screenshotting screens that need state first (enable AI, seed a plan). 小型 CDP 驱动，用于给需要先造状态的界面截图。 |

Regenerate everything:
重新生成全部资源：

```bash
pwsh -File design/icon-candidates/render-android-icons.ps1
node design/icon-candidates/render-splashes.mjs
node design/icon-candidates/preview-icons.mjs
node --experimental-transform-types --import ./scripts/register-ts.mjs design/theme-art/preview.mjs
```
