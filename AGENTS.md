# Agent instructions for BetterC0de

Before editing this repository, read these files in order:

1. [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and review rules.
2. [docs/development/ci.md](docs/development/ci.md) and the [CI workflow](.github/workflows/ci.yml) for the checks that gate a change.
3. [BRAND.md](BRAND.md) for the product name, assets, and voice.
4. [docs/design-system.md](docs/design-system.md) for desktop UI components, tokens, and theme compatibility.
5. [apps/mobile/DESIGN.md](apps/mobile/DESIGN.md) when changing the phone app.

Read the relevant source files before changing a visual component. The desktop token definitions are `apps/ui/src/index.css` and `apps/ui/src/lib/appearance-store.ts`; imported themes are mapped in `apps/ui/src/lib/vscode-theme.ts`. Reuse primitives in `apps/ui/src/components/ui` and established feature components before adding a new pattern. The phone app uses `apps/mobile/src/design/theme.ts`.

Use semantic colors and existing components for new UI. Check light, dark, system, and imported themes where the change applies. Keep keyboard focus, readable contrast, and reduced-motion behavior. Update the design documentation when changing a token or shared visual pattern.

Follow the user's instructions about local verification. Report exactly which checks ran and which were left to CI. Do not claim that a build or platform check passed without its result.
