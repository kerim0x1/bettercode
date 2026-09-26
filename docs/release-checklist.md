# Release Checklist

BetterC0de releases are built from a `v<package-version>` tag by the Release workflow (`.github/workflows/release.yml`). After every successful CI run for the latest commit on `main`, Automatic release (`.github/workflows/automatic-release.yml`) prepares a tagged release commit. The protected `main` branch stays unchanged, so its development version may trail the latest release tag. On the tag, the root app, all workspaces and `package-lock.json` share the published version.

## Before merging

1. Record user-visible changes, known issues and migrations under `Unreleased` in [CHANGELOG.md](../CHANGELOG.md). These entries become public release notes.
2. Review `npm audit --omit=dev` for dependency changes and record any accepted advisory in the changelog.
3. Let the PR's CI complete before merging. CI also runs on the merge commit on `main` and must pass for an automatic release.
4. For packaging or installer changes, run the full gate locally where possible:

   ```sh
   npm run release:check
   ```

   If the task or environment limits local checks, report that gap and use CI results.

## Automatic tag and publish

1. Automatic release starts only after the `main` push CI succeeds. It checks that the verified commit is still the tip of `main`; if a newer merge arrived, that newer CI run handles the combined changes.
2. It increments the latest release tag (for example `0.1.0-beta.3` to `0.1.0-beta.4`), updates every workspace and the lockfile, and writes a dated release section. Entries already present in prior releases are omitted from the new notes, even though `main` retains its rolling `Unreleased` section. The tagged changelog carries forward the full release history. If a maintainer has already bumped to a newer untagged version, it uses that version. Empty new notes receive a maintenance entry.
3. It pushes the tag pointing to that versioned commit without writing to `main`, then dispatches Release on the tag. GitHub does not start workflows for tags pushed with `GITHUB_TOKEN`, so the explicit dispatch is required.
4. The Release workflow then:
   - checks that the tag, version and changelog agree
   - runs the full `release:check` on all four platforms; each job builds, launches, installs and uninstalls its installers
   - runs the source checks on Node 24
   - once the phone app is switched on (see [The phone app](#the-phone-app)): builds the APK with the release key and runs the device tests on that exact APK, and builds and tests the iOS app on a simulator
   - only if every job passed: assembles the release. It fails on duplicate file names, merges `latest-mac.yml`, checks every update-metadata entry against its file's sha512, requires every supported download (with the phone app: the APK, signed by the pinned release certificate) and writes `SHA256SUMS.txt`. It then uploads everything to a draft, confirms every file arrived, and publishes the draft. Versions with a `-` (for example `0.2.0-beta.1`) are marked as prereleases.
   - with the phone app: starts the iOS build on EAS, which submits it to TestFlight when it finishes. That can take hours on EAS's free plan; the job does not wait.
5. If any Release job fails, nothing is published. Rerun the tag's Release workflow for transient failures. If code must change, merge a fix and let Automatic release create a newer version; an already-published release is never modified.

## Recovery and manual release

- Check the **Automatic release** workflow after green `main` CI. A failed version, tag or dispatch step needs attention even though the preceding CI was green.
- If the tag was pushed but dispatch failed, run **Release** manually with that tag as the ref (or `gh workflow run release.yml --ref v<version>`). Do not create a second tag for the same version.
- To pause automatic releases deliberately, set the repository Actions variable `BETTERC0DE_AUTO_RELEASE` to `false` before the merge. Unset it or set it to `true` to resume.
- For a manual release while automation is paused, update all workspace versions and the lockfile, add a versioned changelog section, run `npm run check:versions` and `npm run release:check`, then tag the checked-out release commit with `git tag v<version>` and push the tag. The pre-push hook checks it again; Release repeats the full platform gate.

## After publishing

1. Download and install one artifact on each supported operating system: Windows x64, macOS on Apple Silicon and on Intel, and a Debian/Ubuntu or Fedora machine.
2. Verify launch, provider discovery, one streamed turn, approval handling, resume, and update metadata. CI covers launch and install/uninstall on clean runners, but not provider logins or real-world machines.
3. Record rollback instructions and any verification gap in the release notes.

## The phone app

BetterC0de Remote ships with the desktop release: the release carries `BetterC0de-Remote-<version>.apk`, and the same version goes to TestFlight. Until the steps below are done, the phone app's release jobs are skipped and releases carry the desktop only.

### Switching it on (once)

1. **Android release key.** Create it and pin its certificate as described in [Signing keys](development/mobile.md#signing-keys). Commit `apps/mobile/signing/android-release.json`. Keep the keystore and passwords backed up in two places: installed apps accept updates only from the same key.
2. **EAS project.** `npx eas-cli@24.7.0 login`, then `npx eas-cli@24.7.0 init` in `apps/mobile`. Put the project ID and owner it prints into `PUBLISHED_EAS_PROJECT_ID` and `PUBLISHED_EXPO_OWNER` in `apps/mobile/app.config.ts`, and commit.
3. **First iOS build, interactively.** `npx eas-cli@24.7.0 build --platform ios --profile production` in `apps/mobile`. After you sign in with your Apple ID, EAS creates the distribution certificate and provisioning profile and offers to create the App Store Connect app "BetterC0de Remote" (SKU `betterc0de-remote`). Then `npx eas-cli@24.7.0 submit --platform ios --latest`. Put the App Store Connect app ID (the number in its URL) into `submit.production.ios.ascAppId` in `apps/mobile/eas.json`, and commit.
4. **App Store Connect API key** (role App Manager) for non-interactive submissions: `npx eas-cli@24.7.0 credentials --platform ios` → App Store Connect API Key. Keep the `.p8` file offline; EAS stores the key.
5. **GitHub environment.** Settings → Environments → New environment `release`. Deployment branches and tags: selected, tag rule `v*`. Environment secrets:

   | Secret | Value |
   | --- | --- |
   | `ANDROID_KEYSTORE_BASE64` | the keystore as base64 (`base64 -w0 betterc0de-release.p12`, or PowerShell `[Convert]::ToBase64String([IO.File]::ReadAllBytes("betterc0de-release.p12"))`) |
   | `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | the keystore's password, alias and key password |
   | `EXPO_TOKEN` | an access token from expo.dev, preferably of a robot user |

6. **TestFlight.** In App Store Connect → TestFlight: fill in the test information (beta description, feedback email, the privacy policy URL, contact, and the review note "Pairing needs your own desktop computer; tap **Try the demo** on the first screen to use the app without one"). Create an internal group, then an external group "Public beta", submit the first build for Beta App Review, and turn on its public link.
7. **Privacy policy.** The website's privacy page has to describe the phone app before the Beta App Review.
8. **Switch it on.** Settings → Secrets and variables → Actions → Variables: `BETTERC0DE_MOBILE_RELEASE` = `true`.

After the first release that carries the app, add the APK and the TestFlight link to the download table in README.md and to INSTALL.md.

### Each release

- The Release workflow builds, tests and publishes the APK with the desktop, and starts the TestFlight build.
- When EAS has submitted the build (email from App Store Connect), add it to the "Public beta" group in App Store Connect. External builds need Beta App Review, which is usually quick for later builds.
- Install the APK over the previous version on a phone and check that it keeps its pairing.

### If a phone app job fails

The release is not published, like any failed platform. Rerun Release on the same tag for a transient failure. If the app or its device tests need a code change, merge the fix and let Automatic release create a new version. To release the desktop alone meanwhile, set `BETTERC0DE_MOBILE_RELEASE` to `false` for that tag's run and say so in the release notes.

## What is not automated

- **Code signing.** Desktop releases are unsigned by decision. See [code signing](development/code-signing.md) for what users see and how they get past the first-launch warnings. The phone app is signed; its keys are set up once (above).
- **TestFlight distribution.** Adding each build to the public group, and Beta App Review, happen in App Store Connect.
- **Hardware coverage.** CI runs on GitHub-hosted runners: Ubuntu 24.04, Windows Server 2025, and macOS 15 on arm64 and Intel. Windows on ARM, Linux arm64, other distributions and older macOS versions are not tested.
