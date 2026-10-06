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
- Provider API keys use an ordered list inside the existing settings section. Priority controls are labeled buttons usable by keyboard; status has visible text, stored secrets stay blank in replacement fields, and the add form stacks at narrow widths.
- Keep panes usable at narrow widths and when text is scaled. Long paths, code, and translated strings should wrap or scroll inside their panel.
- Project file trees load directories on demand. Label their badge as loaded entries and put a keyboard-accessible **Load more files** button inside any folder with another page, including the workspace root. Keep existing rows visible during refresh and show genuine read failures locally; normal lazy loading does not need a warning banner.
- The reasoning picker uses an ascending four-stroke icon that reflects the selected effort: 24px in the picker header and 20px in the menu row. Its compact header centres the active level above the current model name, with the icon on the left and an accessible reset button on the right. Below it, a rounded pill track uses evenly spaced stops and a prominent circular thumb. The level name, icon, and track fill share fixed effort identities: High orange, Extra High red, Max blue, and Ultra/UltraThink/Ultracode purple. `reasoning-appearance.ts` centralizes these accents with darker light-mode and brighter dark-mode variants; system and imported themes use their resolved mode. These requested level identities are the fixed-color exception; menu surfaces, inactive tracks, thumb, and focus still use semantic theme tokens. Other levels use the theme primary color. Keep the level explanation available to assistive technology and on hover. Retain click/drag/arrow-key selection, use only model-supported levels, let Escape dismiss the menu, and keep feedback reduced-motion-aware.
- Keep reasoning previews local during a drag and visible after release until the persisted selection arrives. Reconcile external selections without remounting the focused control, and reset previews when the thread, provider, model, or available levels change. Runtime effort descriptors determine the full ladder; boolean-only Thinking capabilities show Off/On. A selectable level must remain selected after preference reconciliation.
- Orchestration has its own connected-node (`Waypoints`) icon immediately before the permissions control in both composer layouts. Its active state uses the theme primary color and an accessible On/Off label. Its compact 300px panel and provider/model flyouts reuse `DropdownMenu`, `DropdownMenuSub`, and `DropdownMenuCheckboxItem` from the shared UI. Retain the small main-model row, thin connection rail, provider logos, selected-model previews, and counts. Thinking reuses the chat's `ThinkingEffortSlider` and `ReasoningLevelIcon` inside a shared submenu, including effort colors; Auto stores the provider default, and explicit selections retain advertised IDs. The composer summary reuses `AvatarGroup` with overlapping 28px pill-shaped `Badge` entries. Keep each logo and model name visible with enough end padding for the 8px overlap, opaque theme surfaces, and background rings. Hover and keyboard focus raise the active entry above its neighbors without moving the stack. Show thinking only in the shared `Tooltip`, with the colored `ReasoningLevelIcon` and level label; Escape dismisses it. Wrap the stack in narrow panes, retain visible focus, and honor reduced motion. Resolve names against the selected account; retain missing model IDs and show Auto for provider defaults. Do not add native selects or separate checkbox lists. Keep flyouts within the available viewport, preserve unavailable selections until edited, and show loading, save errors, and locked states. Editing is locked during a turn and for worker chats. Menu arrow keys reach the thinking trigger, ArrowRight enters its slider, and Escape dismisses the menu chain and restores the toolbar trigger's focus.
- In the Agent workspace panel, the Browser Preview splits its toolbar into two rows at the panel's narrow width. Its element inspector replaces the visible page while open, so the page is not squeezed beside a fixed-width inspector.
- The Usage overview keeps its compact shared dropdown, inset card surfaces (`bg-foreground/[0.02]` with `border-border/40`), and existing typography. Claude Code and Codex use the shared provider logos. Limit cards have accessible meters and text status; local usage drivers fill the section below. Charts inherit the theme's primary color. Container queries stack content in narrow panes, motion respects the appearance settings, and refreshing keeps existing reports visible.
- Lifetime statistics use a muted icon beside each label, with left-aligned values and supporting text. Usage drivers share a window header and divided columns with icons, prominent percentages, and independent proportional bars. Ranked skills/subagents sit in a separate footer row; keep the caveat that these characteristics overlap, not a summed breakdown.
- Usage detail rows pair labels with small, muted icons: incoming/outgoing tokens, cache reads/writes, and activity insights. Claude model rows and the CLI selector use the bundled Claude mark in its original colors. Coverage notes share one footer surface with highlighted dates and a local-source caption; retain the full caveats in every theme.
- API cost estimates occupy a full-width Usage section above the detail columns. A prominent total is explicitly labeled as a comparison, with token coverage, four cost cards, and pricing caveats alongside missing-model rates. Use the same inset surfaces and semantic primary color for proportional bars; container queries stack the summary and cards in narrow panes. Always identify custom rates when present and show missing-rate guidance when no estimate is available.
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
