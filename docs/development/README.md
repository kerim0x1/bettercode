# Develop BetterC0de

[Project home](../../README.md) · [Contributing](../../CONTRIBUTING.md) · [Architecture](../architecture/overview.md)

For a first-time installation, supported Node versions, `mise`, npm registry errors, and native dependency troubleshooting, start with the [installation and setup guide](../../INSTALL.md).

## Requirements

- Node.js **22.23.2**, pinned in `.nvmrc` and `.node-version`; CI and releases use exactly this version. Node 22.15+ and Node 24 are supported for development. npm 10.9 or newer.
- Git and a desktop environment for running Electron.
- A supported AI provider account or API connection to use AI features. Building and running the test suites does not require provider credentials.
- Native build tools: Python 3.10+ with Visual Studio 2022 Build Tools (Desktop development with C++) on Windows, Xcode Command Line Tools on macOS, or `build-essential`/`gcc-c++`, `make` and Python 3 on Linux. Linux packaging also needs `rpm` and `xvfb`.

[INSTALL.md](../../INSTALL.md#requirements-for-a-source-checkout) has the full list with install commands.

## Install and run

```sh
git clone https://github.com/kerim0x1/bettercode.git
cd bettercode
npm ci
npm run dev
```

Run commands from the repository root. `npm ci` uses the committed lockfile. The postinstall hook aligns SQLite's native binding with your local Node runtime. Development starts the backend build, backend watcher, Vite, and Electron.

The package manifests keep `private: true` to prevent accidental npm publishing. This setting does not control the GitHub repository's visibility or its source-code license.

If you have a dependency checkout from another Node version, reinstall using the supported runtime. Avoid copying `node_modules` between operating systems or between unrelated checkouts.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `apps/ui` | React desktop interface, editor, agent views, and canvas. |
| `apps/shell` | Electron main process, preload bridges, desktop integrations, and packaging resources. |
| `apps/backend` | Node backend, persistence, providers, orchestration, and HTTP/WebSocket APIs. |
| `apps/mobile` | Expo companion app for connecting to the desktop. |
| `packages/schema` | Shared types, validation, and public contracts. |
| `packages/util` | Shared utilities. |
| `scripts` | Build, packaging, verification, and smoke-test tools. |
| `remotion` | Optional local video/demo compositions; the directory is Git-ignored, while its supporting scripts stay tracked. |
| `docs` | Architecture, remote-access, development, and release documentation. |

The source export intentionally excludes installed dependencies, build outputs, local agent configurations, reference checkouts, private runtime data, and internal audit work files.

## Verify a change

```sh
npm run verify:source    # fast: versions, type-checks, format check, lint, all test suites
npm run release:check    # full gate: clean install through installers (see below)
```

The source gate checks workspace versions, builds the backend and shared schema, checks desktop/backend/shell/mobile/demo types, runs the format check on changed TS/TSX files, runs lint, and executes packaging, UI, backend, and mobile tests.

`npm run release:check` is what CI runs on every push and pull request, on Linux, Windows and both Mac architectures, and what every release passes:

| Step | What it runs |
| --- | --- |
| preflight | Node version against `.nvmrc`/`engines`, npm, git, and platform packaging tools |
| install | `npm ci` from the lockfile |
| versions, format, lint | `check:versions`, `format:check`, `lint` |
| typecheck | schema/backend build, then UI, backend, shell, mobile and demo type-checks |
| test | packaging (`node:test`), UI, backend and mobile suites |
| build | production build with bundle budgets, backend start-up/memory budgets (`perf:backend`), mobile app config, native-dependency and bundle checks (`mobile:check`) |
| package | Electron native rebuild, unpacked package, package size budgets |
| smoke | launches the packaged app: backend health, renderer mounted, no fatal diagnostics |
| installers | installers built from that exact app, plus checksums |
| installer-smoke | install → launch → uninstall on the host (CI only by default) |

`--list`, `--until <step>`, `--from <step>`, `--skip-install` and `--installer-smoke` control a run; see `npm run release:check -- --help`. The scripts live in `scripts/release-check.mjs`, `scripts/packaged-startup-smoke.mjs` and `scripts/installer-smoke.mjs`.

For a focused edit, use the relevant scripts: `npm test`, `npm run test:backend`, `npm run test:mobile`, or `npm run test:packaging`. The optional local video compositions have a separate `npm run typecheck:remotion` check; it skips cleanly when the ignored `remotion/` directory is absent.

## Build desktop packages

| Build host | Command | Outputs |
| --- | --- | --- |
| Windows | `npm run build:win` | Windows installer. |
| macOS | `npm run build:mac` | macOS DMG and ZIP targets. |
| Linux | `npm run build:linux` | Configured Linux packages. |

Artifacts are written to `release/`. These local commands explicitly disable publishing. Packaging rebuilds native modules for Electron and then restores the development dependency setup. Close apps using this checkout before packaging so native files are not locked.

Build and test on the target operating system and architecture: macOS packages cannot be built on Windows, and a Mac build packages only its own architecture. Releases are unsigned by decision; see [code signing](code-signing.md). See the [release checklist](../release-checklist.md) for the maintainer workflow.

Fork maintainers must change the repository/publishing target in `package.json` and review app IDs, mobile bundle identifiers, diagnostic endpoints, and branding before distributing their own builds. The current package metadata points to `kerim0x1/bettercode`.

## Environment and local data

The app runs without a local environment file. `.env.example` documents optional settings; it is not automatically loaded into every Electron or backend process. Set variables in the shell or process launcher that starts the application.

The default desktop profile is `~/.betterc0de-dev` in development and `~/.betterc0de` in packaged builds. `BETTERC0DE_HOME` selects an alternative absolute profile directory. Use a separate profile when testing migrations or destructive scenarios.

### Diagnostics during development

The standard app sends a heartbeat every 25 seconds and can send automatic error reports to BetterC0de. For local work without those automatic requests, set both environment variables before starting it.

PowerShell:

```powershell
$env:BETTERC0DE_DISABLE_PING = "1"
$env:BETTERC0DE_DISABLE_CRASH_REPORTS = "1"
npm run dev
```

macOS or Linux:

```sh
BETTERC0DE_DISABLE_PING=1 BETTERC0DE_DISABLE_CRASH_REPORTS=1 npm run dev
```

Manual **Send Report** remains available. The [product guide](../../PRODUCT_GUIDE.md#diagnostics-and-data) describes the payloads. CI sets these controls at workflow level.

## Mobile and optional demos

See [the mobile README](../../apps/mobile/README.md) for Expo development. The app configuration names the published app's Expo project; forks set `BETTERC0DE_EXPO_OWNER` and `BETTERC0DE_EAS_PROJECT_ID` for their own project and use their own bundle identifiers for distribution.

The `remotion/` source is intentionally kept local and ignored by Git. The tracked Remotion commands and typecheck helper remain in `package.json` and `scripts/` for maintainers who keep that optional project locally. Its dependencies have their own licensing requirements; see [third-party notices](../../THIRD_PARTY_NOTICES.md).

The [workspace reference](workspace-reference.md) preserves the detailed feature and implementation notes from the desktop source repository. This guide is the primary source for current contributor setup.
