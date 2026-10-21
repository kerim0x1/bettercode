import { copyText } from "@/lib/clipboard"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { SettingsSection, SettingsRow } from "@/components/settings/atoms"
import { SettingsImportedThemesSection } from "@/components/settings/imported-themes-section"
import {
  SELECTABLE_THEME_TEMPLATES,
  useAppearanceStore,
} from "@/lib/appearance-store"
import {
  KEYBOARD_SOUND_THEMES,
  MOUSE_SOUND_THEMES,
  playUiSoundPreview,
} from "@/lib/ui-sound"
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
import { Volume2Icon } from "lucide-react"

export function SettingsAppearanceSection() {
  const a = useAppearanceStore()
  const [importJson, setImportJson] = useState("")
  const [showImport, setShowImport] = useState(false)

  return (
    <>
      {/* Theme Templates */}
      <SettingsSection title="Theme">
        <div className="grid grid-cols-5 gap-2 px-4 py-3">
          {SELECTABLE_THEME_TEMPLATES.map((tmpl) => (
            <button
              key={tmpl.id}
              type="button"
              onClick={() => a.applyTemplate(tmpl.id)}
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
        <SettingsRow
          label="Theme Mode Lock"
          description="Keep the selected light or dark mode pinned until you unlock it"
        >
          <Switch
            checked={a.themeModeLocked}
            onCheckedChange={(v) => a.set("themeModeLocked", v)}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsImportedThemesSection />

      <SettingsSection title="Colors">
        <SettingsRow label="Hue" description="Choose a tint color">
          <div className="flex w-[200px] items-center gap-2">
            <Slider
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
          label="Intensity"
          description="Control how strongly the tint is applied"
        >
          <div className="flex w-[200px] items-center gap-2">
            <Slider
              min={0}
              max={100}
              value={[a.intensity]}
              onValueChange={([v]) => a.set("intensity", v)}
              className="flex-1"
            />
            <span className="w-8 text-right text-xs text-muted-foreground">
              {a.intensity}%
            </span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Reduce transparency"
          description="Replace translucent surfaces with opaque backgrounds"
        >
          <Switch
            checked={a.reduceTransparency}
            onCheckedChange={(v) => a.set("reduceTransparency", v)}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Border Radius">
        <SettingsRow
          label="Radius"
          description="Border radius for all components"
        >
          <Select value={a.radius} onValueChange={(v) => a.set("radius", v)}>
            <SelectTrigger className="w-[200px]" size="sm">
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
          label="UI Font Size"
          description="Font size for the user interface"
        >
          <div className="flex items-center gap-0 rounded-lg border border-border">
            <button
              type="button"
              onClick={() =>
                a.set("uiFontSize", Math.max(11, a.uiFontSize - 1))
              }
              className="border-r border-border px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              −
            </button>
            <span className="min-w-[36px] px-3 py-1 text-center text-sm font-medium">
              {a.uiFontSize}
            </span>
            <button
              type="button"
              onClick={() =>
                a.set("uiFontSize", Math.min(18, a.uiFontSize + 1))
              }
              className="border-l border-border px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              +
            </button>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Code Font Size"
          description="Font size for code editors and diffs"
        >
          <div className="flex items-center gap-0 rounded-lg border border-border">
            <button
              type="button"
              onClick={() =>
                a.set("codeFontSize", Math.max(10, a.codeFontSize - 1))
              }
              className="border-r border-border px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              −
            </button>
            <span className="min-w-[36px] px-3 py-1 text-center text-sm font-medium">
              {a.codeFontSize}
            </span>
            <button
              type="button"
              onClick={() =>
                a.set("codeFontSize", Math.min(20, a.codeFontSize + 1))
              }
              className="border-l border-border px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              +
            </button>
          </div>
        </SettingsRow>
        <SettingsRow
          label="UI Font Family"
          description="Override the user interface typeface"
        >
          <Select
            value={a.uiFontFamily || "__system"}
            onValueChange={(v) =>
              a.set("uiFontFamily", v === "__system" ? "" : v)
            }
          >
            <SelectTrigger className="w-[200px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__system">System default</SelectItem>
              <SelectItem value="Figtree Variable">Figtree</SelectItem>
              <SelectItem value="Inter">Inter</SelectItem>
              <SelectItem value="Geist">Geist</SelectItem>
              <SelectItem value="SF Pro Display">SF Pro</SelectItem>
              <SelectItem value="Segoe UI">Segoe UI</SelectItem>
              <SelectItem value="Roboto">Roboto</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Code Font Family"
          description="Override the font for code editors"
        >
          <Select
            value={a.codeFontFamily || "__system"}
            onValueChange={(v) =>
              a.set("codeFontFamily", v === "__system" ? "" : v)
            }
          >
            <SelectTrigger className="w-[200px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__system">System monospace</SelectItem>
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
          label="Terminal Font Family"
          description="Override the font for integrated and Claude terminals"
        >
          <Select
            value={a.terminalFontFamily || "__system"}
            onValueChange={(v) =>
              a.set("terminalFontFamily", v === "__system" ? "" : v)
            }
          >
            <SelectTrigger className="w-[240px]" size="sm">
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
      </SettingsSection>

      <SettingsSection title="Chat Layout">
        <SettingsRow
          label="Chat UI Style"
          description="Extended mode is temporarily disabled — locked to Simple"
        >
          {/* Locked picker while Extended UI mode is temporarily disabled. */}
          <Select value="simple" disabled onValueChange={() => {}}>
            <SelectTrigger className="w-[200px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="simple">Simple</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Chat Width"
          description="Maximum width of the chat container"
        >
          <div className="flex w-[200px] items-center gap-2">
            <Slider
              min={800}
              max={1600}
              step={50}
              value={[a.chatMaxWidth]}
              onValueChange={([v]) => a.set("chatMaxWidth", v)}
              className="flex-1"
            />
            <span className="w-12 text-right text-xs text-muted-foreground">
              {a.chatMaxWidth}px
            </span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Chat Scale"
          description="Scale the entire chat interface"
        >
          <div className="flex w-[200px] items-center gap-2">
            <Slider
              min={80}
              max={120}
              step={5}
              value={[a.chatScale]}
              onValueChange={([v]) => a.set("chatScale", v)}
              className="flex-1"
            />
            <span className="w-10 text-right text-xs text-muted-foreground">
              {a.chatScale}%
            </span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Message Font Size"
          description="Font size for chat messages"
        >
          <div className="flex items-center gap-0 rounded-lg border border-border">
            <button
              type="button"
              onClick={() =>
                a.set("messageFontSize", Math.max(11, a.messageFontSize - 1))
              }
              className="border-r border-border px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              −
            </button>
            <span className="min-w-[36px] px-3 py-1 text-center text-sm font-medium">
              {a.messageFontSize}
            </span>
            <button
              type="button"
              onClick={() =>
                a.set("messageFontSize", Math.min(20, a.messageFontSize + 1))
              }
              className="border-l border-border px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              +
            </button>
          </div>
        </SettingsRow>
        <SettingsRow label="Sidebar Width" description="Default sidebar width">
          <div className="flex w-[200px] items-center gap-2">
            <Slider
              min={200}
              max={400}
              step={10}
              value={[a.sidebarWidth]}
              onValueChange={([v]) => a.set("sidebarWidth", v)}
              className="flex-1"
            />
            <span className="w-10 text-right text-xs text-muted-foreground">
              {a.sidebarWidth}px
            </span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Compact Mode"
          description="Reduce spacing between chat messages"
        >
          <Switch
            checked={a.compactMode}
            onCheckedChange={(v) => a.set("compactMode", v)}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="BetterC0de UI Toggles">
        <SettingsRow
          label="Animations"
          description="Allow interface animations and transitions"
        >
          <Switch
            checked={a.animationsEnabled}
            onCheckedChange={(v) => a.set("animationsEnabled", v)}
          />
        </SettingsRow>
        <SettingsRow
          label="File Context"
          description="Keep file-context features enabled for chat prompts"
        >
          <Switch
            checked={a.fileContextEnabled}
            onCheckedChange={(v) => a.set("fileContextEnabled", v)}
          />
        </SettingsRow>
        <SettingsRow
          label="Session Directory Filter"
          description="Scope thread cycling and pickers to the current workspace (the sidebar always shows all chats)"
        >
          <Switch
            checked={a.sessionDirectoryFilterEnabled}
            onCheckedChange={(v) => a.set("sessionDirectoryFilterEnabled", v)}
          />
        </SettingsRow>
        <SettingsRow
          label="Terminal Titles"
          description="Show shell titles in integrated terminal tabs"
        >
          <Switch
            checked={a.terminalTitleEnabled}
            onCheckedChange={(v) => a.set("terminalTitleEnabled", v)}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Sound Effects">
        <SettingsRow
          label="UI Sound Effects"
          description="Enable keyboard typing and click sounds"
        >
          <Switch
            checked={a.uiSoundEnabled}
            onCheckedChange={(v) => a.set("uiSoundEnabled", v)}
          />
        </SettingsRow>
        <SettingsRow
          label="Typing Sounds"
          description="Play keypress sounds while typing"
        >
          <Switch
            checked={a.uiSoundTypingEnabled}
            onCheckedChange={(v) => a.set("uiSoundTypingEnabled", v)}
            disabled={!a.uiSoundEnabled}
          />
        </SettingsRow>
        <SettingsRow
          label="Click Sounds"
          description="Play sounds for buttons, menus, and controls"
        >
          <Switch
            checked={a.uiSoundClicksEnabled}
            onCheckedChange={(v) => a.set("uiSoundClicksEnabled", v)}
            disabled={!a.uiSoundEnabled}
          />
        </SettingsRow>
        <SettingsRow
          label="Key-up Sounds"
          description="Play key release sounds when available"
        >
          <Switch
            checked={a.uiSoundKeyUpEnabled}
            onCheckedChange={(v) => a.set("uiSoundKeyUpEnabled", v)}
            disabled={!a.uiSoundEnabled || !a.uiSoundTypingEnabled}
          />
        </SettingsRow>
        <SettingsRow
          label="Keyboard Theme"
          description="Mechanical keyboard sound profile"
        >
          <Select
            value={a.uiSoundKeyboardTheme}
            onValueChange={(v) => a.set("uiSoundKeyboardTheme", v)}
          >
            <SelectTrigger
              className="w-[260px]"
              size="sm"
              disabled={!a.uiSoundEnabled}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[300px]">
              {KEYBOARD_SOUND_THEMES.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Click Theme"
          description="Mouse/click sound profile"
        >
          <Select
            value={a.uiSoundMouseTheme}
            onValueChange={(v) => a.set("uiSoundMouseTheme", v)}
          >
            <SelectTrigger
              className="w-[260px]"
              size="sm"
              disabled={!a.uiSoundEnabled}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MOUSE_SOUND_THEMES.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Volume"
          description="Master volume for all UI sounds"
        >
          <div className="flex w-[220px] items-center gap-2">
            <Slider
              min={0}
              max={100}
              value={[a.uiSoundVolume]}
              onValueChange={([v]) => a.set("uiSoundVolume", v)}
              className="flex-1"
              disabled={!a.uiSoundEnabled}
            />
            <span className="w-10 text-right text-xs text-muted-foreground">
              {a.uiSoundVolume}%
            </span>
          </div>
        </SettingsRow>
        <div className="px-4 pb-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!a.uiSoundEnabled}
            onClick={() => {
              playUiSoundPreview({
                keyboardThemeId: a.uiSoundKeyboardTheme,
                mouseThemeId: a.uiSoundMouseTheme,
                volume: a.uiSoundVolume,
              }).catch(() => {
                /* Expected: sound preview is best-effort */
              })
            }}
          >
            <Volume2Icon className="size-3.5" />
            Test Sound
          </Button>
        </div>
      </SettingsSection>

      {/* Save / Export / Import / Reset */}
      <div className="flex items-center gap-2 pt-2">
        <Button
          size="sm"
          onClick={() => {
            a.save()
          }}
        >
          Save
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            copyText(a.exportSettings())
          }}
        >
          Export
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowImport(!showImport)}
        >
          Import
        </Button>
        <div className="flex-1" />
        <Button variant="destructive" size="sm" onClick={() => a.reset()}>
          Reset
        </Button>
      </div>
      {showImport && (
        <div className="mt-2 space-y-2">
          <Textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder="Paste exported JSON here..."
            rows={3}
            className="rounded-lg font-mono text-xs"
          />
          <Button
            size="sm"
            onClick={() => {
              if (a.importSettings(importJson)) {
                setImportJson("")
                setShowImport(false)
              }
            }}
          >
            Apply Import
          </Button>
        </div>
      )}
    </>
  )
}
