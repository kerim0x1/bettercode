# Changelog

All notable changes to BetterC0de are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

A `v<version>` tag can only be released when this file has a `## [<version>]` section. The release workflow publishes that section as the GitHub release notes, and the pre-push hook refuses the tag without it.

## [Unreleased]

### Fixed

- **macOS Apple Silicon downloads contain an Apple Silicon build.** In 0.1.0-beta.2, `BetterC0de-0.1.0-beta.2-arm64-mac.zip` and `BetterC0de-0.1.0-beta.2-arm64.dmg` contain the Intel (x86_64) app. The target configuration overrode the build's architecture flag, so each Mac build job packaged its one app under both architectures' names, and the Intel job's files are the ones that were published.
- **macOS update metadata lists both architectures.** `latest-mac.yml` was taken from whichever Mac job uploaded last; it is now merged from both, and every entry is checked against the published file's sha512 before release.
- **Start-up failures explain themselves.** When the background service cannot start, the dialog shows the lines the service printed and what to do (reinstall the matching build, rebuild native modules, free disk space, fix folder permissions), instead of only "Failed to start backend: Node backend exited (code=1 signal=none)".
- **Windows installer checksum.** The installer is named `BetterC0de-Setup-<version>.exe` locally, in the release and in the checksum file. The checksum file used to list a name with spaces that did not exist in the release.

### Added

- `npm run release:check`: one command from a clean `npm ci` through lint, type-checks, all test suites, the production build, packaging, a launch of the packaged app, the installers, and an install → launch → uninstall test of the installers on a clean machine.
- CI runs `release:check` on Linux x64, Windows x64, macOS arm64 and macOS x64 for every push and pull request, and the source checks on Node 24.
- The Linux `.deb` is installed with apt and started with the Chromium sandbox on in CI; the `.rpm` is installed in a clean Fedora container.
- A pre-push hook runs `release:check` before a release tag is pushed.
- Documentation for code signing and notarization (`docs/development/code-signing.md`) and this changelog.

### Changed

- Releases are published only after every platform passed, from one verified set of files. A failed platform no longer leaves a partial release behind.
- Releases carry a single `SHA256SUMS.txt` instead of one checksum file per platform.
- Node.js 22.23.2 is the pinned build toolchain (`.nvmrc`). Supported for development: Node 22.15+ and Node 24.
- A local `npm run build:mac` builds only for the architecture of the Mac it runs on, like the CI jobs. It used to also emit the other architecture's file names from the same app.

## [0.1.0-beta.2] - 2026-09-22

### Known issues

- The macOS **arm64** downloads contain the Intel build (see Unreleased → Fixed). Apple Silicon Macs run it through Rosetta 2; macOS offers to install Rosetta on first launch if it is missing.
- `SHA256SUMS-macOS-arm64.txt` does not match the published arm64 files, and `SHA256SUMS-Windows-x64.txt` lists the installer as `BetterC0de Setup 0.1.0-beta.2.exe` while the download is named `BetterC0de-Setup-0.1.0-beta.2.exe`.
- No `.deb`, `.rpm`, `latest-linux.yml` or Linux checksum file was published, because the Linux release job failed. The AppImage and `.tar.gz` are available.
- All builds are unsigned. See [code signing](docs/development/code-signing.md) for what users see and how to get past it.
