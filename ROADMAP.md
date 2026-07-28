# Horror Granny Roadmap

This roadmap captures future enhancement themes without committing to release dates.

## Reliability

- Establish repeatable gameplay seeds for balance and AI regressions.
- Expand automated win, death, hiding, weapon, and touch-control flows.
- Track WebGL context loss and asset-load recovery.
- Add representative performance baselines for desktop and mobile tiers.

## Player experience

- Improve accessibility settings for motion, contrast, subtitles, audio, and input.
- Expand controller support and remapping.
- Improve onboarding without weakening the house’s uncertainty.
- Add clearer recovery paths for interrupted or backgrounded mobile sessions.

## Horror systems

- Extend hunter behaviors without breaking readable counterplay.
- Add more authored sound and lighting events.
- Expand hiding-space risk and environmental storytelling.
- Test additional seeded pickup and route variations.

## Technical art

- Continue draw-call and asset-size reviews.
- Add automated GLTF validation to the asset intake pipeline.
- Review shader and post-processing fallbacks by device capability.
- Keep all licensed assets traceable to the machine-readable manifest and human-readable attribution table.

## Delivery gate

An enhancement is complete when gameplay acceptance criteria pass, `pnpm check` succeeds, performance impact is measured, static export remains valid, documentation is updated, and all Profexor ownership and third-party attribution notices remain intact.

---

Horror Granny™ and its original project identity are trademarks of Profexor. Copyright © 2026 Profexor. The project code is licensed under the [MIT License](LICENSE); trademark rights are not granted by the software license. Required third-party asset attributions remain governed by their stated licenses.
