## What changed and why

Describe the problem and resulting behavior. Link related issues.

## Verification

List the checks you ran, their results, and any platform limitations. `npm run verify:source` covers most changes; run `npm run release:check` for packaging, Electron main-process, native-module or CI changes. CI runs `release:check` on Linux, Windows and both Mac architectures.

## Screenshots

For visible UI changes, include before/after screenshots when useful.

## Review checklist

- [ ] The change is focused and includes relevant tests or manual verification.
- [ ] Documentation reflects any changed behavior or setup, and user-visible changes have a line in `CHANGELOG.md` under `Unreleased`.
- [ ] No credentials, personal logs, generated bundles, or runtime data are included.
