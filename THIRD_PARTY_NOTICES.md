# Third-party notices

TokenScribble ships the following third-party code inside `module.zip`.

## perfect-freehand 1.2.3

- Source: https://github.com/steveruizok/perfect-freehand
- License: MIT — Copyright (c) 2021 Stephen Ruiz Ltd
- Location in the package: `scripts/vendor/perfect-freehand/` (unmodified ES module build).
  The build copies the package's own `LICENSE` file next to it and refuses to
  package the library without it.

## Not shipped

- **Foundry VTT** is proprietary software by Foundry Gaming LLC. TokenScribble
  only uses its public client API at runtime and contains none of its code.
- **League of Foundry Developers — FoundryVTT-Module-Template** (MIT,
  https://github.com/League-of-Foundry-Developers/FoundryVTT-Module-Template)
  was the starting point for the repository layout and release flow. Its
  v10-era manifest fields and workflow were replaced; no template code is
  included in the module package.
- Development tools (`typescript`, `prettier`, `@types/node`) are used at build
  time only.
