# Code signing: releases are unsigned

[Develop BetterC0de](README.md) · [Release checklist](../release-checklist.md)

BetterC0de releases are published **without code signing, by decision**. No certificates, notarization credentials or signing secrets are used: the Release workflow needs only the automatic `GITHUB_TOKEN`. Downloads can be verified against the release's `SHA256SUMS.txt` instead (see [INSTALL.md](../../INSTALL.md#use-the-desktop-installer)).

## What users see

| Platform | First launch | Updates |
| --- | --- | --- |
| Windows | SmartScreen shows "Windows protected your PC": **More info → Run anyway**. | The app skips its update check on unsigned builds (`scheduleUpdateCheck` in `apps/shell/main.cjs`). Users install a newer version by running its installer. |
| macOS | Gatekeeper blocks the first launch: **System Settings → Privacy & Security → Open Anyway**. If macOS reports the app as damaged (Apple Silicon, downloaded copy), run `xattr -dr com.apple.quarantine /Applications/BetterC0de.app`. Since macOS 15, Control-click → Open no longer bypasses the check. | Squirrel.Mac, which electron-updater uses, only installs signed updates. Users update by installing the new disk image. |
| Linux | Nothing: Linux does not require signed packages. | The AppImage can update itself; `.deb`, `.rpm` and tarball users install the new package. |

README.md and INSTALL.md give users these steps.

## How the pipeline treats it

- `release:check`'s installer smoke records the signing state on every run ("not Authenticode-signed, as intended", "Gatekeeper rejects the unsigned build, as expected") without failing or raising CI warnings. It still launches the installed app on every platform, so an unsigned build that would not start is caught.
- On macOS, electron-builder skips signing when no identity is available. The Electron binaries keep their linker signatures, so the app runs on Apple Silicon, but the bundle has no valid seal; that is why a quarantined download can be reported as "damaged".
- `scripts/pack-electron.cjs` records `betterc0deCodeSigned: false` in the packaged `package.json`, which is how the Windows app knows to skip its update check.

## Dormant tooling

The repository still contains signing support from earlier work. Nothing in CI uses it, and nothing needs to be configured:

- `npm run build:mac:signed` with a git-ignored `.env.signing`, and the notarization hook `apps/shell/build/notarize.cjs`, which does nothing without `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
- electron-builder's standard `CSC_LINK`/`WIN_CSC_LINK` variables. If they were ever set, the installer smoke would fail on an invalid signature rather than let a half-configured signing setup through.

If the decision changes, these are the starting points. The Release workflow would also need the secrets passed to its `release:check` step, scoped per platform, because electron-builder falls back from `WIN_CSC_LINK` to `CSC_LINK`.
