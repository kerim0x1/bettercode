# CI and contributor checks

Read this before editing or opening a pull request. The workflow is [.github/workflows/ci.yml](../../.github/workflows/ci.yml); this page explains what its jobs protect.

| Job | Runs on | What it checks |
| --- | --- | --- |
| Contributor guidance and theme contract | Every push and pull request, including forks | Required agent and contributor guides exist; desktop CSS color tokens resolve in both modes; built-in and imported themes expose the same workbench token set; default dark and white templates match the CSS fallback values. No install or secrets are needed. |
| `release:check` | Linux x64, Windows x64, macOS arm64, macOS x64 | Clean install, versions, format, lint, types, tests, production build, packaging, packaged-app launch, installers, and installer smoke. |
| Node source and build | Linux, Windows, macOS on Node 24 | Source checks and production build under the next supported Node line. |
| Phone app on Android | Android emulator | APK build, package checks, and device flows. |
| Phone app on iOS | iOS simulator | iOS build, package checks, and device flows. |
| Automatic release | Successful CI push run on the current `main` commit | Prepare the next shared version and changelog section in a tag-only commit, then dispatch the full Release workflow on that tag. |

For branches in this repository, the push run covers the code. For forked contributions, the pull request run covers it. The contributor job runs for both event types. All applicable jobs should pass before merge; check the failing job's log and the uploaded mobile evidence when a device flow fails. A green push run on `main` starts the separate Automatic release workflow. The protected `main` branch is not changed by that workflow. Its tag-only commit does not trigger CI through `GITHUB_TOKEN`; the dispatched tag release repeats the full platform gate before publishing.

## Before pushing

Use `npm run check:contributor-contract` for a quick check of the guidance and theme token contract. `npm run verify:source` is the normal source gate; `npm run release:check` is the full platform gate for packaging, Electron, native, installer, or CI changes. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for setup and formatting. If the task or environment limits local checks, state what was not run and use the CI results.

## Lint rules and ratchets

`npm run lint` runs in `verify:source` and `release:check` and fails only on errors. These rule sets are warnings, so the existing findings show in the output without failing CI. Avoid adding to them, and raise a rule to `"error"` in [eslint.config.js](../../eslint.config.js) once `npm run lint` reports none for it.

| Files | Rule | What it warns about |
| --- | --- | --- |
| `apps/ui/src`, except `services/` and `lib/` | `@typescript-eslint/no-restricted-imports` | Importing the removed `@/services/backend` barrel instead of the defining module |
| `apps/ui/src/services` | `@typescript-eslint/no-restricted-imports` | The barrel, zustand stores (`@/lib/*-store`) and `@/hooks/**`: `services/` is transport only |
| `apps/ui/src/lib` | `@typescript-eslint/no-restricted-imports` | The barrel and imports from `hooks/` |
| `apps/ui/src`, except `services/` | `no-restricted-properties` | `window.electronAPI` outside `services/ipc-facade.ts` |
| `apps/ui/src` | `max-lines-per-function` | Functions over 300 lines, not counting blank lines and comments |
| `apps/backend/src` | `@typescript-eslint/no-floating-promises` | A promise that is not awaited, returned, caught or explicitly `void`ed; in the backend it ends in the fatal-shutdown path |
| `apps/shell/**/*.cjs`, `scripts/**/*.cjs`, `scripts/**/*.mjs` | ESLint's recommended core rules | `no-undef`, `no-unused-vars` and the rest, for Node code that was linted only for imports |

The rule that guards the frozen legacy provider stack is an error: no backend module may import `provider/adapter.ts`, `adapters/`, `registry.ts` or `service.ts`, statically, dynamically or as a type, except the files in its allowlist in `eslint.config.js`. Shrink that list; do not grow it.

Two tests hold contracts in place:

- `apps/backend/src/http/contracts.structure.test.ts` (in `npm run test:backend`) reads the route registrations in `http/routes/` and `remote/http.ts` and fails when more than two have no shared contract in `packages/schema`. The two are `GET /health` and `GET /shell/output/:archiveId`, which streams plain text. A new route needs a contract. Every route with a contract must validate with it (`handleHttpContract` or `contractJson`), and every contract must have a route. Lower the limit when a remaining route gets a contract; never raise it to pass.
- `scripts/preload-api-contract.test.mjs` (in `npm run test:packaging`) runs the real preload and fails when it, `PreloadApi` in `apps/shell/shared/ipc-contract.cjs` and `apps/ui/src/types/electron-api.d.ts` disagree.

## Editing workflows and Dependabot

Every `actions/checkout` step in `ci.yml` and `release.yml` sets `persist-credentials: false`. No job there pushes with git, and the token should not sit in `.git/config` while npm runs dependency lifecycle scripts. `scripts/ci-workflows.test.mjs` (part of `npm run test:packaging`) fails when a checkout leaves it out. Third-party actions are pinned by commit SHA, also inside the composite actions in `.github/actions/`.

[Dependabot](../../.github/dependabot.yml) updates npm weekly and GitHub Actions monthly. The `electron` group keeps `electron`, `electron-builder`, `electron-updater` and `@electron/*` in one pull request, majors included, because Electron supports only its newest majors and the packager has to support the runtime it ships; it is listed before the runtime and development groups, since a dependency joins the first group it matches. Expo SDK and React Native major (and React Native minor) updates are ignored and done deliberately. The Actions updates cover `/` and `/.github/actions/*`; the same test checks both directories are listed.

## Reviewing UI changes

For UI changes, also follow the [design system](../design-system.md) review matrix and attach before/after screenshots. CI can check token contracts and code, but visual fit, interaction, accessibility, and whether someone actually read these guides still require review.
