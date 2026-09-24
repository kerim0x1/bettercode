# Code signing: the desktop is unsigned, the phone app is signed

[Develop BetterC0de](README.md) · [Release checklist](../release-checklist.md)

The BetterC0de desktop app is published **without code signing, by decision**. No certificates or notarization credentials are used for it. Downloads can be verified against the release's `SHA256SUMS.txt` instead (see [INSTALL.md](../../INSTALL.md#use-the-desktop-installer)).

The phone app is the exception, because Android and iOS install nothing unsigned. See [The phone app is signed](#the-phone-app-is-signed).

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

## The phone app is signed

- **Android.** The APK is signed with the BetterC0de release key. It is a PKCS12 keystore that exists only outside the repository: the maintainer's backups, plus the `release` environment's secrets for the Release workflow. Its certificate is pinned in `apps/mobile/signing/android-release.json`. The build (`scripts/mobile-android.mjs verify`) and the release assembly both refuse an APK with any other certificate, and a release build without a key fails instead of falling back to the template's public debug key. CI builds use a throwaway key per run and can never be published. Setup and backups: [mobile.md → Signing keys](mobile.md#signing-keys).
- **Losing the key** means installed apps can never be updated. Users would have to uninstall and install a build signed with a new key, and pair again. Keep two backups, and test restoring them with `keytool -list`.
- **Replacing the key** (for example after a leak) goes the same way. APK Signature Scheme v3 can rotate to a new key with a proof signed by the old one (`apksigner rotate`), which spares users the reinstall. That needs the old key, and the release scripts do not do it yet.
- **Android developer verification.** From 2027, certified Android devices install apps only from verified developers, and some countries already require it since September 2026. The account, the package name `com.betterc0de.remote` and the release certificate have to be registered in the Android Developer Console before then.
- **iOS.** EAS keeps the distribution certificate and provisioning profile and signs the TestFlight build. The workflow authenticates with `EXPO_TOKEN`, and submissions use an App Store Connect API key stored in EAS. The simulator builds in CI are unsigned.
