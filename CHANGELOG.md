# Changelog

All notable changes to TokenScribble are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] — unreleased

### Added

- Create a transparent scribble token at the mouse (`N`, or the pen tool in the
  Token controls) and start drawing immediately; click-to-place mode with grid
  snapping (hold `Shift` to place freely).
- Draw on any existing token from the Token HUD or with `B`; the token's own
  image is never modified.
- Tools: pen (pressure), marker, brush (tapered), lasso fill, eraser (erases the
  drawing only). Ten-colour palette, recent colours, custom colour picker,
  logarithmic size slider, opacity and pressure-response controls, mirror mode,
  straight lines with `Shift`.
- Real stylus pressure, pen-eraser support, palm rejection; natural simulated
  pressure for mice derived from drawing speed.
- Undo/redo per stroke (also across sessions), clear (undoable), discard this
  session's changes.
- Drawing in place on the map: strokes never drag, select or pan tokens;
  right-drag and wheel still pan and zoom; optional smooth zoom to small tokens.
- Vector storage in `flags.token-scribble.drawing` (versioned, compact
  delta/varint encoding, configurable size limit), rendered into the token's
  own texture so it follows movement, rotation, scaling, mirroring, visibility,
  occlusion and token rings.
- Multi-user editing: debounced autosave, three-way merge of concurrent edits
  with tombstones, presence indicators, offline/permission/limit states,
  crash-safe local drafts.
- Copy/paste drawings between tokens, export PNG (drawing or full token) and
  SVG, hide/show the drawing layer, apply a drawing to the actor's prototype
  token.
- Out-of-frame drawing: ink may extend beyond the token image (up to one paper
  long side per edge) and is rendered around the token in place, in exports
  and on every client; clipped for tokens with a dynamic ring.
- Replace mode: a separate drawing window that bakes the result into a new PNG
  and replaces the token image or the actor portrait (optionally the prototype
  token too), for modules that need a real image. The original is backed up
  into `worlds/<id>/token-scribble/backups/` first and can be restored from the
  window, the Token HUD (right-click) or the Actors directory. Entry points:
  Token HUD, `Shift+B`, Actors directory context menu, actor sheet header, API
  `replace()` / `restore()`.
- Idle clients re-render a token when another user changes its drawing flags
  (core does not redraw tokens for flag-only updates).
- English and Simplified Chinese.
