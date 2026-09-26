# BetterC0de UI and theme compatibility

This is the contribution contract for product UI. The [brand guide](../BRAND.md) covers the name, logo, marketing colors, and voice. Application colors come from theme tokens so a component works with every supported appearance.

## Start from the existing UI

- Desktop renderer: `apps/ui/src/components/ui` contains the shared Button, Dialog, Input, Select, Tabs, Tooltip, and other primitives. Reuse them and the established layout and settings components before adding a parallel control.
- Desktop typography and Tailwind aliases: `apps/ui/src/index.css`. The default UI face is Figtree Variable; code and terminal fonts are controlled by appearance settings.
- Desktop theme templates and user appearance settings: `apps/ui/src/lib/appearance-store.ts`. Theme mode is applied through `apps/ui/src/components/theme-provider.tsx`; the Appearance screen is `apps/ui/src/components/settings/appearance-section.tsx`.
- Imported VS Code/Cursor themes: `apps/ui/src/lib/vscode-theme.ts` maps workbench colors to the same tokens and separately supplies Monaco and Shiki colors. Keep that mapping complete when a shared token changes.
- Mobile: `apps/mobile/DESIGN.md` and `apps/mobile/src/design/theme.ts`. React Native uses its own named color values; it does not consume the desktop CSS variables.

## Use semantic tokens

| Need | Desktop class or variable | Example |
| --- | --- | --- |
| Main canvas and text | `bg-background text-foreground` | Main work area |
| Raised card or menu | `bg-card text-card-foreground`, `bg-popover text-popover-foreground` | Content card, popover |
| Quiet controls and copy | `bg-secondary`, `bg-muted`, `text-muted-foreground` | Secondary action, hint |
| Selected or hovered control | `bg-accent text-accent-foreground` | Active list row |
| Primary action | `bg-primary text-primary-foreground` | Main button |
| Border and focus | `border-border`, `ring-ring` | Input and keyboard focus |
| Error, success, warning | `text-destructive`, `text-success`, `text-warning` | Status with a text label or icon |
| Shell chrome | `bg-sidebar text-sidebar-foreground`, `border-sidebar-border` | Sidebar and title area |

Tailwind aliases such as `bg-background` resolve through `@theme inline` in `index.css`. Use CSS `var(--token)` in CSS files. Do not paste the brand guide's hex values, default-dark OKLCH values, or a light/dark-only Tailwind color into an ordinary component surface. Fixed colors are appropriate for content with its own color identity, such as a provider logo, syntax preview, chart series, or color picker; document why the exception is fixed and check its contrast in both modes.

The built-in `default-dark` and `white` templates are selectable. `grey` and `midnight` remain in the theme data, and users can import VS Code/Cursor themes. The `system` setting follows the OS and resolves to light or dark. Components should react to token changes without requiring a reload. Treat foreground/background token pairs as a unit so text remains legible when a theme changes.

For example, a new action inside a card can use the existing primitives and tokens:

```tsx
import { Button } from "@/components/ui/button"

function ReviewCard() {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-card-foreground">
      <p className="text-sm text-muted-foreground">Review changes before applying them.</p>
      <Button variant="secondary" size="sm">Review</Button>
    </div>
  )
}
```

## Layout and interaction

- Follow the nearby feature's density, spacing, radius, and icon treatment. Use the shared Button and Dialog variants instead of reproducing them with raw elements and custom colors.
- Preserve visible focus, keyboard operation, useful accessible names, and disabled/loading/error states. Status color must have a text or icon cue.
- Keep panes usable at narrow widths and when text is scaled. Long paths, code, and translated strings should wrap or scroll inside their panel.
- In the Agent workspace panel, the Browser Preview splits its toolbar into two rows at the panel's narrow width. Its element inspector replaces the visible page while open, so the page is not squeezed beside a fixed-width inspector.
- Honor the appearance setting for animations and the operating system's reduced-motion preference. Avoid decorative motion that obscures task progress.
- Keep mobile controls touch-friendly and follow its native navigation and offline states; do not copy desktop CSS values into React Native styles.

## Review matrix for visible changes

| Appearance | Inspect |
| --- | --- |
| Default Dark | Surfaces, borders, foreground text, focus, disabled states |
| White | The same states, especially contrast and shadows |
| System | Switching the OS mode updates the view without stale colors |
| Imported dark and light | No fixed-color island; editor, chat code, and workbench remain coherent |
| Mobile, when affected | Existing dark palette, touch targets, offline/error states |

Test the changed flow with keyboard and mouse, inspect narrow and scaled layouts, and include screenshots for visible UI changes. If a token or component contract changes, update `index.css`, `appearance-store.ts`, `vscode-theme.ts`, the relevant tests, and this page as needed. The [CI contract job](development/ci.md) catches missing or divergent workbench tokens; visual review remains necessary.
