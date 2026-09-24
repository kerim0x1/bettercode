<p align="center">
  <img src="assets/betterc0de-mark.png" alt="BetterC0de logo" width="104" height="104">
</p>

<h1 align="center">BetterC0de</h1>

<p align="center"><strong>Your coding agents. One desktop workspace.</strong></p>

> [!WARNING]
> **Beta software:** BetterC0de is an early beta release. Bugs, crashes, incomplete features, and breaking changes are normal and expected. Save your work, review changes before running them, and report problems through [GitHub Issues](https://github.com/kerim0x1/bettercode/issues).
>
> Download the current beta installers from the [GitHub Releases page](https://github.com/kerim0x1/bettercode/releases/tag/v0.1.0-beta.2). GitHub **Packages** does not contain the desktop installers.

<p align="center">
  Bring your AI conversations, project files, terminals, and live previews together.<br>
  Move from an idea to a change you can see, understand, and review.
</p>

<p align="center">
  <a href="https://betterc0de.com">Website</a> ·
  <a href="#download">Download</a> ·
  <a href="https://betterc0de.com/docs">Docs</a> ·
  <a href="https://betterc0de.com/blog">Blog</a> ·
  <a href="https://discord.gg/bettercode">Discord</a>
</p>

[![BetterC0de website: coding agents, chat, and a shared workspace](assets/betterc0de-website.png)](https://betterc0de.com)

---

## Meet your workspace

**BetterC0de is a desktop AI coding environment.** It brings coding assistants such as Claude Code, OpenAI Codex, Cursor Agent, and Grok into a shared workspace with an editor, terminal, Git tools, and browser previews.

Open a project, choose an available provider, and describe what you want to build. Keep the conversation next to your files, inspect the results, and review the changes before you commit them.

## Three ways to work

| Mode | Make room for what matters |
| --- | --- |
| **Editor** | Work directly with files, search your project, inspect changes, and keep an AI conversation beside your code. |
| **Agent** | Focus on conversations and tasks. Arrange panes so chats, terminals, plans, and diffs are easy to reach. |
| **Canvas** | Arrange projects on a visual canvas with live previews and runtime information. Explore how your work looks across screen sizes. |

## Built around your workflow

- **Bring your preferred agents.** Connect supported coding tools and choose from the providers and models available to your setup.
- **Keep context close.** Work with project files, conversations, terminals, and changes in the same app.
- **Work side by side.** Keep several conversations visible and organize the workspace around the task.
- **See what you are building.** Use browser previews, select page elements, and send visual feedback to your agent.
- **Review with confidence.** Inspect staged and unstaged changes through the Git and Diff views.
- **Make it your own.** Adjust appearance, panel layouts, and separate windows to suit your working style.

## Download

BetterC0de is free during the beta. The [GitHub Releases page](https://github.com/kerim0x1/bettercode/releases) contains the installer files and update metadata for each version. Select the newest beta, expand **Assets**, and choose your platform.

> **Open source as of 21 September 2026.** The full source is in this repository under the MIT License. Beta installers are below.

| Platform | Requirements | Download |
| --- | --- | --- |
| **Windows** | Windows 10 / 11, 64-bit | [Release assets](https://github.com/kerim0x1/bettercode/releases) |
| **macOS · Apple Silicon** | M1 or newer | [Release assets](https://github.com/kerim0x1/bettercode/releases) |
| **macOS · Intel** | Intel-based Mac | [Release assets](https://github.com/kerim0x1/bettercode/releases) |
| **Linux** | x64 | [Release assets](https://github.com/kerim0x1/bettercode/releases) (`.AppImage` or `.tar.gz`) |

Not sure which Mac you have? Open **About This Mac** — an "Apple M…" chip means Apple Silicon. Or just use [betterc0de.com/download](https://betterc0de.com/download), which picks the right build for your system.

### Installing a beta build

BetterC0de installers are not code-signed, so your operating system warns before the first launch:

- **Windows:** SmartScreen shows "Windows protected your PC". Choose **More info → Run anyway**. Unsigned Windows builds do not update themselves; install a newer version by running its installer.
- **macOS:** open the `.dmg` and drag BetterC0de to **Applications**. If macOS blocks the first launch, open **System Settings → Privacy & Security** and choose **Open Anyway**. If it reports that the app is damaged, run `xattr -dr com.apple.quarantine /Applications/BetterC0de.app` in Terminal.
- **Linux:** install the `.deb` with `sudo apt install ./betterc0de_<version>_amd64.deb` or the `.rpm` with `sudo dnf install ./betterc0de-<version>.x86_64.rpm`. Either one installs the libraries the app needs. For the AppImage, run `chmod +x BetterC0de-<version>.AppImage` first.

Each release lists SHA-256 checksums of its files in `SHA256SUMS.txt`. Known problems of each version are in the [changelog](CHANGELOG.md). For 0.1.0-beta.2, the Apple Silicon download contains the Intel build, which runs through Rosetta 2.

## Start here

1. [Download](#download) BetterC0de for your platform.
2. Install BetterC0de and connect a supported AI provider.
3. Open a project folder and start your first conversation.
4. Review the resulting files and changes in your workspace.

Follow the [getting-started guide](GETTING_STARTED.md) for a walkthrough without terminal commands.

## Explore the guides

| Guide | What you will find |
| --- | --- |
| [Getting started](GETTING_STARTED.md) | Installation, provider setup, your first task, and troubleshooting. |
| [How BetterC0de works](PRODUCT_GUIDE.md) | Workspace concepts, everyday workflows, and diagnostic data. |
| [Brand guide](BRAND.md) | The name, logo, visual direction, and reusable product descriptions. |
| [Contributing](CONTRIBUTING.md) | Setup, code conventions, CI, and the UI/theme contribution guide. |

## Build from source

The application source, mobile companion, tests and build tools are all in this repository. [INSTALL.md](INSTALL.md) has the full walkthrough and troubleshooting; this is the short version.

### Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | **22.23.2** (pinned in `.nvmrc`) | Releases are built with exactly this version. Node 22.15 or newer and Node 24 are also supported for development. |
| npm | 10.9 or newer | Node 22.23.2 includes npm 10.9.8. |
| Git | 2.x | Several build steps read repository metadata. |
| Python | 3.10 or newer | Only used by `node-gyp` when a native module has no prebuilt binary. |
| C/C++ build tools | see below | Same condition as Python. |

Operating-system specifics:

- **Windows 10/11, 64-bit:** Visual Studio 2022 Build Tools (or newer) with the **Desktop development with C++** workload. For example: `winget install Microsoft.VisualStudio.2022.BuildTools` and select that workload.
- **macOS 12 or newer:** Xcode Command Line Tools (`xcode-select --install`). Build on a Mac with the architecture you want to package.
- **Linux (x64):** `sudo apt-get install -y build-essential python3` (Debian/Ubuntu) or `sudo dnf install -y gcc-c++ make python3` (Fedora). node-pty has no prebuilt Linux binary, so the compiler is always needed. Packaging additionally needs `rpm` (for `rpmbuild`) and `xvfb` (for the packaged-app smoke test): `sudo apt-get install -y rpm xvfb`.

No global npm packages are needed. TypeScript, Electron, electron-builder and every other tool come from the lockfile. Docker is optional: when available, `release:check` also tests the `.rpm` in a Fedora container.

### Install

```sh
git clone https://github.com/kerim0x1/bettercode.git
cd bettercode
nvm use            # or: fnm use / mise use / volta — anything that reads .nvmrc
npm ci             # exact versions from package-lock.json; also installs the git hooks
npm run dev        # backend, Vite and Electron with hot reload
```

On Windows, run the same commands in PowerShell. On macOS and Linux, `./setup.sh` checks the Node and npm versions and then runs the same install.

### Setup

No `.env` file or account is needed to build, test or start the app. Optional environment variables, such as a separate profile directory or turning off the diagnostic heartbeat during development, are listed in [.env.example](.env.example). Set them in the shell that starts the app. Development data lives in `~/.betterc0de-dev`; installed builds use `~/.betterc0de`. To use AI features, connect a provider in **Settings → Providers**.

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development app with the backend watcher, Vite and Electron. |
| `npm run verify:source` | Fast source gate: versions, type-checks, format check, lint and all test suites. |
| `npm test` / `npm run test:backend` / `npm run test:mobile` / `npm run test:packaging` | One test suite. |
| `npm run lint` / `npm run typecheck` | Lint, or type-check the UI (`typecheck:backend`, `typecheck:shell` and `typecheck:mobile` cover the rest). |
| `npm run format:check` / `npm run format:changed` | Check or apply Prettier on the TS/TSX files you changed. |
| `npm run build` | Production build of the backend and renderer, with bundle budgets. |
| `npm run build:win` / `build:mac` / `build:linux` | Installers for the current OS in `release/`. |
| `npm run release:check` | **The release gate.** Clean install → versions → format → lint → type-check → tests → production build → phone app builds and device tests → package → launch the packaged app → installers → install/launch/uninstall test. Exits non-zero on the first failure. |

`npm run release:check -- --list` shows the steps. Locally, the install/uninstall test is skipped because it would change your machine (and replace an installed BetterC0de); CI runs it on clean runners. Pass `--installer-smoke` to run it anyway.

### Releasing

1. Update the version in every workspace (`npm run check:versions` verifies them) and add a `## [<version>]` section to [CHANGELOG.md](CHANGELOG.md).
2. Commit, tag `v<version>` and push the tag. The pre-push hook runs `npm run release:check` first and refuses the push if it fails.
3. The Release workflow runs `release:check` on Linux, Windows and both Mac architectures, and publishes the GitHub release only when every platform passed.

The [release checklist](docs/release-checklist.md) has the details. Releases are unsigned by decision; [code signing](docs/development/code-signing.md) explains what that means for users.

### Troubleshooting

- **`npm ci` fails with `EPERM`/`EBUSY` on Windows:** a running `npm run dev`, Vite server or BetterC0de window holds files in `node_modules`. Stop them and run `npm ci` again.
- **`gyp ERR!` or a missing compiler during `npm ci`:** install the build tools listed above, then rerun `npm ci`.
- **`release:check` stops at preflight:** it names the missing tool (for example `xvfb-run` or `rpmbuild` on Linux) or the wrong Node version, and prints the command that fixes it.
- **Format check failed:** run `npm run format:changed`, review the diff and commit it.
- **Native module or ABI errors after switching Node versions:** delete `node_modules` and run `npm ci`.

More cases, including registry/DNS failures and backend start-up timeouts, are in [INSTALL.md](INSTALL.md#troubleshooting).

### Contribute

Read [Contributing](CONTRIBUTING.md), [Security](SECURITY.md) and the [third-party notices](THIRD_PARTY_NOTICES.md) before submitting changes or distributing a build. The [development guide](docs/development/README.md) covers the repository layout and architecture.

BetterC0de source is released under the MIT License. Third-party terms stay with their owners; see [third-party notices](THIRD_PARTY_NOTICES.md).

## Stay connected

Visit [betterc0de.com](https://betterc0de.com) for product information, join the [Discord community](https://discord.gg/bettercode), or read the [terms and data information](https://betterc0de.com/terms#data).

BetterC0de is in beta and was open-sourced on 21 September 2026. Available installers and features may vary by release. AI provider access, usage limits, and billing depend on the provider you connect. The app also sends a periodic heartbeat and diagnostic reports; see [Diagnostics and data](PRODUCT_GUIDE.md#diagnostics-and-data).

---

<p align="center"><strong>BetterC0de</strong><br>Your next idea starts in your workspace.<br><sub>Free during beta · Open source 21 September 2026 · Built by <a href="https://kerim0x1.com">kerim0x1</a></sub></p>
