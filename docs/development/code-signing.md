# Code signing: macOS is signed and notarized, Windows is unsigned, the phone app is signed

[Develop BetterC0de](README.md) · [Release checklist](../release-checklist.md)

macOS opens a downloaded app without a warning only if it is signed with a **Developer ID Application** certificate and **notarized** by Apple. Otherwise Gatekeeper shows "Apple could not verify "BetterC0de" is free of malware that may harm your Mac or compromise your privacy" and refuses to open it until the user allows it in System Settings. The Release workflow signs, notarizes and staples the macOS app once [macOS signing is set up](#set-up-macos-signing). Until then, and on Windows and Linux, the desktop app is published unsigned, and downloads can be verified against the release's `SHA256SUMS.txt` (see [INSTALL.md](../../INSTALL.md#use-the-desktop-installer)).

The phone app is always signed, because Android and iOS install nothing unsigned. See [The phone app is signed](#the-phone-app-is-signed).

## What users see

| Platform | First launch | Updates |
| --- | --- | --- |
| macOS, signed and notarized release | Opens like any app from the internet; macOS asks once whether to open an app downloaded from the internet. | electron-updater (Squirrel.Mac) installs signed updates by itself. |
| macOS, unsigned release | "Apple could not verify …": **System Settings → Privacy & Security → Open Anyway**. If macOS reports the app as damaged (Apple Silicon, downloaded copy), run `xattr -dr com.apple.quarantine /Applications/BetterC0de.app`. Since macOS 15, Control-click → Open no longer bypasses the check. | The app skips its update check (`scheduleUpdateCheck` in `apps/shell/main.cjs`): Squirrel.Mac refuses unsigned updates. Users install the new disk image. |
| Windows | SmartScreen shows "Windows protected your PC": **More info → Run anyway**. | The app skips its update check on unsigned builds. Users install a newer version by running its installer. |
| Linux | Nothing: Linux does not require signed packages. | The AppImage can update itself; `.deb`, `.rpm` and tarball users install the new package. |

Moving from an unsigned to a signed macOS build is a one-time manual install of the new disk image: the unsigned app does not update itself. From then on, updates install automatically.

README.md and INSTALL.md give users these steps.

## How the pipeline treats it

- **electron-builder does the work.** With a certificate (`CSC_LINK` + `CSC_KEY_PASSWORD`) it signs every binary with the hardened runtime, the entitlements in `apps/shell/build/entitlements.mac.plist` and a secure timestamp, signs the disk image, and then notarizes the app with `notarytool` and staples the ticket, using the notarization credentials in the environment. There is no separate notarization hook; one would submit the app twice.
- **`scripts/macos-signing.mjs`** decides what a build will be. It accepts an App Store Connect API key (`APPLE_API_KEY` or `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; recommended) or an Apple ID with an app-specific password (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). A half configuration (a certificate without notarization, notarization without a certificate, an incomplete key, two methods at once) stops `release:check` in preflight. With `BETTERC0DE_MACOS_SIGNING=true`, missing credentials stop it too: a release that should be signed never falls back to an unsigned app.
- **The installer smoke checks the result** on every macOS run. For a signed build it requires a valid deep signature, a "Developer ID Application" authority from the team in `APPLE_TEAM_ID`, the bundle identifier, the hardened runtime, a secure timestamp, a stapled notarization ticket, Gatekeeper's verdict "Notarized Developer ID" for the installed app and for the auto-update archive, and a Developer ID signature on the disk image. For an unsigned build it records that Gatekeeper will warn, without failing.
- **`scripts/pack-electron.cjs`** records `betterc0deCodeSigned` in the packaged `package.json`. The app reads it to decide whether to check for updates.
- **Where the credentials live.** The Mac legs of `release:check` in the Release workflow attach the `macos-signing` environment, and only when the repository variable `BETTERC0DE_MACOS_SIGNING` is `true`. The secrets go only to the step that checks them and to the `release:check` step, and only on macOS (electron-builder would otherwise fall back from `WIN_CSC_LINK` to the Mac certificate on Windows). CI never signs.

## Set up macOS signing

Done once by the maintainer. Apple charges for the developer program; the rest is free.

1. **Join the Apple Developer Program** (developer.apple.com/programs) as an individual or organization. Note the **Team ID** (10 characters) under Membership details.
2. **Create a Developer ID Application certificate.** In Xcode: Settings → Accounts → your team → Manage Certificates → **+** → *Developer ID Application*. Or create a certificate signing request in Keychain Access and upload it at developer.apple.com → Certificates. Only the account holder can create Developer ID certificates.
3. **Export it as `.p12`.** In Keychain Access, under *My Certificates*, select "Developer ID Application: …" together with its private key → Export → `.p12`, with a strong password. Keep two offline backups; anyone with this file can sign apps as you.
4. **Create an App Store Connect API key** for notarization: App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → **+**, access *Developer*. Download `AuthKey_<KEY ID>.p8` (it can be downloaded only once) and note the **Key ID** and the **Issuer ID**.
5. **Create the GitHub environment.** Repository Settings → Environments → **New environment** `macos-signing`. Under *Deployment branches and tags*, allow only `main` and tags matching `v*`. Optionally require a reviewer.
6. **Add the environment secrets** (base64 without line breaks: `base64 -i file | tr -d '\n'`):

   | Secret | Value |
   | --- | --- |
   | `MACOS_CERTIFICATE_P12_BASE64` | the `.p12` from step 3, base64 |
   | `MACOS_CERTIFICATE_PASSWORD` | its export password |
   | `APPLE_API_KEY_P8_BASE64` | the `.p8` from step 4, base64 |
   | `APPLE_API_KEY_ID` | the Key ID |
   | `APPLE_API_ISSUER` | the Issuer ID |

   Add `APPLE_TEAM_ID` as an environment **variable** (it is not secret). To notarize with an Apple ID instead of an API key, set the secrets `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` (created at account.apple.com → Sign-In and Security → App-Specific Passwords) and leave the three API key secrets out.
7. **Switch it on:** Settings → Secrets and variables → Actions → Variables → repository variable `BETTERC0DE_MACOS_SIGNING` = `true`.
8. **Test it without publishing:** Actions → Release → *Run workflow* on `main`. Manual runs stop before publishing; the Mac legs must pass, and their log ends with "signed with Developer ID Application: …, notarized and stapled; Gatekeeper accepts it." Download the `installers-macos-*` artifact on a Mac, open the disk image and start the app: no warning should appear. `spctl -a -vv /Applications/BetterC0de.app` should print `source=Notarized Developer ID`.

From then on every release tag publishes signed and notarized macOS downloads, and the release fails instead of publishing an unsigned Mac build.

**Local signed build:** on a Mac, put the same values in the git-ignored `.env.signing` (`CSC_LINK=/path/to/cert.p12`, `CSC_KEY_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_API_KEY=/path/to/AuthKey_<id>.p8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) and run `npm run build:mac:signed`.

**Renewal and rotation.** A Developer ID certificate is valid for five years; apps signed and timestamped before it expires keep opening. Create the new certificate before the old one expires and replace the two certificate secrets. If the `.p12` or the API key leaks, see [SECURITY.md](../../SECURITY.md#if-a-signing-credential-leaks).

## Windows

The Windows installer stays unsigned. electron-builder's `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` would sign it; if they were ever set, the installer smoke would fail on an invalid signature rather than let a half-configured signing setup through. Signing Windows would also need the secrets passed to the Windows leg of the Release workflow.

## The phone app is signed

- **Android.** The APK is signed with the BetterC0de release key. It is a PKCS12 keystore that exists only outside the repository: the maintainer's backups, plus the `release` environment's secrets for the Release workflow. Its certificate is pinned in `apps/mobile/signing/android-release.json`. The build (`scripts/mobile-android.mjs verify`) and the release assembly both refuse an APK with any other certificate, and a release build without a key fails instead of falling back to the template's public debug key. CI builds use a throwaway key per run and can never be published. Setup and backups: [mobile.md → Signing keys](mobile.md#signing-keys).
- **Losing the key** means installed apps can never be updated. Users would have to uninstall and install a build signed with a new key, and pair again. Keep two backups, and test restoring them with `keytool -list`.
- **Replacing the key** (for example after a leak) goes the same way. APK Signature Scheme v3 can rotate to a new key with a proof signed by the old one (`apksigner rotate`), which spares users the reinstall. That needs the old key, and the release scripts do not do it yet.
- **Android developer verification.** From 2027, certified Android devices install apps only from verified developers, and some countries already require it since September 2026. The account, the package name `com.betterc0de.remote` and the release certificate have to be registered in the Android Developer Console before then.
- **iOS.** EAS keeps the distribution certificate and provisioning profile and signs the TestFlight build. The workflow authenticates with `EXPO_TOKEN`, and submissions use an App Store Connect API key stored in EAS. The simulator builds in CI are unsigned.
