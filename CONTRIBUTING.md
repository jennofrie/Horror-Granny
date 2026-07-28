# Contributing to Horror Granny

Horror Granny is created and maintained by Profexor. Contributions should preserve the game’s survival-horror pacing, allocation-conscious frame loop, portable static export, and third-party asset compliance.

## Setup

```bash
git clone https://github.com/jennofrie/Horror-Granny.git
cd Horror-Granny
pnpm install --frozen-lockfile
pnpm dev
```

## Before a pull request

```bash
pnpm check
```

This runs ownership integrity, linting, and the production build.

Gameplay or rendering changes should also run the relevant scripts under `scripts/` and include reproducible screenshots or captures.

## Project rules

- Do not allocate objects inside the main per-frame engine paths.
- Keep runtime asset URLs relative so static portal builds work from a subdirectory.
- Preserve deterministic placement and record seeds for gameplay regressions.
- Keep third-party assets CC0, CC-BY, or otherwise explicitly approved.
- Update both `public/assets/manifest.json` and `public/assets/ATTRIBUTION.md` when assets change.
- Preserve all third-party license and attribution notices.
- Preserve the Profexor MIT copyright and Horror Granny™ project notice.

## Pull request evidence

Include:

- the player or engineering problem;
- implementation summary;
- commands and scripts run;
- before/after screenshots for visual changes;
- performance impact for engine, rendering, or asset changes;
- static-export impact;
- asset source and license changes;
- documentation updates.

Changes to the MIT license, project ownership, trademarks, branding checks, attribution policy, or brand assets require Profexor review.

---

Horror Granny™ and its original project identity are trademarks of Profexor. Copyright © 2026 Profexor. The project code is licensed under the [MIT License](LICENSE); trademark rights are not granted by the software license. Required third-party asset attributions remain governed by their stated licenses.
