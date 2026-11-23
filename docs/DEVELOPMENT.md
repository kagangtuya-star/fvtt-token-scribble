# Development

## Requirements

- Node.js ≥ 22.18 (Node 24 recommended; the build uses Node's built-in
  TypeScript type stripping, no bundler).
- `npm install` once to get `perfect-freehand` (runtime) and the dev tools
  (`typescript`, `prettier`, `@types/node`).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Strip types from `src/**/*.ts` 1:1 into `dist/scripts/`, vendor perfect-freehand (with its LICENSE), copy lang/styles/assets/docs, write `dist/module.json`. |
| `npm run watch` | Rebuild on change. |
| `npm test` | Unit and simulation tests (`node --test`), no dependencies needed. |
| `npm run typecheck` | `tsc --noEmit` over src, tests and dev. |
| `npm run lint:i18n` | Language files have identical keys/placeholders; every key is used. |
| `npm run validate` | Validate `dist/module.json` and the files it references. |
| `npm run package` | Build and write `release/module.zip` + `release/module.json`. |
| `npm run harness` | Build the browser harness into `dist-dev/`. |
| `npm run format` / `format:check` | Prettier. |

The source must stay *erasable* TypeScript (no `enum`, `namespace`, parameter
properties) and import with explicit `.ts` extensions — `tsconfig.json`
enforces this with `erasableSyntaxOnly`.

## Running inside Foundry

1. `npm run build` (or `npm run watch`).
2. Link `dist/` into your user data folder as `Data/modules/token-scribble`,
   e.g. `ln -s "$PWD/dist" ~/.local/share/FoundryVTT/Data/modules/token-scribble`
   (Windows: `mklink /D`).
3. Enable the module in a world (v13 or v14).

## Browser harness

`npm run harness`, then serve `dist-dev/` with any static server, e.g.
`python3 -m http.server -d dist-dev 8080`. It wires the real editor, toolbar,
input controller and serializer to a fake map (wheel = zoom, right-drag = pan,
`B` = edit after finishing). Query parameters: `lang=zh-CN`, `theme=light`,
`pressure=simulate|off`, `edit=0`.

`dist-dev/replace.html` opens the real replace-mode window on a fake token and
actor, with a small stand-in for ApplicationV2, DialogV2, FilePicker (an
in-memory "server") and settings, so drawing, erasing the image, apply and
restore can be checked end to end. Query parameters: `lang=zh-CN`,
`theme=light`, `overlay=1` (token starts with an in-place drawing to bake in),
`files=0` (user without upload permission), `open=0`.

## Architecture

```
src/
  model/    pure data: types, codec (delta/varint/base64), serialization +
            validation, three-way merge, undo/redo document, paper↔texture fit,
            drawing extent (out-of-frame ink), replace-mode record/paths/sizing
  engine/   brushes, pressure model, stroke recorder (input-time streamline +
            simplification), geometry (resampling, outline → path), raster
            (Canvas2D, eraser via destination-out), SVG export; the only
            perfect-freehand import is engine/freehand.ts
  editor/   ScribbleEditor (tools, strokes, budget), InputController (capture
            phase input routing), keymap, SyncEngine (debounced optimistic
            saves, merge, tombstones, retries), tool state
  ui/       dock toolbar, popovers, brush cursor (plain DOM)
  foundry/  everything that touches Foundry: settings, store (flags +
            permission), painter (texture compositing), surface (coordinates),
            session (lifecycle), create (new tokens), presence (socket),
            drafts (localStorage), compat, integration (HUD/controls/keys/
            actor directory/sheets), files (FilePicker), replace (backup,
            upload, document updates, restore), replace-window (ApplicationV2
            editor window)
  main.ts   hooks + public API (`game.modules.get("token-scribble").api`)
```

Data flow while editing: pointer → `InputController` → `ScribbleEditor`
(recorder → live raster) → on stroke end the op is committed to the
`ScribbleDocument` → `SyncEngine.touch()` debounces a save → `TokenDocument#update`
→ every client's `updateToken` hook → painter re-renders from the decoded flag;
an editing client merges via `SyncEngine.receive()`.

### Stored format (v1)

`flags.token-scribble.drawing`:

```jsonc
{
  "v": 1,              // format version (newer versions are refused, not guessed)
  "w": 1000, "h": 1000, // paper size; long side 1000, aspect of the token image
  "ops": [
    { "k": "s", "id": "…", "t": "pen", "c": "#1f1b18", "a": 85, "z": 90, "m": 1,
      "x": { "th": 0.6 }, "p": "<base64 delta/varint points>" },
    { "k": "c", "id": "…" }          // clear marker
  ],
  "rev": "…", "par": "…", "seq": 3, "by": "<userId>", "at": 1700000000000,
  "del": ["…"]                       // recent tombstones (optional)
}
```

Points are quantised to 0.1 paper units and 64 pressure levels. Brush preset
values that affect rendering are part of format v1 and must not change.
Points may lie outside `0..w × 0..h` (out-of-frame ink); renderers cover the
union of the paper and the ink, up to one long side beyond each edge.

`flags.token-scribble.replaced` (on a TokenDocument, an Actor for its portrait,
or a prototype token) records a replace-mode change:

```jsonc
{
  "v": 1, "kind": "token" | "portrait",
  "original": "tokens/goblin.webp",                                  // path before the first replacement
  "backup": "worlds/<id>/token-scribble/backups/goblin-<doc>-<t>.webp", // byte copy of it
  "current": "worlds/<id>/token-scribble/tokens/goblin-<doc>-<t>.png",  // generated image in use
  "drawing": { … },   // in-place drawing that was baked in (restored with the image)
  "proto": true,      // the prototype token was updated too
  "at": 1700000000000, "by": "<userId>"
}
```

The record only counts while the document still shows `current`; if the image
was changed by hand since, the next replacement takes a fresh backup.

## Manual test plan inside Foundry

Automated tests cannot cover the real canvas. Before tagging a release, run
through this list in v13 **and** v14, with one GM and one player client:

1. Create: `N` over the map creates a transparent token under the cursor and
   starts drawing; the token control button places on click; `Shift` disables
   snapping; `Esc` cancels.
2. Edit: Token HUD pen button and `B` start editing; the original image stays.
3. Input: strokes never move/select tokens; right-drag pans, wheel zooms;
   `Delete`, arrows, `Ctrl+C/V` do nothing to the token while editing.
4. Tools: every tool, size/opacity/pressure, mirror, `Shift` lines, undo/redo,
   clear + undo, eraser leaves the token image intact.
5. Pressure: with a stylus (real pressure, eraser end) and with a mouse.
6. Transform: move, rotate, resize, mirror X/Y, change texture scale/fit, token
   ring on/off, hidden token, vision-restricted player view, occlusion by tiles.
7. Sync: draw on the same token from two clients simultaneously; undo on one
   while drawing on the other; disconnect the network briefly (status shows
   offline, recovers); reload during drawing (draft is offered).
8. Permissions: a player without ownership cannot see the HUD button or start
   editing; revoke ownership mid-session (session stops, nothing is lost
   locally).
9. Scene switch / token deletion / module disabled while editing.
10. Performance: 50+ drawn tokens on a scene, pan/zoom stays smooth.
11. Out-of-frame: draw past the token edge on all four sides (also mirrored);
    the ink stays visible after finishing, on the other client, after a reload,
    while moving/rotating/scaling the token; with a dynamic ring it is clipped;
    PNG "whole token" export includes it.
12. Replace mode (as GM and as a player with and without the upload
    permissions): Token HUD image button / `Shift+B`, actor directory context
    menu, actor sheet header (an AppV2 sheet and, if available, an AppV1 system
    sheet). Apply creates `worlds/<id>/token-scribble/backups/…` (identical to
    the original) and `…/tokens/…` or `…/portraits/…`; the token/portrait shows
    the new image on every client; "prototype" updates the actor's default
    token; restore (window button, HUD right-click, directory entry) brings
    back the original, or the backup if the original file was deleted; an
    in-place drawing is baked in on apply and comes back on restore; video and
    cross-origin images are refused without changes.
