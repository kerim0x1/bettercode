import { create } from "zustand"
import type { ImportedTheme } from "@betterc0de/schema"
import {
  getCustomTheme,
  removeCustomTheme,
  writeCustomTheme,
} from "@/lib/custom-theme-cache"
import {
  buildAppliedCustomTheme,
  customTemplateId,
  customThemeIdOf,
  isCustomTemplateId,
} from "@/lib/vscode-theme"

// ── Theme Templates ──

export interface ThemeTemplate {
  id: string
  name: string
  mode: "dark" | "light"
  preview: { bg: string; sidebar: string; accent: string }
  vars: Record<string, string>
}

export const THEME_TEMPLATES: ThemeTemplate[] = [
  {
    id: "default-dark",
    name: "Default Dark",
    mode: "dark",
    preview: { bg: "#0f0f0f", sidebar: "#141414", accent: "#e8e8e8" },
    vars: {
      // #0F0F0F — the floating chat/main card surface (bg-background).
      "--background": "oklch(0.1684 0 0)",
      "--foreground": "oklch(0.985 0 0)",
      // #1F1F1F — composer / cards / menus sit slightly LIGHTER than the
      // #181818 surface (Codex-style), not darker.
      "--card": "oklch(0.2393 0 0)",
      "--card-foreground": "oklch(0.985 0 0)",
      "--popover": "oklch(0.2393 0 0)",
      "--popover-foreground": "oklch(0.985 0 0)",
      "--primary": "oklch(0.922 0 0)",
      "--primary-foreground": "oklch(0.205 0 0)",
      "--secondary": "oklch(0.269 0 0)",
      "--secondary-foreground": "oklch(0.985 0 0)",
      "--muted": "oklch(0.269 0 0)",
      "--muted-foreground": "oklch(0.708 0 0)",
      "--accent": "oklch(0.269 0 0)",
      "--accent-foreground": "oklch(0.985 0 0)",
      "--destructive": "oklch(0.704 0.191 22.216)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.556 0 0)",
      // #141414 — the Codex-style shell surround (titlebar, left sidebar,
      // gap behind the floating main card) all read from this token.
      "--sidebar": "oklch(0.1912 0 0)",
      "--sidebar-foreground": "oklch(0.985 0 0)",
      "--sidebar-primary": "oklch(0.488 0.243 264.376)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
      "--sidebar-accent": "oklch(0.269 0 0)",
      "--sidebar-accent-foreground": "oklch(0.985 0 0)",
      "--sidebar-border": "oklch(1 0 0 / 10%)",
    },
  },
  {
    id: "grey",
    name: "Grey",
    mode: "dark",
    preview: { bg: "#2d2d2d", sidebar: "#333333", accent: "#a0a0a0" },
    vars: {
      "--background": "oklch(0.24 0 0)",
      "--foreground": "oklch(0.92 0 0)",
      "--card": "oklch(0.28 0 0)",
      "--card-foreground": "oklch(0.92 0 0)",
      "--popover": "oklch(0.28 0 0)",
      "--popover-foreground": "oklch(0.92 0 0)",
      "--primary": "oklch(0.85 0 0)",
      "--primary-foreground": "oklch(0.2 0 0)",
      "--secondary": "oklch(0.32 0 0)",
      "--secondary-foreground": "oklch(0.92 0 0)",
      "--muted": "oklch(0.32 0 0)",
      "--muted-foreground": "oklch(0.65 0 0)",
      "--accent": "oklch(0.32 0 0)",
      "--accent-foreground": "oklch(0.92 0 0)",
      "--destructive": "oklch(0.65 0.2 25)",
      "--border": "oklch(1 0 0 / 12%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.5 0 0)",
      "--sidebar": "oklch(0.27 0 0)",
      "--sidebar-foreground": "oklch(0.92 0 0)",
      "--sidebar-primary": "oklch(0.85 0 0)",
      "--sidebar-primary-foreground": "oklch(0.2 0 0)",
      "--sidebar-accent": "oklch(0.32 0 0)",
      "--sidebar-accent-foreground": "oklch(0.92 0 0)",
      "--sidebar-border": "oklch(1 0 0 / 10%)",
    },
  },
  {
    id: "white",
    name: "White",
    mode: "light",
    preview: { bg: "#ffffff", sidebar: "#f8f8f8", accent: "#1a1a1a" },
    vars: {
      "--background": "oklch(1 0 0)",
      "--foreground": "oklch(0.145 0 0)",
      "--card": "oklch(1 0 0)",
      "--card-foreground": "oklch(0.145 0 0)",
      "--popover": "oklch(1 0 0)",
      "--popover-foreground": "oklch(0.145 0 0)",
      "--primary": "oklch(0.205 0 0)",
      "--primary-foreground": "oklch(0.985 0 0)",
      "--secondary": "oklch(0.97 0 0)",
      "--secondary-foreground": "oklch(0.205 0 0)",
      "--muted": "oklch(0.97 0 0)",
      "--muted-foreground": "oklch(0.556 0 0)",
      "--accent": "oklch(0.97 0 0)",
      "--accent-foreground": "oklch(0.205 0 0)",
      "--destructive": "oklch(0.577 0.245 27.325)",
      "--border": "oklch(0.922 0 0)",
      "--input": "oklch(0.922 0 0)",
      "--ring": "oklch(0.708 0 0)",
      "--sidebar": "oklch(0.985 0 0)",
      "--sidebar-foreground": "oklch(0.145 0 0)",
      "--sidebar-primary": "oklch(0.205 0 0)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
      "--sidebar-accent": "oklch(0.97 0 0)",
      "--sidebar-accent-foreground": "oklch(0.205 0 0)",
      "--sidebar-border": "oklch(0.922 0 0)",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    mode: "dark",
    preview: { bg: "#0d1117", sidebar: "#161b22", accent: "#3fb950" },
    vars: {
      "--background": "oklch(0.1 0.005 250)",
      "--foreground": "oklch(0.9 0 0)",
      "--card": "oklch(0.14 0.005 250)",
      "--card-foreground": "oklch(0.9 0 0)",
      "--popover": "oklch(0.14 0.005 250)",
      "--popover-foreground": "oklch(0.9 0 0)",
      "--primary": "oklch(0.7 0.17 145)",
      "--primary-foreground": "oklch(0.1 0 0)",
      "--secondary": "oklch(0.2 0.005 250)",
      "--secondary-foreground": "oklch(0.9 0 0)",
      "--muted": "oklch(0.2 0.005 250)",
      "--muted-foreground": "oklch(0.55 0 0)",
      "--accent": "oklch(0.2 0.01 250)",
      "--accent-foreground": "oklch(0.9 0 0)",
      "--destructive": "oklch(0.65 0.2 25)",
      "--border": "oklch(1 0 0 / 8%)",
      "--input": "oklch(1 0 0 / 10%)",
      "--ring": "oklch(0.7 0.17 145)",
      "--sidebar": "oklch(0.13 0.005 250)",
      "--sidebar-foreground": "oklch(0.9 0 0)",
      "--sidebar-primary": "oklch(0.7 0.17 145)",
      "--sidebar-primary-foreground": "oklch(0.1 0 0)",
      "--sidebar-accent": "oklch(0.18 0.005 250)",
      "--sidebar-accent-foreground": "oklch(0.9 0 0)",
      "--sidebar-border": "oklch(1 0 0 / 6%)",
    },
  },
]

const SELECTABLE_THEME_TEMPLATE_IDS = new Set(["default-dark", "white"])

export const SELECTABLE_THEME_TEMPLATES = THEME_TEMPLATES.filter((template) =>
  SELECTABLE_THEME_TEMPLATE_IDS.has(template.id)
)

/**
 * A template id is either a built-in selectable template or
 * `custom:<imported theme id>` — the latter only counts while the converted
 * theme is in the local cache, otherwise the default takes over rather than
 * leaving the app on a template nothing can apply.
 */
function normalizeSelectableTemplateId(templateId: string | undefined): string {
  if (templateId && SELECTABLE_THEME_TEMPLATE_IDS.has(templateId)) {
    return templateId
  }
  if (
    templateId &&
    isCustomTemplateId(templateId) &&
    getCustomTheme(customThemeIdOf(templateId))
  ) {
    return templateId
  }
  return DEFAULTS.template
}

/** Mode of the active template — built-in or imported. */
export function templateMode(templateId: string): "dark" | "light" | null {
  const builtIn = THEME_TEMPLATES.find((t) => t.id === templateId)
  if (builtIn) return builtIn.mode
  return getCustomTheme(customThemeIdOf(templateId))?.mode ?? null
}

export interface AppearanceState {
  // Theme template
  template: string

  // Colors
  hue: number
  intensity: number
  reduceTransparency: boolean
  themeModeLocked: boolean

  // Typography
  uiFontSize: number
  codeFontSize: number
  uiFontFamily: string
  codeFontFamily: string
  terminalFontFamily: string

  // Border radius
  radius: string

  // Layout
  chatMaxWidth: number // Chat container max-width in px (800-1600)
  chatScale: number // Chat UI scale factor (80-120%)
  messageFontSize: number // Message text size (12-20)
  sidebarWidth: number // Default sidebar width (200-400)
  compactMode: boolean // Reduce spacing between messages
  chatUiStyle: "extended" | "simple" // Prompt controls density/style
  // Left sidebar chat list layout: "folders" = project-grouped tree
  // (default), "cards" = flat task-card feed (provider avatar, branch,
  // status per row).
  chatSidebarLayout: "folders" | "cards"
  animationsEnabled: boolean
  fileContextEnabled: boolean
  sessionDirectoryFilterEnabled: boolean
  terminalTitleEnabled: boolean

  // UI sound effects
  uiSoundEnabled: boolean
  uiSoundTypingEnabled: boolean
  uiSoundClicksEnabled: boolean
  uiSoundKeyUpEnabled: boolean
  uiSoundKeyboardTheme: string
  uiSoundMouseTheme: string
  uiSoundVolume: number

  // Shadcn style
  style: "default" | "new-york"

  // Actions
  set: <K extends keyof AppearanceState>(
    key: K,
    value: AppearanceState[K]
  ) => void
  applyTemplate: (templateId: string) => void
  /** Convert an imported theme, cache it, and make it the active template. */
  activateCustomTheme: (theme: ImportedTheme) => void
  /** Drop a cached imported theme; falls back to the default if it was active. */
  forgetCustomTheme: (themeId: string) => void
  apply: () => void
  save: () => void
  load: () => void
  reset: () => void
  exportSettings: () => string
  importSettings: (json: string) => boolean
}

type AppearanceSnapshot = Omit<
  AppearanceState,
  | "set"
  | "applyTemplate"
  | "activateCustomTheme"
  | "forgetCustomTheme"
  | "apply"
  | "save"
  | "load"
  | "reset"
  | "exportSettings"
  | "importSettings"
>

const DEFAULTS: AppearanceSnapshot = {
  template: "default-dark",
  hue: 0,
  intensity: 0,
  reduceTransparency: false,
  themeModeLocked: false,
  uiFontSize: 16,
  codeFontSize: 13,
  uiFontFamily: "",
  codeFontFamily: "",
  terminalFontFamily: "",
  radius: "0.625",
  chatMaxWidth: 1200,
  chatScale: 100,
  messageFontSize: 14,
  sidebarWidth: 300,
  compactMode: false,
  chatUiStyle: "simple",
  chatSidebarLayout: "folders",
  animationsEnabled: true,
  fileContextEnabled: true,
  sessionDirectoryFilterEnabled: true,
  terminalTitleEnabled: true,
  uiSoundEnabled: false,
  uiSoundTypingEnabled: true,
  uiSoundClicksEnabled: true,
  uiSoundKeyUpEnabled: true,
  uiSoundKeyboardTheme: "nk-cream",
  uiSoundMouseTheme: "logi-g502",
  uiSoundVolume: 40,
  style: "default",
}

const STORAGE_KEY = "betterc0de-appearance"

/** Auto-save snapshot to localStorage (strips functions automatically) */
function saveSnapshot(snapshot: AppearanceSnapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    /* Expected: localStorage may be full or unavailable (incognito) */
  }
}

/** Extract pure data from store state (no functions) */
function toSnapshot(full: AppearanceState): AppearanceSnapshot {
  const {
    set: _,
    applyTemplate: _1,
    activateCustomTheme: _1a,
    forgetCustomTheme: _1b,
    apply: _2,
    save: _3,
    load: _4,
    reset: _5,
    exportSettings: _6,
    importSettings: _7,
    ...snap
  } = full
  return snap
}

function applyTemplate(templateId: string) {
  const builtIn = THEME_TEMPLATES.find((t) => t.id === templateId)
  const custom = builtIn ? null : getCustomTheme(customThemeIdOf(templateId))
  const tmpl = builtIn ?? custom
  if (!tmpl) return
  const root = document.documentElement

  // Set dark/light mode
  root.classList.remove("light", "dark")
  root.classList.add(tmpl.mode)
  localStorage.setItem("theme", tmpl.mode)

  // Apply all CSS vars. Built-in and imported themes set the same token set,
  // so switching between them never leaves a stale variable behind.
  for (const [key, value] of Object.entries(tmpl.vars)) {
    root.style.setProperty(key, value)
  }
  if (custom) {
    root.dataset.customTheme = custom.id
  } else {
    delete root.dataset.customTheme
  }
}

const DEFAULT_UI_FONT_STACK = '"Figtree Variable", sans-serif'
const DEFAULT_CODE_FONT_STACK =
  '"Fira Code", "Cascadia Code", Consolas, monospace'
const DEFAULT_TERMINAL_FONT_STACK =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace'

function fontFamilyStack(font: string, fallback: string): string {
  const value = font.trim()
  if (!value) return fallback
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return `"${escaped}", ${fallback}`
}

export function terminalFontStack(font: string): string {
  return fontFamilyStack(font, DEFAULT_TERMINAL_FONT_STACK)
}

function applyToDOM(state: AppearanceSnapshot) {
  const root = document.documentElement

  // Apply template first
  applyTemplate(state.template)

  // Border radius
  root.style.setProperty("--radius", `${state.radius}rem`)

  // Font sizes
  root.style.setProperty("--ui-font-size", `${state.uiFontSize}px`)
  root.style.setProperty("--code-font-size", `${state.codeFontSize}px`)
  root.style.fontSize = `${state.uiFontSize}px`

  // Font families — inject a <style> tag to override everything including inputs/textareas
  const uiFont = state.uiFontFamily
    ? fontFamilyStack(state.uiFontFamily, "sans-serif")
    : DEFAULT_UI_FONT_STACK
  const codeFont = state.codeFontFamily
    ? fontFamilyStack(state.codeFontFamily, "monospace")
    : DEFAULT_CODE_FONT_STACK
  const terminalFont = terminalFontStack(state.terminalFontFamily)

  root.style.setProperty("--font-sans", uiFont)
  root.style.setProperty("--font-mono", codeFont)
  root.style.setProperty("--terminal-font", terminalFont)

  // Inject/update dynamic style sheet for fonts — this catches all elements including future ones
  let sheet = document.getElementById("betterc0de-fonts") as HTMLStyleElement
  if (!sheet) {
    sheet = document.createElement("style")
    sheet.id = "betterc0de-fonts"
    document.head.appendChild(sheet)
  }
  sheet.textContent = `
    html, body, button, input, select, textarea, [data-slot] {
      font-family: ${uiFont} !important;
    }
    html { font-size: ${state.uiFontSize}px; }
    pre, code, .font-mono {
      font-family: ${codeFont} !important;
    }
    .betterc0de-terminal,
    .betterc0de-terminal input,
    .betterc0de-terminal pre,
    .betterc0de-terminal code,
    .betterc0de-terminal .font-mono {
      font-family: ${terminalFont} !important;
    }
  `

  // Hue tinting — applies oklch hue shift to primary/accent
  if (state.intensity > 0 && state.hue > 0) {
    const chroma = (state.intensity / 100) * 0.15
    root.style.setProperty("--primary", `oklch(0.205 ${chroma} ${state.hue})`)
    root.style.setProperty(
      "--ring",
      `oklch(0.708 ${chroma * 0.5} ${state.hue})`
    )
    // Dark mode overrides
    if (root.classList.contains("dark")) {
      root.style.setProperty("--primary", `oklch(0.922 ${chroma} ${state.hue})`)
      root.style.setProperty(
        "--sidebar-primary",
        `oklch(0.488 ${chroma * 1.5} ${state.hue})`
      )
    }
  } else {
    // Reset to defaults — let CSS handle it
    root.style.removeProperty("--primary")
    root.style.removeProperty("--ring")
    root.style.removeProperty("--sidebar-primary")
  }

  // Reduce transparency
  if (state.reduceTransparency) {
    root.classList.add("reduce-transparency")
  } else {
    root.classList.remove("reduce-transparency")
  }

  // Layout — chat width, scale, message font size, sidebar, compact mode
  root.style.setProperty("--chat-max-width", `${state.chatMaxWidth}px`)
  root.style.setProperty("--chat-scale", `${state.chatScale / 100}`)
  root.style.setProperty("--message-font-size", `${state.messageFontSize}px`)
  root.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`)

  if (state.compactMode) {
    root.classList.add("compact-mode")
  } else {
    root.classList.remove("compact-mode")
  }

  if (state.animationsEnabled) {
    root.classList.remove("animations-disabled")
  } else {
    root.classList.add("animations-disabled")
  }

  if (state.themeModeLocked) {
    root.classList.add("theme-mode-locked")
  } else {
    root.classList.remove("theme-mode-locked")
  }
}

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  ...DEFAULTS,

  applyTemplate: (templateId: string) => {
    const nextTemplate = normalizeSelectableTemplateId(templateId)
    set({ template: nextTemplate })
    applyTemplate(nextTemplate)
    const state = { ...get(), template: nextTemplate }
    applyToDOM(state)
    saveSnapshot(toSnapshot(state as AppearanceState))
  },

  activateCustomTheme: (theme) => {
    writeCustomTheme(buildAppliedCustomTheme(theme))
    get().applyTemplate(customTemplateId(theme.id))
  },

  forgetCustomTheme: (themeId) => {
    removeCustomTheme(themeId)
    if (get().template === customTemplateId(themeId)) {
      // Stay in the same light/dark mode instead of snapping to dark.
      const mode = templateMode(get().template)
      get().applyTemplate(mode === "light" ? "white" : DEFAULTS.template)
    }
  },

  set: (key, value) => {
    set({ [key]: value } as Pick<AppearanceState, typeof key>)
    const state = { ...get(), [key]: value }
    applyToDOM(state)
    saveSnapshot(toSnapshot(state as AppearanceState))
  },

  apply: () => {
    applyToDOM(toSnapshot(get() as AppearanceState))
  },

  save: () => {
    saveSnapshot(toSnapshot(get() as AppearanceState))
  },

  load: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        // Migrate users whose saved template was removed from the catalog
        // (e.g. "cursor-dark") to the current default so they don't end up
        // on a no-op template id that silently skips `applyTemplate`.
        parsed.template = normalizeSelectableTemplateId(parsed.template)
        // Extended UI mode is temporarily disabled — force every stored
        // preference back to simple regardless of what the user last had.
        // When extended lands again, remove this coercion.
        const merged = {
          ...DEFAULTS,
          ...parsed,
          chatUiStyle: "simple" as const,
        }
        set(merged)
        applyToDOM(merged)
      }
    } catch {
      console.warn("Failed to load appearance settings from localStorage")
    }
  },

  reset: () => {
    set(DEFAULTS)
    applyToDOM(DEFAULTS)
    localStorage.removeItem(STORAGE_KEY)
  },

  exportSettings: () => {
    return JSON.stringify(toSnapshot(get() as AppearanceState), null, 2)
  },

  importSettings: (json: string) => {
    try {
      const parsed = JSON.parse(json)
      const merged = {
        ...DEFAULTS,
        ...parsed,
        template: normalizeSelectableTemplateId(parsed.template),
      }
      set(merged)
      applyToDOM(merged)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
      return true
    } catch {
      return false
    }
  },
}))
