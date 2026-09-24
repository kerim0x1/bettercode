# BetterC0de Remote — Mobile Design System

## Direction

The app is a focused command surface for a running BetterC0de desktop host,
not a miniature desktop IDE. Its visual language is adapted from the desktop
app's "Default Dark" theme (shadcn neutral scale) and the AI-Elements chat
design: near-black canvas, quiet white-alpha borders, a near-white primary
accent, and emerald reserved for success/live states. Information is dense
enough for developers while all interactive targets remain at least 44×44
points.

## Tokens

Source of truth for mobile values: `src/design/theme.ts`. The desktop reference is
`apps/ui/src/lib/appearance-store.ts` (Default Dark); mobile colors are an
adaptation rather than an exact rendering of the desktop's OKLCH tokens. See
the repository [UI and theme guide](../../docs/design-system.md) before changing
shared visual language.

- Canvas `#0A0A0A` (--background); surface `#171717` (--card/--sidebar);
  active surface `#262626` (--secondary/--muted).
- Primary text `#FAFAFA`; secondary `#A3A3A3` (--muted-foreground); muted
  `#737373`.
- Primary accent `#E5E5E5` with `#171717` foreground (desktop --primary);
  success `#10B981` (emerald, check marks and live dots); warning `#FBBF24`;
  danger `#F87171` (--destructive).
- Border `rgba(255,255,255,0.10)`; strong `rgba(255,255,255,0.18)`.
- Radii mirror the desktop scale (--radius 10): 8 / 10 / 14 / 18 / 22 / pill.
- Chat mirrors the desktop AI Elements: user turns are secondary-colored
  bubbles on the right, assistant turns are plain prose with a tiny meta row,
  reasoning and tool calls collapse into quiet "N Schritte"-style disclosure
  rows with a left-rail timeline.
- Spacing follows a 4-point scale; body text never drops below 16 points.
- Motion is restrained to opacity and transform feedback and respects reduced
  motion. Lists use native virtualization.

## Navigation

- Pairing is a dedicated pre-auth stack with scan, paste, and manual entry.
- The authenticated root has Chats, Projects, and Host tabs.
- Chat detail is a stack screen with message streaming and a persistent
  composer; its Files screen is always scoped to that chat's effective root.
- Every loading, empty, offline, and error state is explicit and recoverable.
