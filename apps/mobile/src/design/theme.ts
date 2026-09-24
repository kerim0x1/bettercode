import { Platform } from "react-native"

/**
 * Mobile adaptation of the desktop app's "Default Dark" theme (shadcn neutral scale,
 * see apps/ui/src/lib/appearance-store.ts). The legacy mint-terminal palette
 * was replaced: the accent is now the desktop's near-white primary, success
 * states use the same emerald as the desktop's check marks, and every surface
 * has a corresponding semantic role in the desktop theme.
 */
export const colors = {
  canvas: "#0A0A0A", // --background
  surface: "#171717", // --card / --sidebar
  surfaceRaised: "#1F1F1F", // hover tier between card and secondary
  surfaceActive: "#262626", // --secondary / --muted / --accent
  text: "#FAFAFA", // --foreground
  textSecondary: "#A3A3A3", // --muted-foreground
  textMuted: "#737373", // muted-foreground @ 70%
  primary: "#E5E5E5", // --primary (near-white)
  primaryForeground: "#171717", // --primary-foreground
  /** Legacy alias — now the desktop primary accent, no longer green. */
  mint: "#E5E5E5",
  mintMuted: "rgba(229,229,229,0.16)",
  success: "#10B981", // emerald-500 — check marks, live dots
  warning: "#FBBF24", // amber-400
  danger: "#F87171", // --destructive (dark)
  info: "#38BDF8",
  border: "rgba(255,255,255,0.10)", // --border
  borderStrong: "rgba(255,255,255,0.18)",
  input: "rgba(255,255,255,0.14)", // --input
  overlay: "rgba(0, 0, 0, 0.72)",
  transparent: "transparent",
} as const

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
} as const

/** Desktop radius scale: --radius is 10px, rounded-2xl ≈ 18, rounded-3xl ≈ 22. */
export const radius = {
  sm: 8,
  md: 10,
  lg: 14,
  xl: 18,
  xxl: 22,
  pill: 999,
} as const

export const type = {
  body: 16,
  small: 14,
  micro: 12,
  title: 22,
  hero: 32,
  lineHeight: 23,
  mono: Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "monospace",
  }),
} as const

/**
 * Figtree — the desktop app's UI font (--font-sans: "Figtree Variable").
 * Static weights loaded via @expo-google-fonts/figtree in the root layout;
 * use these family names instead of fontWeight (Android ignores fontWeight
 * on custom static fonts).
 */
export const font = {
  regular: "Figtree_400Regular",
  medium: "Figtree_500Medium",
  semibold: "Figtree_600SemiBold",
  bold: "Figtree_700Bold",
} as const

export const minTouchTarget = 44
