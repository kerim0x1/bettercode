import { copyText } from "@/lib/clipboard"
import { useState } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  SettingsSection,
  SettingsRow,
  SettingsStepper,
} from "@/components/settings/atoms"
import { SettingsImportedThemesSection } from "@/components/settings/imported-themes-section"
import {
  SELECTABLE_THEME_TEMPLATES,
  templateMode,
  useAppearanceStore,
} from "@/lib/appearance-store"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  BlendIcon,
  CaseSensitiveIcon,
  CodeXmlIcon,
  CopyIcon,
  DropletIcon,
  FileCodeIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  RotateCcwIcon,
  SparklesIcon,
  SquareTerminalIcon,
  SquircleIcon,
  SunIcon,
  SunMoonIcon,
  TagIcon,
  TypeIcon,
  UploadIcon,
} from "lucide-react"

type ThemeMode = "dark" | "light" | "system"

const THEME_MODES = [
  { id: "dark", label: "Dark", icon: MoonIcon },
  { id: "light", label: "Light", icon: SunIcon },
  { id: "system", label: "System", icon: MonitorIcon },
] as const

/** Older saves may still name the bundled default font explicitly. */
const DEFAULT_UI_FONT = "Figtree Variable"

/**
 * "Appearance": light, dark or system mode, the theme, imported themes,
 * colors, shape, typography and motion, plus export, import and reset.
 * Every change applies and saves at once. Layout sizes live under Layout,
 * message text under Chat and interface sounds under Notifications & Sound.
 */
export function SettingsAppearanceSection({
  theme,
  setTheme,
}: {
  theme: string | undefined
  setTheme: (theme: ThemeMode) => void
}) {
  const a = useAppearanceStore()
  const [importJson, setImportJson] = useState("")
  const [showImport, setShowImport] = useState(false)
  // System follows the OS; otherwise the active theme decides the mode.
  const activeMode: ThemeMode =
    theme === "system"
      ? "system"
      : (SELECTABLE_THEME_TEMPLATES.find((tmpl) => tmpl.id === a.template)
          ?.mode ?? (theme === "light" ? "light" : "dark"))

  // Import and reset can change the theme; keep the mode with it, unless it
  // follows the system.
  const syncModeWithTheme = () => {
    const mode = templateMode(useAppearanceStore.getState().template)
    if (mode && theme !== "system") setTheme(mode)
  }

  return (
    <>
      <SettingsSection title="Theme">
        <SettingsRow
          icon={<SunMoonIcon />}
          label="Mode"
          description="Dark, light, or follow the system setting."
        >
          <div
            role="radiogroup"
            aria-label="Color mode"
            className="flex items-center gap-0.5 rounded-[10px] border border-border/60 bg-card/70 p-[3px]"
          >
            {THEME_MODES.map((mode) => {
              const Icon = mode.icon
              const selected = activeMode === mode.id
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTheme(mode.id)}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
                    selected
                      ? "bg-primary/15 font-medium text-primary"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  <Icon className="size-3.5" />
                  {mode.label}
                </button>
              )
            })}
          </div>
        </SettingsRow>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2 px-4 py-3">
          {SELECTABLE_THEME_TEMPLATES.map((tmpl) => (
            <button
              key={tmpl.id}
              type="button"
              onClick={() => {
                a.applyTemplate(tmpl.id)
                // Keep the mode with the theme, unless it follows the system.
                if (theme !== "system") setTheme(tmpl.mode)
              }}
              className={cn(
                "flex flex-col items-center gap-2 rounded-xl border-2 p-3 transition-all hover:border-primary/50",
                a.template === tmpl.id
                  ? "border-primary bg-primary/5"
                  : "border-transparent hover:bg-muted/50"
              )}
            >
              {/* Color preview */}
              <div className="flex h-8 w-full gap-1 overflow-hidden rounded-lg">
                <div
                  className="flex-[3]"
                  style={{ background: tmpl.preview.bg }}
                />
                <div
                  className="flex-[1]"
                  style={{ background: tmpl.preview.sidebar }}
                />
                <div
                  className="w-1.5 rounded-full"
                  style={{ background: tmpl.preview.accent }}
                />
              </div>
              <span className="text-[10px] font-medium">{tmpl.name}</span>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsImportedThemesSection />

      <SettingsSection title="Colors">
        <SettingsRow
          icon={<PaletteIcon />}
          label="Hue"
          description={
            a.intensity > 0
              ? "Tint color for buttons, focus rings and other accents."
              : "Tint color for accents. Raise Intensity to see it."
          }
        >
          <div className="flex w-[240px] shrink-0 items-center gap-2">
            <Slider
              aria-label="Hue"
              min={0}
              max={360}
              value={[a.hue]}
              onValueChange={([v]) => a.set("hue", v)}
              className={cn(
                "flex-1",
                // Decorative hue spectrum (a color input, not a theme surface).
                "[&_[data-slot=slider-range]]:bg-transparent",
                "[&_[data-slot=slider-track]]:bg-gradient-to-r [&_[data-slot=slider-track]]:from-red-500 [&_[data-slot=slider-track]]:via-blue-500 [&_[data-slot=slider-track]]:via-cyan-500 [&_[data-slot=slider-track]]:via-green-500 [&_[data-slot=slider-track]]:via-purple-500 [&_[data-slot=slider-track]]:via-yellow-500 [&_[data-slot=slider-track]]:to-red-500"
              )}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          icon={<DropletIcon />}
          label="Intensity"
          description="How strongly the hue tints accents. 0 keeps the theme's own colors."
        >
          <div className="flex w-[240px] shrink-0 items-center gap-3">
            <Slider
              aria-label="Intensity"
              min={0}
              max={100}
              value={[a.intensity]}
              onValueChange={([v]) => a.set("intensity", v)}
              className="flex-1"
            />
            <span className="w-14 text-right text-[12.5px] text-muted-foreground tabular-nums">
              {a.intensity}%
            </span>
          </div>
        </SettingsRow>
        <SettingsRow
          icon={<BlendIcon />}
          label="Reduce Transparency"
          description="No blur behind menus and overlays, and solid borders in dark themes."
        >
          <Switch
            aria-label="Reduce Transparency"
            checked={a.reduceTransparency}
            onCheckedChange={(v) => a.set("reduceTransparency", v)}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Shape">
        <SettingsRow
          icon={<SquircleIcon />}
          label="Corner Radius"
          description="How round buttons, cards, inputs and menus are."
        >
          <Select value={a.radius} onValueChange={(v) => a.set("radius", v)}>
            <SelectTrigger
              aria-label="Corner Radius"
              className="w-[200px]"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="min-w-[200px]">
              <SelectItem value="0">None (0rem)</SelectItem>
              <SelectItem value="0.3">Small (0.3rem)</SelectItem>
              <SelectItem value="0.5">Medium (0.5rem)</SelectItem>
              <SelectItem value="0.625">Default (0.625rem)</SelectItem>
              <SelectItem value="0.75">Large (0.75rem)</SelectItem>
              <SelectItem value="1.0">Extra Large (1.0rem)</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Typography">
        <SettingsRow
          icon={<TypeIcon />}
          label="UI Font Size"
          description="Scales the whole interface. 16px is the default."
        >
          <SettingsStepper
            label="UI font size"
            value={a.uiFontSize}
            min={11}
            max={18}
            onChange={(value) => a.set("uiFontSize", value)}
          />
        </SettingsRow>
        <SettingsRow
          icon={<FileCodeIcon />}
          label="Code Font Size"
          description="Code editors and diffs. 13px is the default."
        >
          <SettingsStepper
            label="Code font size"
            value={a.codeFontSize}
            min={10}
            max={20}
            onChange={(value) => a.set("codeFontSize", value)}
          />
        </SettingsRow>
        <SettingsRow
          icon={<CaseSensitiveIcon />}
          label="UI Font"
          description="Typeface for the interface. Other fonts must be installed on this computer."
        >
          <Select
            value={
              a.uiFontFamily && a.uiFontFamily !== DEFAULT_UI_FONT
                ? a.uiFontFamily
                : "__system"
            }
            onValueChange={(v) =>
              a.set("uiFontFamily", v === "__system" ? "" : v)
            }
          >
            <SelectTrigger aria-label="UI Font" className="w-[200px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__system">Figtree (default)</SelectItem>
              <SelectItem value="Inter">Inter</SelectItem>
              <SelectItem value="Geist">Geist</SelectItem>
              <SelectItem value="SF Pro Display">SF Pro</SelectItem>
              <SelectItem value="Segoe UI">Segoe UI</SelectItem>
              <SelectItem value="Roboto">Roboto</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          icon={<CodeXmlIcon />}
          label="Code Font"
          description="Typeface for editors, diffs and code blocks."
        >
          <Select
            value={a.codeFontFamily || "__system"}
            onValueChange={(v) =>
              a.set("codeFontFamily", v === "__system" ? "" : v)
            }
          >
            <SelectTrigger
              aria-label="Code Font"
              className="w-[200px]"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__system">Default</SelectItem>
              <SelectItem value="Fira Code">Fira Code</SelectItem>
              <SelectItem value="JetBrains Mono">JetBrains Mono</SelectItem>
              <SelectItem value="Cascadia Code">Cascadia Code</SelectItem>
              <SelectItem value="SF Mono">SF Mono</SelectItem>
              <SelectItem value="Consolas">Consolas</SelectItem>
              <SelectItem value="Source Code Pro">Source Code Pro</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          icon={<SquareTerminalIcon />}
          label="Terminal Font"
          description="Typeface for terminal tabs. A Nerd Font shows prompt icons."
        >
          <Select
            value={a.terminalFontFamily || "__system"}
            onValueChange={(v) =>
              a.set("terminalFontFamily", v === "__system" ? "" : v)
            }
          >
            <SelectTrigger
              aria-label="Terminal Font"
              className="w-[240px]"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__system">Terminal default</SelectItem>
              <SelectItem value="JetBrainsMono Nerd Font Mono">
                JetBrainsMono Nerd Font
              </SelectItem>
              <SelectItem value="JetBrains Mono">JetBrains Mono</SelectItem>
              <SelectItem value="Fira Code">Fira Code</SelectItem>
              <SelectItem value="SF Mono">SF Mono</SelectItem>
              <SelectItem value="Cascadia Code">Cascadia Code</SelectItem>
              <SelectItem value="Source Code Pro">Source Code Pro</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          icon={<TagIcon />}
          label="Terminal Titles"
          description="Name terminal tabs after what the shell reports instead of “Terminal”."
        >
          <Switch
            aria-label="Terminal Titles"
            checked={a.terminalTitleEnabled}
            onCheckedChange={(v) => a.set("terminalTitleEnabled", v)}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Motion">
        <SettingsRow
          icon={<SparklesIcon />}
          label="Animations"
          description="Interface animations and transitions."
        >
          <Switch
            aria-label="Animations"
            checked={a.animationsEnabled}
            onCheckedChange={(v) => a.set("animationsEnabled", v)}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Backup"
        description="Changes save on their own. Move a look to another computer as JSON."
      >
        <SettingsRow
          icon={<CopyIcon />}
          label="Export"
          description="Copy theme, colors and fonts as JSON."
        >
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              if (await copyText(a.exportSettings())) {
                toast.success("Appearance copied as JSON")
              } else {
                toast.error("Couldn't copy to the clipboard")
              }
            }}
          >
            Copy JSON
          </Button>
        </SettingsRow>
        <SettingsRow
          icon={<UploadIcon />}
          label="Import"
          description="Paste JSON from Export to apply it here."
        >
          <Button
            variant="outline"
            size="sm"
            aria-expanded={showImport}
            onClick={() => setShowImport(!showImport)}
          >
            {showImport ? "Cancel" : "Paste JSON"}
          </Button>
          {/* A full-width item wraps under the row's text and button. */}
          {showImport && (
            <div className="basis-full space-y-2 pl-7">
              <Textarea
                aria-label="Appearance JSON"
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder='{ "template": "default-dark", … }'
                rows={4}
                className="rounded-lg font-mono text-xs"
              />
              <Button
                size="sm"
                disabled={!importJson.trim()}
                onClick={() => {
                  if (a.importSettings(importJson)) {
                    syncModeWithTheme()
                    setImportJson("")
                    setShowImport(false)
                    toast.success("Appearance imported")
                  } else {
                    toast.error("That isn't an appearance export", {
                      description:
                        "Paste the JSON that Export copied, without changes.",
                    })
                  }
                }}
              >
                Apply
              </Button>
            </div>
          )}
        </SettingsRow>
        <SettingsRow
          icon={<RotateCcwIcon />}
          label="Reset Appearance"
          description="Back to the default theme, colors, shape, fonts and message size."
        >
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              a.reset()
              syncModeWithTheme()
              toast.success("Appearance reset")
            }}
          >
            Reset
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  )
}
