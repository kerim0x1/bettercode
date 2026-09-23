# Release Checklist

BetterC0de releases are built from a `v<package-version>` tag by the Release workflow (`.github/workflows/release.yml`). The root app, all workspaces and `package-lock.json` must share the same version.

## Before tagging

1. Update the version in the root and workspace `package.json` files and in `package-lock.json`, then run `npm run check:versions`.
2. Move the `Unreleased` entries of [CHANGELOG.md](../CHANGELOG.md) under `## [<version>] - <date>`, including known issues and migrations. This section becomes the release notes, and the release is refused without it.
3. Review `npm audit --omit=dev` and record any accepted advisory in the changelog.
4. Make sure CI is green for the commit on `main`. CI runs `npm run release:check` on Linux x64, Windows x64, macOS arm64 and macOS x64.
5. On your machine, with a clean working tree on that commit:

   ```sh
   npm run release:check
   ```

   The pre-push hook runs it again when you push the tag.

## Tag and publish

1. `git tag v<version>` on the release commit, then `git push origin v<version>`. The hook refuses the push if the tag does not match `package.json`, is not the checked-out commit, the tree is dirty, the changelog section is missing, or `release:check` fails.
2. The Release workflow then:
   - checks that the tag, version and changelog agree
   - runs the full `release:check` on all four platforms; each job builds, launches, installs and uninstalls its installers
   - runs the source checks on Node 24
   - only if every job passed: assembles the release. It fails on duplicate file names, merges `latest-mac.yml`, checks every update-metadata entry against its file's sha512, requires every supported download and writes `SHA256SUMS.txt`. It then uploads everything to a draft, confirms every file arrived, and publishes the draft. Versions with a `-` (for example `0.2.0-beta.1`) are marked as prereleases.
3. If any job fails, nothing is published. Fix the problem, delete the tag locally and on GitHub, and tag again. An already-published release is never modified; release a new version instead.

## After publishing

1. Download and install one artifact on each supported operating system: Windows x64, macOS on Apple Silicon and on Intel, and a Debian/Ubuntu or Fedora machine.
2. Verify launch, provider discovery, one streamed turn, approval handling, resume, and update metadata. CI covers launch and install/uninstall on clean runners, but not provider logins or real-world machines.
3. Record rollback instructions and any verification gap in the release notes.

## What is not automated

- **Code signing.** Releases are unsigned by decision. See [code signing](development/code-signing.md) for what users see and how they get past the first-launch warnings.
- **Hardware coverage.** CI runs on GitHub-hosted runners: Ubuntu 24.04, Windows Server 2025, and macOS 15 on arm64 and Intel. Windows on ARM, Linux arm64, other distributions and older macOS versions are not tested.
