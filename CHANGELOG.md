# Changelog

All notable changes to BetterC0de are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

A `v<version>` tag can only be released when this file has a `## [<version>]` section. The release workflow publishes that section as the GitHub release notes, and the pre-push hook refuses the tag without it.

## [Unreleased]

### Fixed

- **macOS Apple Silicon downloads contain an Apple Silicon build.** In 0.1.0-beta.2, `BetterC0de-0.1.0-beta.2-arm64-mac.zip` and `BetterC0de-0.1.0-beta.2-arm64.dmg` contain the Intel (x86_64) app. The target configuration overrode the build's architecture flag, so each Mac build job packaged its one app under both architectures' names, and the Intel job's files are the ones that were published.
- **macOS update metadata lists both architectures.** `latest-mac.yml` was taken from whichever Mac job uploaded last; it is now merged from both, and every entry is checked against the published file's sha512 before release.
- **Start-up failures explain themselves.** When the background service cannot start, the dialog shows the lines the service printed and what to do (reinstall the matching build, rebuild native modules, free disk space, fix folder permissions), instead of only "Failed to start backend: Node backend exited (code=1 signal=none)".
- **Building from a symlinked directory.** `npm run build:backend` refused a checkout reached through a symlink, such as one under macOS `/tmp` or a linked home directory. Symlinks inside the workspace are still refused.
- **Phone app dependencies.** Two versions of `react-native-gesture-handler` (2.31 and 3.1) were installed side by side, so the app linked one native version and could bundle the JavaScript of the other. The monorepo now resolves a single 2.31.x.
- **Remote access documentation.** It described a separate switch for file access, which does not exist: a full session can read and change files, and only the terminal needs **Allow terminal from remote devices**. `.env.example` listed the BetterC0de provider's server login under remote access.
- **Windows installer checksum.** The installer is named `BetterC0de-Setup-<version>.exe` locally, in the release and in the checksum file. The checksum file used to list a name with spaces that did not exist in the release.
- **Phone app: all chats.** The chat list stopped at the newest 100 chats; it now loads older ones on request. Long chats load 200 messages at a time, with earlier messages on request.
- **Phone app: screens no longer jump back every minute.** The periodic session check replaced the pairing whenever the desktop updated the device's last-seen time, which sent the file browser back to the project root and reloaded the open chat.
- **Phone app: Stop stops the agent that is running.** It used to target the model chosen in the picker, or OpenAI, instead of the provider running the turn.
- **Phone app: Remote Access turned off on the desktop.** The app deleted its pairing and called it expired. It now says that Remote Access is off, keeps the pairing, and asks to pair again only when the desktop reports that it signed the phone out.
- **Phone app: read-only sessions.** A session that may only watch offered to send and approve, then failed with HTTP 403. It now shows chats and pending approvals without the controls, and says why.
- **Phone app: errors are shown.** A chat that failed to load read "Ready for first prompt", Projects showed an empty list, and the file viewer spun forever; each now shows the error and a retry. Binary files are no longer shown as text.
- **Phone app: signing out.** When the desktop could not be reached, signing out forgot the pairing on the phone and left the session active on the desktop. The app now keeps the pairing and offers to forget it on the phone only.
- **Phone app: smaller fixes.** File search keeps the desktop's ranking. A reply ends when its own turn ends, not by comparing the phone's clock with the desktop's. After a reconnect the app checks the session at once instead of keeping the composer disabled for up to a minute.

### Added

- `npm run release:check`: one command from a clean `npm ci` through lint, type-checks, all test suites, the production build, packaging, a launch of the packaged app, the installers, and an install → launch → uninstall test of the installers on a clean machine.
- `npm run mobile:check`, part of the `release:check` build step: checks the phone app's configuration (identifiers, versions, network policy, Android ABIs), that its native dependencies match the Expo SDK without duplicates, and that the Android, iOS and web bundles build.
- The phone app has its own icons and splash screen, rendered from the desktop logo (`npm run mobile:icons`).
- The desktop describes its protocol to paired devices (version, the oldest phone app it serves, and what it offers the device) in the bootstrap, pairing and WebSocket responses, and asks a phone app that is too old to update instead of failing with "Invalid backend response". **Paired devices** shows which app and version each phone runs.
- Every refusal a paired device can receive names a `code` (see "Phone app and desktop versions" in `docs/remote-access.md`).
- `GET /api/v1/threads/:id` returns one chat with its session state, also to read-only sessions.
- The phone app has a demo mode (**Try the demo** on the pairing screen, or `betterc0de://demo`): sample projects, chats and files, and a reply that streams and asks for approval, without a desktop and without network access.
- The phone app shows **Update BetterC0de Remote** when the desktop needs a newer app, or asks to update the desktop when it is too old for the app, and keeps the pairing for after the update. Its connection badge distinguishes live, connecting, reconnecting, offline, Remote Access off, watch-only and demo.
- **Paired devices** on the desktop shows the phone's model (for example "Pixel 9"), instead of "iPhone" or "Android" for every device.
- Screen tests for the phone app (Jest with Expo's preset and React Native Testing Library), and `npm run test:e2e:remote`, which runs the app's network client against a real desktop backend and checks that the demo answers like a real desktop. Both are part of `release:check`.
- The phone app is built and tested as users get it. `npm run mobile:apk` builds the Android APK and checks it: the signer, version, SDK levels and permissions, native libraries that load on 16 KB page devices, and the size. It then runs device tests on an emulator: the pairing screen and the demo from start to exit, driven by Maestro. `npm run mobile:ios:sim` builds the iOS app for the simulator on a Mac and runs the same tests. `release:check` runs both where their toolchain is installed (`--mobile`), and CI runs both on every push. See `docs/development/mobile.md`.
- Releases can carry the phone app: `BetterC0de-Remote-<version>.apk`, signed with the release key and checked by the release assembly against the pinned certificate, and a TestFlight build that EAS starts once the release is published. It is switched on once the keys and accounts are set up (`docs/release-checklist.md` → The phone app); until then releases carry the desktop only.
- `/api/v1/workspace/read` returns the file's SHA-256, size and whether it is valid UTF-8; `/api/v1/workspace/write` accepts `expectedSha256` and refuses to overwrite a file that changed since it was read.
- CI runs `release:check` on Linux x64, Windows x64, macOS arm64 and macOS x64 for every push and pull request, and the source checks on Node 24.
- The Linux `.deb` is installed with apt and started with the Chromium sandbox on in CI; the `.rpm` is installed in a clean Fedora container.
- A pre-push hook runs `release:check` before a release tag is pushed.
- Documentation of the unsigned-release policy and what users see (`docs/development/code-signing.md`), and this changelog.

### Changed

- Releases are published only after every platform passed, from one verified set of files. A failed platform no longer leaves a partial release behind.
- Releases carry a single `SHA256SUMS.txt` instead of one checksum file per platform.
- Releases are unsigned by decision; the Release workflow no longer passes signing secrets.
- Node.js 22.23.2 is the pinned build toolchain (`.nvmrc`). Supported for development: Node 22.15+ and Node 24.
- The phone app (BetterC0de Remote) carries the desktop's version and is released with it. iOS builds are numbered `X.Y.Z`, because the App Store accepts no prerelease suffix; Android builds get a version code that grows with every release, prereleases included.
- The phone app's native projects are generated from `apps/mobile/app.config.ts` with the SDK 56 template pinned (`npm run mobile:prebuild`); `expo` 56.0.16 bundles the next SDK's template. Android release builds must be signed with a key from the environment and fail without one, instead of falling back to the template's debug key.
- The iOS app's network policy names what it needs, local networking and Tailscale `ts.net` host names, instead of allowing arbitrary plain-HTTP loads, a setting iOS ignores when local networking is also allowed. Its permission prompts are in English.
- A local `npm run build:mac` builds only for the architecture of the Mac it runs on, like the CI jobs. It used to also emit the other architecture's file names from the same app.
- The phone app's interface is in English throughout; it mixed in German labels and German date formats. Dates and file sizes follow the device's locale.
- The Android app asks only for the camera (to scan the pairing QR code), network access and vibration. The storage, "display over other apps" and biometric permissions that the React Native template and a library declared are removed; the app uses none of them.

## [0.1.0-beta.2] - 2026-09-22

### Known issues

- The macOS **arm64** downloads contain the Intel build (see Unreleased → Fixed). Apple Silicon Macs run it through Rosetta 2; macOS offers to install Rosetta on first launch if it is missing.
- `SHA256SUMS-macOS-arm64.txt` does not match the published arm64 files, and `SHA256SUMS-Windows-x64.txt` lists the installer as `BetterC0de Setup 0.1.0-beta.2.exe` while the download is named `BetterC0de-Setup-0.1.0-beta.2.exe`.
- No `.deb`, `.rpm`, `latest-linux.yml` or Linux checksum file was published, because the Linux release job failed. The AppImage and `.tar.gz` are available.
- All builds are unsigned. See [code signing](docs/development/code-signing.md) for what users see and how to get past it.
