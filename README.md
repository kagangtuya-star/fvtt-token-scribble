# TokenScribble · 随绘棋子

Draw on tokens, right on the map. Create a blank token under your mouse and
sketch it in seconds, or doodle on any existing token without touching its
image. For Foundry VTT **v13 and v14**.

在地图上直接给棋子作画：按一下键就在鼠标处生成一枚透明棋子并开始绘画，也可以在任何已有棋子上涂鸦，原图不受影响。支持 Foundry VTT **v13 与 v14**。

> Status: 1.0.0, not yet verified inside a running Foundry instance — see
> [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

---

## 中文说明

### 快速上手

| 操作 | 方式 |
| --- | --- |
| 在鼠标处新建随绘棋子并开始绘画 | `N`（可在“配置控制键”中修改） |
| 点击地图放置随绘棋子 | 左侧“棋子”控件中的钢笔按钮；按住 `Shift` 不吸附网格，`Esc` 取消 |
| 在已有棋子上绘画 | 棋子 HUD 左栏的钢笔按钮，或选中/悬停棋子后按 `B` |
| 替换模式：重绘棋子图片 | 棋子 HUD 左栏的图片按钮，或 `Shift+B` |
| 替换模式：重绘角色肖像 | 角色目录右键菜单“重绘肖像”，或角色卡标题栏按钮 |
| 完成 | 工具栏“完成”、`Enter` 或 `Esc`（修改会自动保存） |

绘画时：左键/笔/单指画画，**右键拖动平移地图、滚轮缩放**，笔画不会拖动或选中棋子，地图快捷键（删除、方向键、复制粘贴等）不会作用到棋子上。

**出框绘制**：笔画可以画到棋子图片边框之外（每边最多一个纸面长边的距离），完成后照样显示在棋子周围，并随棋子移动、旋转、缩放。启用了动态棋子环（Dynamic Ring）的棋子会裁切到边框内。

### 替换模式（兼容其他模组）

原位绘画不修改图片本身；如果其他模组需要读取“真正的图片”（例如某些特效、肖像或导出类模组），可以使用替换模式：

- 在弹出的独立绘图窗口中绘画（滚轮缩放、右键拖动平移；橡皮在这里也会擦掉原图像素），点击“替换图片”后，结果保存为新的 PNG，并直接替换棋子的 `texture.src` 或角色的肖像 `img`。可选“同时用于角色的原型棋子”。
- 第一次替换前，原图会被**原样备份**到当前世界目录 `worlds/<世界 id>/token-scribble/backups/`；生成的图片存放在同目录的 `tokens/` 或 `portraits/` 中。备份失败时不会做任何修改。
- 随时可以“还原原图”：窗口中的按钮、棋子 HUD 图片按钮的右键、角色目录右键菜单。原文件仍存在时恢复原路径，否则使用备份。
- 棋子上已有的原位涂鸦会一并载入并合并进图片；还原时涂鸦也会回来。
- 需要 Foundry 的“上传新文件”和“使用文件浏览器”权限（GM 默认拥有）；视频图片、无法跨域读取的外部图片不支持。

### 工具

- **钢笔**（带压感）、**马克笔**（等宽半透明）、**毛笔**（粗细多变、收尖）、**填充**（画一个闭合圈即填色）、**橡皮**（只擦涂鸦，不碰原图）。
- 10 色调色板 + 最近使用的颜色 + 自定义取色；对数刻度的粗细滑块，预览点按当前缩放显示真实大小。
- 再次点击当前工具：调整不透明度、压感强度。
- 镜像绘画（`V`）、按住 `Shift` 画直线、聚焦放大到棋子（`F`）。
- 撤销 / 重做（`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`），可撤销到以前会话画的笔画；清空也可撤销。
- 数位笔：真实压感、笔尾橡皮自动切换、防误触；鼠标：根据运笔速度平滑模拟压感（慢画更粗）。
- “更多”菜单：复制/粘贴涂鸦（可跨棋子）、导出 PNG（仅涂鸦或整枚棋子）、导出 SVG、隐藏/显示涂鸦层、设为角色默认棋子涂鸦、清空、放弃本次修改、快捷键说明。

### 保存与多人协作

- 涂鸦以**矢量数据**保存在棋子的 `flags.token-scribble.drawing` 中（带版本号、紧凑编码），并渲染进棋子自身的纹理：移动、旋转、缩放、翻转、隐藏、视野、遮挡都与棋子一致。
- 停笔约 1 秒自动保存（持续绘画时至少每 5 秒一次），绝不按每次鼠标移动写入。
- 多人同时编辑同一枚棋子时，双方笔画自动合并，撤销也会被正确同步；工具栏显示正在编辑的其他用户。
- 断网或服务器无响应时显示“离线”，笔画保留在本地并自动重试；浏览器崩溃后再次打开会提示恢复未保存的笔画。
- 权限完全遵循 Foundry：只有能修改该棋子的用户才能绘画，保存前会再次检查。

### 设置

| 设置 | 范围 | 说明 |
| --- | --- | --- |
| 每枚棋子的存储上限（KB） | 世界 | 默认 384 KB |
| 新随绘棋子的尺寸 | 世界 | ½ ～ 4 格 |
| GM：新建随绘棋子默认隐藏 | 世界 | 画完再给玩家看 |
| 压感 | 客户端 | 自动 / 总是模拟 / 关闭 |
| 开始绘画时自动放大小棋子 | 客户端 | 结束后回到原视角 |

### 已知限制

- 尚未在真实的 Foundry v13/v14 实例中完成端到端测试（见下方“开发”）。
- 停用模组后，由本模组新建的棋子会显示为透明（涂鸦只存在于数据中）；在已有棋子上画的涂鸦会消失，原图不受影响。
- 视频棋子在可见时每帧重新合成。
- 其他同样替换棋子纹理的模组可能与本模组冲突（可改用替换模式）。
- 出框部分不参与点击判定（点击出框笔画不会选中棋子）；棋子边框刚好移出屏幕时，出框部分可能随之被裁剪不显示。
- 替换模式生成的旧图片不会被自动删除（Foundry 没有客户端删除文件的接口），需要时可在世界目录中手动清理。

---

## English

### Getting started

| Action | How |
| --- | --- |
| Create a scribble token at the mouse and draw | `N` (rebindable in *Configure Controls*) |
| Click to place a scribble token | pen button in the **Token** scene controls; `Shift` = no grid snapping, `Esc` = cancel |
| Draw on an existing token | pen button in the Token HUD (left column), or `B` with a token selected/hovered |
| Finish | **Done**, `Enter` or `Esc` (changes are saved automatically) |

While drawing, left button / pen / one finger draws; **right-drag pans and the
wheel zooms** as usual. Strokes never drag or select tokens and map shortcuts
(delete, arrows, copy/paste…) do not act on the token.

**Out-of-frame drawing:** strokes may go past the edge of the token image (up
to one paper long side on each side) and stay visible around the token,
following its movement, rotation and scale. Tokens with a dynamic ring are
clipped to their frame.

### Replace mode (for compatibility with other modules)

In-place drawing never touches the image file. When other modules need a real
image, use replace mode (Token HUD image button or `Shift+B`; for portraits the
Actors directory context menu or the actor sheet header):

- Draw in a separate window (wheel zooms, right-drag pans; here the eraser also
  erases the original image). **Replace image** saves the result as a new PNG
  and points the token's `texture.src` or the actor's `img` at it, optionally
  also the actor's prototype token.
- Before the first replacement the original is **backed up byte for byte** into
  `worlds/<world id>/token-scribble/backups/`; generated images go to `tokens/`
  or `portraits/` next to it. If the backup fails, nothing is changed.
- **Restore original** (window button, right-click on the HUD image button,
  Actors directory entry) puts the original path back, or the backup if the
  original file is gone. An in-place drawing that was baked in comes back too.
- Requires the core "Upload New Files" and "Use File Browser" permissions.
  Video images and remote images without CORS are not supported.

### Tools

Pen (pressure), marker, brush (tapered), lasso fill, eraser (drawing only).
Palette, recent colours, custom colour, size slider with a true-to-scale
preview, opacity and pressure response (click the active tool), mirror (`V`),
straight lines (`Shift`), zoom to token (`F`), undo/redo (also across sessions),
undoable clear. Stylus pressure, pen eraser and palm rejection are supported;
mouse pressure is simulated smoothly from drawing speed. The **⋯** menu offers
copy/paste between tokens, PNG export (drawing or whole token), SVG export,
hide/show the drawing, apply to the actor's prototype token, clear, discard
this session's changes and the shortcut list.

### Storage, sync and permissions

- Drawings are stored as versioned vector data in `flags.token-scribble.drawing`
  and composited into the token's own texture, so they follow movement,
  rotation, scaling, mirroring, visibility, vision and occlusion.
- Autosave after ~1 s idle (at least every 5 s while drawing), never per pointer
  move. Concurrent edits from several users are merged (including undo); other
  editors are shown in the toolbar. Offline/permission/size-limit states are
  shown and unsaved strokes are kept locally (and offered again after a crash).
- Only users who may update the token document can draw; the check is repeated
  before every save and enforced by the server. There is no GM relay.
- Out-of-frame ink is not part of the token's hit area, and may be culled
  together with the token when its frame is just off-screen. Old images made in
  replace mode are not deleted automatically (Foundry has no client-side file
  deletion); clean up `worlds/<id>/token-scribble/` by hand if needed.

### API

```js
const api = game.modules.get("token-scribble").api;
await api.edit(token);            // Token or TokenDocument
await api.create({ x, y });       // canvas coordinates; defaults to the mouse
await api.finish();
api.canEdit(tokenDocument);       // native permission check
api.read(tokenDocument);          // { ok, state } decoded drawing
await api.replace(token);         // replace mode for a token image…
await api.replace(actor);         // …or an actor portrait
await api.restore(tokenOrActor);  // put the original image back
Hooks.on("token-scribble.ready", (api) => { /* … */ });
```

---

## Installation

Install from a release manifest URL once releases are published:

```
https://github.com/<owner>/<repo>/releases/latest/download/module.json
```

`<owner>/<repo>` is the GitHub repository this project is pushed to. The
release workflow fills in `url`, `manifest` and `download` automatically from
the repository and tag, so no URL is hard-coded in the sources.

## Development

```bash
npm install
npm test
npm run build      # → dist/ (link it as Data/modules/token-scribble)
npm run package    # → release/module.zip + release/module.json
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the architecture, the stored
data format, the browser harness and the manual test plan inside Foundry.

### Releasing

1. Bump `version` in both `package.json` and `module.json` and update
   `CHANGELOG.md`.
2. Push to GitHub and publish a release with tag `vX.Y.Z`.
3. `.github/workflows/release.yml` builds, injects the URLs for that repository
   and tag, and attaches `module.json` and `module.zip` to the release. The tag
   must match the version or the workflow fails.

## License

MIT — see [LICENSE](LICENSE). Bundles perfect-freehand (MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
