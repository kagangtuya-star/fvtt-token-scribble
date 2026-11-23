# AGENTS.md — TokenScribble (随绘棋子)

Foundry VTT v13/v14 module (`id: token-scribble`). TypeScript sources are
compiled by Node's built-in type stripping; there is no bundler.

## Commands

- `npm test` — unit/simulation tests (`node --test "tests/*.test.ts"`), works without node_modules.
- `npm run lint:i18n` — language key consistency (no dependencies needed).
- `npm run build` / `npm run package` / `npm run validate` — need `perfect-freehand` installed.
- `npm run typecheck` / `npm run format` — need dev dependencies.

## Rules for this repo

- Keep TypeScript erasable: no `enum`, `namespace`, parameter properties; use
  `import type`; import local files with the `.ts` extension.
- Only `src/engine/freehand.ts` imports `perfect-freehand`.
- Only `src/foundry/**` and `src/main.ts` may touch Foundry globals; keep
  `model/`, `engine/`, `editor/`, `ui/` testable in plain Node/browser.
- Drawing writes go exclusively through `TokenDocument#update` (see
  `src/foundry/store.ts`); never add a GM relay.
- Replace mode is the only code that changes image paths or uploads files:
  uploads go through Foundry's FilePicker (`src/foundry/files.ts`) into
  `worlds/<id>/token-scribble/`, and the original is backed up before any
  document changes (`src/foundry/replace.ts`).
- Brush preset values that affect rendering are part of the stored format v1.
- Every user-visible string goes into both `lang/en.json` and `lang/zh-CN.json`.
- See `docs/DEVELOPMENT.md` for architecture and the manual Foundry test plan.
