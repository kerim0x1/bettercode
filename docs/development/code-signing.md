# Code signing and notarization

[Develop BetterC0de](README.md) · [Release checklist](../release-checklist.md)

**Current state: every published BetterC0de build is unsigned.** The repository has no signing secrets configured, so the release workflow builds unsigned Windows and macOS installers. This page explains what that means for users, and what a maintainer has to provide to change it. The certificates and accounts cannot be created from the repository; they need a person with a legal identity and a payment method.

## What users see today

| Platform | Unsigned behaviour | Workaround users need |
| --- | --- | --- |
| Windows | SmartScreen shows "Windows protected your PC" on the installer. The app skips its update check (`scheduleUpdateCheck` in `apps/shell/main.cjs`), because an unsigned update would trigger the same warning on every update. | **More info → Run anyway.** Update by downloading and running the newer installer. |
| macOS | Gatekeeper blocks the first launch. On Apple Silicon a quarantined, unsigned app is reported as "damaged". Since macOS 15, Control-click → Open no longer bypasses the check. Squirrel.Mac, which electron-updater uses, only installs updates for signed apps. | **System Settings → Privacy & Security → Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/BetterC0de.app`. Update by downloading the new disk image. |
| Linux | Nothing: Linux does not require signed packages. | None. Users can verify downloads against `SHA256SUMS.txt`. |

The installer smoke test in `release:check` reports the signing state on every run. It warns while the build is unsigned, and it fails when credentials are configured but the result is wrong: on Windows, Authenticode signatures that are not `Valid`; on macOS, Gatekeeper rejecting a notarized app.

## macOS: Developer ID signing and notarization

Requirements:

1. A paid [Apple Developer Program](https://developer.apple.com/programs/) membership.
2. A **Developer ID Application** certificate, created in the Apple Developer portal or in Xcode and exported with its private key as a `.p12` file.
3. An [app-specific password](https://support.apple.com/102654) for the Apple Account that notarizes, and the 10-character Team ID.

The build is already set up for it. `package.json` enables the hardened runtime and entitlements (`apps/shell/build/entitlements.mac.plist`). The `afterSign` hook `apps/shell/build/notarize.cjs` notarizes with `notarytool` when all three Apple variables are set, and fails the build if notarization fails.

Add these repository secrets (**Settings → Secrets and variables → Actions**) or use the GitHub CLI:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | The `.p12` file, base64-encoded: `base64 -i DeveloperID.p12 \| gh secret set CSC_LINK` |
| `CSC_KEY_PASSWORD` | The `.p12` export password |
| `APPLE_ID` | The Apple Account email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password |
| `APPLE_TEAM_ID` | The Team ID |

The release workflow passes these only to the macOS jobs. For a local signed build on a Mac, put the same five values in a git-ignored `.env.signing` file in the repository root and run `npm run build:mac:signed`.

After the first signed release, check that `release:check` in the Release run reports "Gatekeeper accepts the app" for both architectures.

## Windows: Authenticode signing

Since June 2023 the CA/Browser Forum requires that the private keys of publicly trusted code-signing certificates live on hardware (a token or a cloud HSM). A new certificate therefore usually comes as a hardware token or a cloud signing service rather than a `.pfx` file. The options are:

- **A cloud signing service**, such as Azure Trusted Signing, DigiCert KeyLocker or SSL.com eSigner. electron-builder 26 supports Azure Trusted Signing through `build.win.azureSignOptions` (`publisherName`, `endpoint`, `certificateProfileName`, `codeSigningAccountName`), authenticating with the `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` environment variables. Other services plug in through a custom `build.win.signtoolOptions.sign` script.
- **An exportable `.pfx`**, if you still have one. Set `WIN_CSC_LINK` (base64 `.pfx`) and `WIN_CSC_KEY_PASSWORD` as repository secrets; the release workflow passes them only to the Windows job.

With a cloud signing service, two checks key off `WIN_CSC_LINK`/`CSC_LINK` and need extending:

1. `buildSigningMetadataArgs` in `scripts/pack-electron.cjs` decides whether a build counts as signed, which turns the in-app update check back on. Without the extension, a cloud-signed app keeps skipping updates.
2. The Windows part of `scripts/installer-smoke.mjs` runs `Get-AuthenticodeSignature` on the installer, the installed `BetterC0de.exe` and its uninstaller. It warns while they are unsigned and fails when a certificate is configured but a signature is not `Valid`. Its `certificateConfigured` condition must also recognise the cloud setup.

SmartScreen reputation builds up per certificate. A new OV certificate may still show warnings until enough users have installed signed builds.

## Linux

No signature is required. The `.deb` and `.rpm` are installed from a file, so repository signing does not apply. If BetterC0de is later distributed through an apt or dnf repository, that repository needs a GPG key, which again is a maintainer secret.

## Keeping secrets out of the repository

`.gitignore` excludes `.env.signing`, `*.p12`, `*.pfx`, `*.key`, `*.pem` and other credential files. Keep signing material in the CI secret store or on the signing machine only. The workflows never print secret values, and forks' pull requests do not receive secrets, so CI builds for pull requests are always unsigned.
