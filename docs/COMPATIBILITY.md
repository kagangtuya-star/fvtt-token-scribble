# Compatibility

TokenScribble declares `compatibility.minimum = "13"` and `maximum = "14"` and
deliberately leaves `verified` unset until the module has been exercised in a
running Foundry instance of each generation.

| Generation | Status | Basis |
| --- | --- | --- |
| v13 (build 351) | API usage checked against the core client source | Hook signatures, `PrimarySpriteMesh` texture handling, `Token` render flags, Token HUD markup and the v13 scene-control record format were read from the v13 client code. |
| v14 | API usage checked against `@league-of-foundry-developers/foundry-vtt-types` 14.370 | Only APIs that exist with the same shape in both generations are used. |
| v12 and older | Not supported | Scene controls changed shape in v13 (records instead of arrays); the module refuses to run its editor there and warns once. |

**Not yet done:** an end-to-end run inside Foundry v13 / v14 (see
[DEVELOPMENT.md](DEVELOPMENT.md#manual-test-plan-inside-foundry)).

## Public APIs relied upon

All Foundry access goes through `src/foundry/`. Version differences are isolated
in `src/foundry/compat.ts`.

**Hooks**

| Hook | Use |
| --- | --- |
| `init`, `ready` | settings, keybindings, HUD/control registration, socket, API |
| `drawToken`, `refreshToken`, `destroyToken` | composite the drawing into the token texture; re-adopt the texture if core replaced it (ring, texture change); release GPU resources |
| `updateToken` (painter) | re-render idle tokens when another user changes the module's flags (core does not redraw a token for flag-only changes) |
| `canvasTearDown` | release everything on scene change; end sessions without camera animation |
| `updateToken`, `deleteToken`, `updateActor`, `updateScene`, `updateUser` | sync incoming drawing changes; stop on deletion or lost permission |
| `renderTokenHUD` (v13: `HTMLElement`) | add the "draw" button to `.col.left` |
| `getSceneControlButtons` (v13+: `controls.tokens.tools` record) | add a `button: true` tool with `onChange` |
| `canvasPan`, `userConnected` | brush-size preview scale; presence clean-up |
| `getActorContextOptions` | replace mode: "Redraw portrait" / "Restore original portrait" in the Actors directory. Entries use `name`/`condition`/`callback` on v13 and `label`/`visible`/`onClick` on v14 (the v13 keys are deprecated there) |
| `getHeaderControlsActorSheetV2`, `getActorSheetHeaderButtons` | replace mode: a header control on ApplicationV2 actor sheets (`{icon, label, action, onClick}`) and a header button on legacy ApplicationV1 sheets |

**Documents and permissions**

- `TokenDocument#update({"flags.token-scribble.drawing": …})` is the only write
  path for token drawings. `TokenDocument#canUserModify(user, "update", data)`
  is checked before each write; the server enforces it again. There is no GM
  relay.
- `Actor#update({"prototypeToken.flags…"})` for "use as default drawing".
- Replace mode (explicit user action only) writes `TokenDocument` `texture.src`,
  `Actor` `img`, optionally `prototypeToken.texture.src`, plus
  `flags.token-scribble.replaced` (the backup record), through the same
  `update` path and permission checks.
- `Scene#createEmbeddedDocuments("Token", …)` for new scribble tokens; creation
  permission is probed with `new CONFIG.Token.documentClass(data, {parent}).canUserModify(user, "create")`
  and `User#can("TOKEN_CREATE")`.

**Canvas**

- `Token#mesh` (`PrimarySpriteMesh`): the module assigns a view of a
  `RenderTexture` containing *original texture + drawing* to `mesh.texture`.
  In-place drawing never changes the document's `texture.src`, so disabling
  the module restores the original look (except tokens created by the module,
  which use a transparent image).
- Out-of-frame ink: that view is a `PIXI.Texture(baseTexture, frame, orig, trim)`
  whose `orig` is the original frame and whose `trim` covers frame ∪ ink.
  `PrimarySpriteMesh#resize` and token sizing read `orig` (unchanged), while
  `SpriteMesh#calculateVertices` places the quad from `trim`, so ink beyond the
  image edge is drawn around it (checked in the v13 `SpriteMesh` /
  `PrimarySpriteMesh` source). With a dynamic token ring active
  (`Token#hasDynamicRing`) the composite is clipped to the frame, because the
  ring shader maps its UVs onto the whole quad.
- `mesh.canvasTransform`, `mesh.updateCanvasTransform()`, `mesh.anchor`: map
  pointer positions to texture space, so rotation, scale, mirroring and anchor
  offsets are respected.
- `Token#renderFlags.set({refreshSize: true})` when the composite size differs.
- `canvas.canvasCoordinatesFromClient`, `canvas.clientCoordinatesFromCanvas`,
  `canvas.animatePan`, `canvas.dimensions.scale`, `canvas.grid.getSnappedPoint`,
  `canvas.app.renderer`, `canvas.app.ticker`, `canvas.controls`.

**Files (replace mode only)**

- `CONFIG.ux.FilePicker` (falls back to `foundry.applications.apps.FilePicker.implementation`):
  static `browse`, `createDirectory` and `upload(source, path, file, body, {notify})`
  on the `data` storage, into `worlds/<world id>/token-scribble/{tokens,portraits,backups}`.
  Offered only to users with the core `FILES_UPLOAD` and `FILES_BROWSE`
  permissions; the server enforces them.
- `fetch` (GET to copy the original for the backup, HEAD to see whether the
  original still exists on restore).

**UI**

- `foundry.applications.api.ApplicationV2` for the replace-mode window
  (`DEFAULT_OPTIONS`, `_renderHTML`, `_replaceHTML`, `_onClose`, `close`,
  `render({force})`, `bringToFront`), created lazily after Foundry has loaded.
- `foundry.applications.api.DialogV2.confirm` (falls back to `window.confirm`),
  `ui.notifications`, `data-tooltip-html` / `data-tooltip-text` tooltips,
  `game.keybindings.register`, `game.settings.register`, `game.socket`
  (`module.token-scribble`, requires `"socket": true`).

No private (`#`) or underscore-prefixed members are used.

## Known risks

- **Texture ownership.** Core may replace `mesh.texture` (token rings, texture
  transitions, video). The painter re-adopts the new texture on the next
  `refreshToken`; a brief flash without the drawing is possible during
  transitions.
- **Video tokens** recomposite every frame while visible.
- **Other modules that also replace `mesh.texture`** (e.g. some token-effects
  modules) can conflict; whichever runs last wins until the next refresh.
- **Uninstalling** the module leaves tokens created by it transparent (their
  drawing lives only in flags). Images made in replace mode are ordinary files
  and stay.
- **Out-of-frame ink** is not part of the token's hit area or canvas bounds
  (core computes both from `orig` / its alpha map within the frame): clicking
  the overflow does not select the token, and when the token's frame is scrolled
  just off-screen, culling may hide its overflow too. Ink reaches at most one
  paper long side beyond the frame on each side; further out it is clipped.
- **Replace mode** needs the original image to be readable by the browser
  (same origin or CORS); otherwise no backup can be made and nothing is
  changed. Foundry has no client API to delete files, so earlier generated
  images stay in `worlds/<id>/token-scribble/` until removed by hand. Only the
  `data` storage is used (S3 and hosting-specific storages are untested).
