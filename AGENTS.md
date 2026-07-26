<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:project-conventions -->
# Project conventions

- **Asset policy**: third-party assets live in `public/assets/` and must be CC0 / CC-BY (never NC/ND/SA). Acquire models with `scripts/fetchassets.mjs`, which keeps `public/assets/manifest.json` and `public/assets/ATTRIBUTION.md` in sync — update both when adding or removing assets.
- **Allocation-free loop**: no `new` in per-frame engine paths (`Engine.loop`, `Enemy.update`, `Weapons.update`) — reuse the scratch vectors (`vA`, `vB`, `vCamDir`, …). GC pauses read as stutter.
- **Relative asset URLs**: runtime code loads assets as `./assets/...` (never `/assets/...`) so the `CG_EXPORT=1` static bundle works from a CDN subfolder.
<!-- END:project-conventions -->
