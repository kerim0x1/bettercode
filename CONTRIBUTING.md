# Contributing to BetterC0de

Thanks for helping improve BetterC0de. Start with the [installation and setup guide](INSTALL.md), the [development guide](docs/development/README.md) and the [architecture overview](docs/architecture/overview.md).

If you use a coding agent, give it [AGENTS.md](AGENTS.md) as its entry point before it edits files. Read the [CI guide](docs/development/ci.md), [brand guide](BRAND.md), and [UI and theme guide](docs/design-system.md) yourself when the change touches those areas. The guidance applies to human and agent contributions alike.

## Before you start

Search the [issues](https://github.com/kerim0x1/bettercode/issues) for existing reports. For a substantial feature or architectural change, describe the problem and proposed approach in an issue before implementing it. Small, focused fixes can go straight to a pull request.

Check [license status](docs/open-source-readiness.md) before contributing or redistributing the project. Third-party dependencies and assets retain their own terms.

## Set up

1. Install Node.js **22.23.2** (the version in `.nvmrc`; `nvm use`, `fnm use` or `volta` pick it up) and the native build tools for your OS listed in [INSTALL.md](INSTALL.md#requirements-for-a-source-checkout).
2. Fork the repository, clone your fork, and run `npm ci`. This installs the exact dependency versions from `package-lock.json` and the git hooks.
3. Start the app with `npm run dev`.

## Development workflow

1. Create a branch for one change. Keep changes focused and preserve existing behavior outside the task.
2. Add or update tests when behavior changes. Use the existing suite for the affected area: `apps/ui` and `apps/backend` use Vitest, `scripts/*.test.mjs` use `node:test`.
3. Before pushing, run the fast gate:

   ```sh
   npm run verify:source
   ```

   It covers workspace versions, every type-check, the format check, lint and all test suites.
4. If the format check fails, run `npm run format:changed`, review the diff and commit it. Only the TS/TSX files your branch changes are checked; do not reformat unrelated files.
5. For changes to packaging, the Electron main process, native modules, installers or CI, also run the full gate on your platform:

   ```sh
   npm run release:check
   ```

   It reinstalls from the lockfile, builds, packages, launches the packaged app and builds the installers. Stop `npm run dev` first, because it replaces `node_modules`.
6. Open a pull request. CI runs `npm run release:check` on Linux, Windows, macOS arm64 and macOS x64, and the source checks on Node 24. All jobs must pass before merging.

Use npm only, and commit intentional dependency changes together with `package-lock.json`. Do not upgrade a dependency's major version as a side effect of another change. Do not commit dependency folders, generated bundles, signing certificates, `.env` files, local settings, database files, or real provider credentials.

### Tests

Fix failing tests at their cause. Do not skip, delete or loosen a test to get a green run. If a test is wrong, explain why in the pull request when you change it. Platform-conditional tests (`it.skipIf(process.platform ...)`) are for behavior that only exists on one OS; the CI matrix runs every platform's variant.

### Git hooks

`npm ci` installs a husky `pre-push` hook. Branch pushes are not affected. Pushing a release tag (`v<version>`) runs `npm run release:check` and blocks the push if it fails; see [Releases](#releases). If hooks are not wanted, `HUSKY=0` disables them for a command, but CI and the Release workflow run the same checks regardless.

## Project conventions

- Keep renderer backend access behind the existing service/transport layer.
- Keep public contracts in `packages/schema` and mirror IPC changes in both registries where required.
- Follow existing TypeScript, React, and CommonJS conventions in the files you edit.
- Use the project's dialogs and permission flows for user decisions.
- Keep provider-specific behavior in the appropriate provider adapter.
- Keep npm scripts cross-platform: call Node scripts rather than shell-specific syntax.
- Update user-facing documentation when setup, behavior, or diagnostics change, and add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Pull requests

Explain the problem, the resulting behavior, and how you checked it. Include screenshots for visible UI changes and note any platform you could not test. For UI changes, review default dark, white, system, and imported themes as applicable. The fast `npm run check:contributor-contract` job checks shared theme token compatibility on every push and pull request. Avoid unrelated formatting changes or dependency upgrades.

Keep discussion respectful and focused on the work. For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue with exploit details.

## Releases

After a merge to `main`, CI must pass before the Automatic release workflow prepares a versioned commit reachable from a new `v<version>` tag and explicitly starts Release on that tag. The protected `main` branch stays unchanged; its version may trail the latest tag. Release runs `release:check` on every platform and publishes only after every gate passes. Maintainers can still release by tag manually; see the [release checklist](docs/release-checklist.md). Keep `Unreleased` useful: new entries since the last release become public notes automatically.
