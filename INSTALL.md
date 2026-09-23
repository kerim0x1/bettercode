# Install and set up BetterC0de

This guide covers both the downloadable desktop app and a local checkout for development. Run the commands from the repository root.

## Use the desktop installer

Download the build for your operating system from [GitHub Releases](https://github.com/kerim0x1/bettercode/releases). Expand **Assets** below the release notes to see the installers.

The installer files are published on the repository's [GitHub Releases page](https://github.com/kerim0x1/bettercode/releases). GitHub **Packages** is for npm/container packages and does not contain the desktop `.exe`, `.dmg`, or Linux installers. A release is created when a matching `v<version>` tag is pushed; the release then contains the installer and update metadata such as `latest.yml`.

| System | File | Install |
| --- | --- | --- |
| Windows 10/11, 64-bit | `BetterC0de-Setup-<version>.exe` | Run it. SmartScreen warns because the build is unsigned: **More info → Run anyway**. |
| macOS 12+ Apple Silicon | `BetterC0de-<version>-arm64.dmg` | Open it and drag BetterC0de to **Applications**. |
| macOS 12+ Intel | `BetterC0de-<version>.dmg` | Same as above. |
| Linux x64 (Debian, Ubuntu) | `betterc0de_<version>_amd64.deb` | `sudo apt install ./betterc0de_<version>_amd64.deb` |
| Linux x64 (Fedora, RHEL) | `betterc0de-<version>.x86_64.rpm` | `sudo dnf install ./betterc0de-<version>.x86_64.rpm` |
| Linux x64 (any) | `BetterC0de-<version>.AppImage` or `.tar.gz` | `chmod +x` the AppImage and run it, or extract the tarball and run `betterc0de`. |

The `.deb` and `.rpm` pull in the system libraries Electron needs; the AppImage and tarball expect them to be present already (any desktop installation has them). On macOS, an unsigned app is blocked on first launch: open **System Settings → Privacy & Security** and choose **Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/BetterC0de.app`. [Code signing](docs/development/code-signing.md) explains why.

To check a download, compare it with the release's `SHA256SUMS.txt`: `sha256sum -c SHA256SUMS.txt --ignore-missing` on Linux, `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` on macOS, or `Get-FileHash <file>` in PowerShell.

After installation, open **Settings → Providers**, connect a supported provider, open a project folder, and start a conversation. Provider accounts, API keys, and usage limits belong to the provider you connect.

Unsigned Windows and macOS builds do not install updates automatically. Download and run the newer installer from Releases to update them. A successful CI run alone does not publish a download: the tag-triggered Release workflow runs the full release check on every platform and publishes the release only after all of them pass. Beta versions are marked as prereleases. Known problems of each version are listed in the [changelog](CHANGELOG.md).

## Requirements for a source checkout

| Tool | Version |
| --- | --- |
| Node.js | **22.23.2**, pinned in `.nvmrc` and `.node-version`. Releases and CI use exactly this version. Node 22.15 or newer and Node 24 are supported for development (`engines` in `package.json`); other majors are not. |
| npm | 10.9 or newer (Node 22.23.2 includes npm 10.9.8). |
| Git | 2.x. |
| Python | 3.10 or newer, used by `node-gyp` to compile native modules. |
| C/C++ toolchain | See below. |

Native modules (`better-sqlite3`, `node-pty`) are compiled when no prebuilt binary matches your platform, and packaging rebuilds them for Electron. Install the toolchain for your OS:

- **Windows 10/11 (64-bit):** Visual Studio 2022 Build Tools or newer with the **Desktop development with C++** workload, and Python 3.
- **macOS 12 or newer:** Xcode Command Line Tools: `xcode-select --install`.
- **Linux:** `sudo apt-get install -y build-essential python3` on Debian/Ubuntu, `sudo dnf install -y gcc-c++ make python3` on Fedora. `node-pty` ships no prebuilt Linux binaries, so this is always required.

To package and smoke-test on Linux you also need `rpmbuild` and a virtual display: `sudo apt-get install -y rpm xvfb`. Running the desktop app needs a graphical session (X11 or Wayland).

Nothing has to be installed globally with npm: TypeScript, Electron and electron-builder come from the lockfile. Do not copy `node_modules` between operating systems or between Node versions.

## Select the Node version

Any version manager that reads `.nvmrc` or `.node-version` works:

```sh
nvm install && nvm use          # nvm (macOS/Linux) reads .nvmrc
fnm use --install-if-missing    # fnm, all platforms
mise use --local node@22.23.2   # mise
volta pin node@22.23.2          # Volta
node --version                  # v22.23.2
```

Without a version manager, install Node.js 22.23.2 from [nodejs.org](https://nodejs.org/dist/v22.23.2/). `npm run release:check` refuses a Node version outside the supported range and warns when it is not exactly 22.23.2; release builds in CI require the exact version.

## Install dependencies

```sh
git clone https://github.com/kerim0x1/bettercode.git
cd bettercode
npm ci --no-audit --no-fund
```

`npm ci` installs exactly what is recorded in `package-lock.json`. The root `postinstall` hook rebuilds `better-sqlite3` for the active Node runtime, and the `prepare` hook installs the repository's git hooks (husky). A clean install can take several minutes because the repository contains desktop, mobile, and Electron dependencies.

On macOS or Linux, the repository also includes a checked-in setup helper:

```sh
./setup.sh
```

It checks Node.js and npm, installs the lockfile dependencies, confirms that the local TypeScript binary exists, and verifies workspace versions. It never requires a global TypeScript installation. Windows users can run the commands in this section from PowerShell.

For CI or another environment that intentionally rebuilds native modules later, skip only the postinstall hook:

```sh
BETTERC0DE_SKIP_POSTINSTALL=1 npm ci --no-audit --no-fund
```

PowerShell:

```powershell
$env:BETTERC0DE_SKIP_POSTINSTALL = "1"
npm ci --no-audit --no-fund
```

Do not use `--ignore-scripts` for a normal development install unless you rebuild the native modules yourself afterward.

## Start the development app

```sh
npm run dev
```

This builds the shared schema and backend, starts the backend watcher and Vite, and launches Electron. The app does not require a `.env` file for a basic local start. Optional variables are documented in [.env.example](.env.example).

To disable the development heartbeat and automatic diagnostic reports:

```sh
BETTERC0DE_DISABLE_PING=1 BETTERC0DE_DISABLE_CRASH_REPORTS=1 npm run dev
```

PowerShell:

```powershell
$env:BETTERC0DE_DISABLE_PING = "1"
$env:BETTERC0DE_DISABLE_CRASH_REPORTS = "1"
npm run dev
```

## Verify the checkout

Run the fast source gate before submitting a change:

```sh
npm run verify:source
```

It checks workspace versions, type-checks every project, runs the format check on the files you changed, lint, and all test suites. Useful focused checks are:

```sh
npm run typecheck:backend
npm run test:backend
npm test
npm run format:changed   # apply Prettier to the TS/TSX files you changed
npm run build
```

### The release check

`npm run release:check` is the gate every release passes, and CI runs it on every push and pull request:

```text
preflight → npm ci → versions → format → lint → typecheck → test → build →
package → smoke (launch the packaged app) → installers → installer-smoke
```

It starts with a clean `npm ci`, so stop `npm run dev` and any BetterC0de window started from this checkout first. The installer smoke installs, launches and uninstalls the installers. That changes the machine (on Windows it would replace an installed BetterC0de), so it only runs by default in CI. Useful options:

```sh
npm run release:check -- --list             # show the steps
npm run release:check -- --until build      # stop before packaging
npm run release:check -- --skip-install     # reuse node_modules while iterating
npm run release:check -- --installer-smoke  # include the install/uninstall test here
```

A run with skipped steps says so in its summary. CI covers Ubuntu, Windows and both Mac architectures; a local run covers only your own platform.

## Build an installer locally

Build on the operating system you are packaging for:

```sh
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

Artifacts are written to `release/`. Packaging rebuilds native modules for Electron. Close BetterC0de and other processes using this checkout before packaging so native files are not locked. macOS installers cannot be built on Windows, and a Mac build packages only the architecture of the Mac it runs on. `npm run release:check` builds the same installers and also tests them.

## Troubleshooting

### `npm ci` fails with `EPERM`, `EBUSY` or "resource busy or locked" (Windows)

Another process holds a file in `node_modules`, typically a running `npm run dev`, a Vite server, or a BetterC0de/Electron window started from this checkout. Stop them (or reboot) and run `npm ci` again. `npm run release:check` starts with `npm ci`, so the same applies to it.

### `gyp ERR!`, `MSB8036`, or "could not find any Visual Studio installation"

A native module is compiling and the toolchain is missing. Install the build tools listed under [requirements](#requirements-for-a-source-checkout), open a new terminal, and rerun `npm ci`.

### `GetCommitHash.bat` is "not recognized" while rebuilding node-pty (Windows)

`gyp: Call to 'cmd /c "cd shared && GetCommitHash.bat"' returned exit status 1` means the environment variable `NoDefaultCurrentDirectoryInExePath` is set, so `cmd.exe` will not run a script from the current directory, which node-pty's bundled winpty build needs. Clear it for the shell that runs the build (`Remove-Item Env:NoDefaultCurrentDirectoryInExePath` in PowerShell, `set NoDefaultCurrentDirectoryInExePath=` in cmd) and run the command again. `npm run release:check` detects this in preflight.

### `release:check` stops at preflight

Preflight names the problem and the fix: a Node version outside the supported range, a missing `xvfb-run` or `rpmbuild` on Linux, or missing Xcode Command Line Tools. In CI it also requires the exact Node version from `.nvmrc`.

### The format check fails

`npm run format:check` runs Prettier on the TS/TSX files that differ from `origin/main` (or from `FORMAT_BASE`). Run `npm run format:changed`, review the result and commit it. Files you did not touch are never checked.

### A tag push is rejected by the pre-push hook

Pushing a `v<version>` tag runs `npm run release:check` first. The hook also refuses the push when the tag does not match the version in `package.json`, points at a commit other than the checked-out one, the working tree has uncommitted files, or `CHANGELOG.md` has no section for the version. Fix what it reports and push the tag again. `git push --no-verify` skips the hook, but the Release workflow runs the same check on every platform before anything is published.

### Linux: the app exits with a sandbox error

Messages like "The SUID sandbox helper binary was found, but is not configured correctly" or "No usable sandbox!" appear on distributions that restrict unprivileged user namespaces (Ubuntu 24.04 and newer). The `.deb` installs an AppArmor profile, and the AppImage turns the sandbox off by itself when it cannot work. For the extracted `.tar.gz`, start `./betterc0de --no-sandbox`, or give `chrome-sandbox` the permissions Chromium expects: `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`.

### Linux: the app does not start and reports a missing `.so` library

The AppImage and tarball use the system's GTK, NSS, ALSA and GBM libraries. `ldd ./betterc0de | grep "not found"` lists what is missing. Install those packages, or use the `.deb`/`.rpm`, which declare them as dependencies.


### `npm ERR! code ENOTFOUND` or registry DNS errors

This means npm could not resolve or reach the package registry. It is usually a DNS, proxy, VPN, or temporary network failure rather than a project dependency error. This repository includes npm retry settings in `.npmrc`.

Check the registry and connectivity first:

```sh
npm config get registry
npm ping --registry=https://registry.npmjs.org/
```

Then retry the install:

```sh
npm ci --foreground-scripts --no-audit --no-fund --loglevel=info
```

If you are on a company network, configure the required npm proxy or temporarily use a working network. Do not replace the lockfile or switch to `npm install` to work around a DNS failure.

### `Node backend did not send a startup heartbeat`

The desktop shell waits for the backend to finish loading before it can serve requests. On a busy Windows machine, a cold development start can take more than 30 seconds to load its modules. Current builds allow up to 120 seconds for the first heartbeat, then require a heartbeat at least every 30 seconds, with a five-minute overall startup limit.

If an older checkout fails at exactly `30000ms` and then logs `Node backend ready`, update the checkout and restart with `npm run dev`. This command rebuilds the backend before launching. Installing TypeScript globally does not fix this timeout.

If startup still fails, include the complete startup log and whether the failure mentions the **first heartbeat**, a later heartbeat, or the **hard startup limit** in the bug report. These identify different startup phases. Keep your local data directory intact.

### Native module or Node ABI errors

Rebuild the local SQLite binding with the selected Node version:

```sh
npm rebuild better-sqlite3
```

If dependencies were installed under another Node version or operating system, remove `node_modules` and perform a fresh `npm ci`. On macOS/Linux:

```sh
rm -rf node_modules
npm ci --no-audit --no-fund
```

PowerShell:

```powershell
Remove-Item -Recurse -Force node_modules
npm ci --no-audit --no-fund
```

### The app starts but a provider is missing

Install and sign in to the provider's supported CLI, then restart BetterC0de. Open **Settings → Providers** to see the detected tools. Provider-specific setup is described in the [workspace development reference](docs/development/workspace-reference.md).

### A clean install fails during `postinstall`

Make sure the active Node version is supported and that native build tools are installed. To confirm whether the failure is limited to the native rebuild, run the CI-style install and then rebuild explicitly:

```sh
BETTERC0DE_SKIP_POSTINSTALL=1 npm ci --no-audit --no-fund
npm rebuild better-sqlite3
```

The second command must succeed before running the backend or desktop app.

## Local data

Development data is stored under `~/.betterc0de-dev` by default. Packaged builds use `~/.betterc0de`. Set `BETTERC0DE_HOME` to use a separate profile for migration or testing work.
