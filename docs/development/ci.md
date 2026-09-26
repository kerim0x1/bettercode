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

For UI changes, also follow the [design system](../design-system.md) review matrix and attach before/after screenshots. CI can check token contracts and code, but visual fit, interaction, accessibility, and whether someone actually read these guides still require review.
