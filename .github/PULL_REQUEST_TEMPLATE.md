## What changed and why

Describe the problem and resulting behavior. Link related issues.

## Verification

List the checks you ran, their results, and any platform limitations. `npm run verify:source` covers most changes; run `npm run release:check` for packaging, Electron main-process, native-module or CI changes. CI runs `release:check` on Linux, Windows and both Mac architectures.

## Screenshots

For visible UI changes, include before/after screenshots when useful.

## Review checklist

- [ ] I read [AGENTS.md](https://github.com/kerim0x1/bettercode/blob/main/AGENTS.md), including the [CI guide](https://github.com/kerim0x1/bettercode/blob/main/docs/development/ci.md) and [brand guide](https://github.com/kerim0x1/bettercode/blob/main/BRAND.md).
- [ ] If UI changed, I followed [docs/design-system.md](https://github.com/kerim0x1/bettercode/blob/main/docs/design-system.md), checked applicable light/dark/system/imported themes, and included screenshots or explained why they are unnecessary.
- [ ] The change is focused and includes relevant tests or manual verification.
- [ ] Documentation reflects any changed behavior or setup, and user-visible changes have a line in `CHANGELOG.md` under `Unreleased`.
- [ ] No credentials, personal logs, generated bundles, or runtime data are included.
