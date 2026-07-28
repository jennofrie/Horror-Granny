# Horror Granny Security Policy

Profexor maintains the security of the Horror Granny codebase, build workflow, and web deployment.

## Supported version

The latest `main` branch receives fixes.

## Private reporting

Report exploitable findings through a private GitHub security advisory:

<https://github.com/jennofrie/Horror-Granny/security/advisories/new>

Include the affected commit, impact, reproduction, browser/platform, and a suggested mitigation when available.

Do not publish exploitable details in issues, discussions, pull requests, screenshots, or gameplay captures before a fix is available.

## Scope

- Cross-site scripting or unsafe dynamic markup.
- Dependency and build-chain compromise.
- Exposed secrets or deployment credentials.
- Unsafe asset or save-data handling.
- Browser permission abuse.
- Deployment-header or static-export vulnerabilities.

Gameplay balance, ordinary visual defects, and non-security performance regressions belong in normal issues.

## Dependency practice

- Use the committed pnpm lockfile.
- Review dependency and transitive changes.
- Run `pnpm check` and the package-manager audit.
- Never commit secrets or local credential files.
- Preserve third-party license metadata and asset attribution.

---

Horror Granny™ and its original project identity are trademarks of Profexor. Copyright © 2026 Profexor. The project code is licensed under the [MIT License](LICENSE); trademark rights are not granted by the software license. Required third-party asset attributions remain governed by their stated licenses.
