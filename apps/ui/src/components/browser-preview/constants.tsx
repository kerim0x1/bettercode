// [REFACTOR] Extracted from browser-preview-panel.tsx — static constants for
// the browser preview's device bar, tree highlighting, and layout editor.
// Kept as .tsx because DEVICE_PRESETS carries JSX icon elements.

import type { ReactNode } from "react"
import { MonitorIcon, TabletIcon, SmartphoneIcon } from "lucide-react"

export interface DevicePreset {
  label: string
  /**
   * The page's viewport in CSS px, scaled down to fit the panel so its
   * breakpoints see the device and not the panel; null fills the panel.
   */
  size: { width: number; height: number } | null
  /** The device class the page's user agent claims. */
  agent: "desktop" | "tablet" | "mobile"
  icon: ReactNode
}

export const DEVICE_PRESETS: DevicePreset[] = [
  {
    label: "Desktop",
    size: null,
    agent: "desktop",
    icon: <MonitorIcon className="size-3.5" />,
  },
  {
    label: "Tablet",
    size: { width: 768, height: 1024 },
    agent: "tablet",
    icon: <TabletIcon className="size-3.5" />,
  },
  {
    label: "Mobile",
    size: { width: 375, height: 812 },
    agent: "mobile",
    icon: <SmartphoneIcon className="size-3.5" />,
  },
]

/**
 * A tablet or phone user agent on the app's own Chromium version, so sites
 * that choose their layout by user agent (search, shops, many CMS themes)
 * send that version. Desktop keeps the guest's default (null).
 */
export function deviceUserAgent(
  agent: DevicePreset["agent"],
  base: string = typeof navigator === "undefined" ? "" : navigator.userAgent
): string | null {
  if (agent === "desktop") return null
  const major = /Chrome\/(\d+)/.exec(base)?.[1] ?? "146"
  const chrome = `Chrome/${major}.0.0.0`
  return agent === "mobile"
    ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Mobile Safari/537.36`
    : `Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`
}

/**
 * Fixed-size artboard presets for the design-mode canvas. Unlike the browser's
 * DEVICE_PRESETS (Desktop fills the panel), artboards on an infinite canvas
 * need concrete pixel dimensions for every device.
 */
export interface CanvasDevicePreset {
  id: "desktop" | "tablet" | "mobile"
  label: string
  width: number
  height: number
  icon: ReactNode
}

export const CANVAS_DEVICE_PRESETS: CanvasDevicePreset[] = [
  {
    id: "desktop",
    label: "Desktop",
    width: 1440,
    height: 900,
    icon: <MonitorIcon className="size-3.5" />,
  },
  {
    id: "tablet",
    label: "Tablet",
    width: 768,
    height: 1024,
    icon: <TabletIcon className="size-3.5" />,
  },
  {
    id: "mobile",
    label: "Mobile",
    width: 375,
    height: 812,
    icon: <SmartphoneIcon className="size-3.5" />,
  },
]

/** Color classes used to tint tag names in the inspector tree. */
export const TAG_COLORS: Record<string, string> = {
  div: "text-blue-600 dark:text-blue-400",
  section: "text-blue-600 dark:text-blue-400",
  main: "text-blue-600 dark:text-blue-400",
  article: "text-blue-600 dark:text-blue-400",
  aside: "text-blue-600 dark:text-blue-400",
  nav: "text-blue-600 dark:text-blue-400",
  header: "text-blue-600 dark:text-blue-400",
  footer: "text-blue-600 dark:text-blue-400",
  h1: "text-purple-600 dark:text-purple-400",
  h2: "text-purple-600 dark:text-purple-400",
  h3: "text-purple-600 dark:text-purple-400",
  h4: "text-purple-600 dark:text-purple-400",
  h5: "text-purple-600 dark:text-purple-400",
  h6: "text-purple-600 dark:text-purple-400",
  p: "text-emerald-700 dark:text-emerald-400",
  span: "text-emerald-700 dark:text-emerald-400",
  a: "text-cyan-700 dark:text-cyan-400",
  ul: "text-orange-700 dark:text-orange-400",
  ol: "text-orange-700 dark:text-orange-400",
  li: "text-orange-700 dark:text-orange-400",
  img: "text-pink-600 dark:text-pink-400",
  svg: "text-pink-600 dark:text-pink-400",
  video: "text-pink-600 dark:text-pink-400",
  form: "text-yellow-700 dark:text-yellow-400",
  input: "text-yellow-700 dark:text-yellow-400",
  button: "text-yellow-700 dark:text-yellow-400",
  textarea: "text-yellow-700 dark:text-yellow-400",
  select: "text-yellow-700 dark:text-yellow-400",
}

/** Value options offered by the layout editor's Select controls. */
export const LAYOUT_OPTIONS = {
  display: [
    "block",
    "flex",
    "grid",
    "inline",
    "inline-block",
    "inline-flex",
    "inline-grid",
    "none",
  ],
  flexDirection: ["row", "row-reverse", "column", "column-reverse"],
  flexWrap: ["nowrap", "wrap", "wrap-reverse"],
  justifyContent: [
    "flex-start",
    "flex-end",
    "center",
    "space-between",
    "space-around",
    "space-evenly",
  ],
  alignItems: ["stretch", "flex-start", "flex-end", "center", "baseline"],
  position: ["static", "relative", "absolute", "fixed", "sticky"],
  overflow: ["visible", "hidden", "scroll", "auto"],
  gridTemplateColumns: [
    "1fr",
    "1fr 1fr",
    "1fr 1fr 1fr",
    "1fr 1fr 1fr 1fr",
    "repeat(auto-fill, minmax(200px, 1fr))",
  ],
  gridTemplateRows: ["auto", "1fr 1fr", "auto 1fr auto"],
}
