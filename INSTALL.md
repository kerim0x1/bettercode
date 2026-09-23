# Install and set up BetterC0de

This guide covers both the downloadable desktop app and a local checkout for development. Run the commands from the repository root.

## Use the desktop installer

Download the build for your operating system from [GitHub Releases](https://github.com/kerim0x1/bettercode/releases). Expand **Assets** below the release notes to see the installers.

The installer files are published on the repository's [GitHub Releases page](https://github.com/kerim0x1/bettercode/releases). GitHub **Packages** is for npm/container packages and does not contain the desktop `.exe`, `.dmg`, or Linux installers. A release is created when a matching `v<version>` tag is pushed; the release then contains the installer and update metadata such as `latest.yml`.

The installer files are published on the repository's [GitHub Releases page](https://github.com/kerim0x1/bettercode/releases). GitHub **Packages** is for npm/container packages and does not contain the desktop `.exe`, `.dmg`, or Linux installers. A release is created when a matching `v<version>` tag is pushed; the release then contains the installer and update metadata such as `latest.yml`.

| System | File |
| --- | --- |
| Windows 10/11, 64-bit | `.exe` installer |
| macOS Apple Silicon | `.dmg` for `arm64` |
| macOS Intel | `.dmg` for `x64` |
| Linux | `.AppImage`, `.deb`, `.rpm`, or `.tar.gz` package |

After installation, open **Settings → Providers**, connect a supported provider, open a project folder, and start a conversation. Provider accounts, API keys, and usage limits belong to the provider you connect.

Unsigned Windows builds do not install updates automatically. Download and run the newer `.exe` installer from Releases to update them. A successful CI run alone does not publish a download: the tag-triggered Release workflow builds installers into a draft and publishes it only after all platform jobs succeed. Beta versions are marked as prereleases.

## Requirements for a source checkout

- Node.js **22.15.0 or newer** and npm **10 or newer**. CI uses Node 22.
- Git.
- A desktop environment for Electron.
- Native build tools when npm cannot use a prebuilt module:
  - Windows: Python and Visual Studio C++ Build Tools.
  - macOS: Xcode Command Line Tools (`xcode-select --install`).
  - Linux: a C/C++ toolchain, Python, and the packages required by Electron Builder.

Node 24 may work, but Node 22 is the supported and continuously tested version. Do not copy `node_modules` between operating systems or between different Node versions.

## Install with mise

If you use [mise](https://mise.jdx.dev/), select the repository's Node major version before installing:

```sh
mise use --local node@22
node --version
npm --version
```

The Node version must be `22.15.0` or newer and npm must be version 10 or newer. If `mise exec node@24 -- npm ci` is being used, switch to Node 22 for a setup that matches CI.

## Install dependencies

```sh
git clone https://github.com/kerim0x1/bettercode.git
cd bettercode
npm ci --no-audit --no-fund
```

`npm ci` installs exactly what is recorded in `package-lock.json`. The root `postinstall` hook rebuilds `better-sqlite3` for the active Node runtime. A clean install can take several minutes because the repository contains desktop, mobile, and Electron dependencies.

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

Run the full source gate before submitting a change:

```sh
npm run verify:source
```

Useful focused checks are:

```sh
npm run typecheck:backend
npm run test:backend
npm test
npm run build
```

The CI source gate runs on Ubuntu and Windows. A successful local run on one operating system does not replace the other platform's checks.

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

Artifacts are written to `release/`. Packaging rebuilds native modules for Electron. Close BetterC0de and other processes using this checkout before packaging so native files are not locked. macOS installers cannot be built on Windows.

## Troubleshooting

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
