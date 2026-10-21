/**
 * Settings as a page in the main area, like Usage: a header with the back
 * arrow, the section rail on the left and the active section on the right.
 *
 * Each tab renders a dedicated section component (see `./rules-section.tsx`,
 * `./skills-section.tsx`, etc.). The page itself owns only the shell
 * chrome (header, rail, scroll container, Getting Started + Keyboard
 * Shortcuts sub-dialogs, Reset confirmation). The active tab lives in the
 * app UI store, so "open Settings at Providers" also works while it is open.
 *
 * The page is a size container: on wider main areas its whole content
 * zooms up in steps (1.08 / 1.16 / 1.24), so text and controls keep a
 * comfortable size from a laptop to a 4K display.
 */

import { useState, useEffect } from "react"
import { ArrowLeftIcon, SearchIcon, SettingsIcon } from "lucide-react"
import { Tabs as TabsPrimitive } from "radix-ui"
import { useTheme } from "@/components/theme-provider"
import { useSettingsStore } from "@/lib/settings-store"
import { useAppearanceStore } from "@/lib/appearance-store"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { HugeiconsIcon } from "@hugeicons/react"
import { SettingsRulesSection } from "@/components/settings/rules-section"
import { SettingsSkillsSection } from "@/components/settings/skills-section"
import { SettingsMcpSection } from "@/components/settings/mcp-section"
import { SettingsCodeSearchSection } from "@/components/settings/code-search-section"
import { SettingsOrchestratorSection } from "@/components/settings/orchestrator-section"
import { SettingsHooksSection } from "@/components/settings/hooks-section"
import { SettingsPermissionsSection } from "@/components/settings/permission-rules-section"
import { SettingsProvidersSection } from "@/components/settings/providers-section"
import { SettingsModelVisibilitySection } from "@/components/settings/model-visibility-section"
import { SettingsAppearanceSection } from "@/components/settings/appearance-section"
import { SettingsPluginsSection } from "@/components/settings/plugins-section"
import { SettingsLayoutSection } from "@/components/settings/layout-section"
import { SettingsChatSection } from "@/components/settings/chat-section"
import { SettingsNotificationsSection } from "@/components/settings/notifications-section"
import { SettingsDiagnosticsSection } from "@/components/settings/diagnostics-section"
import { SettingsPrivacySection } from "@/components/settings/privacy-updates-sections"
import { GettingStartedDialog } from "@/components/settings/getting-started-dialog"
import { ResetSettingsDialog } from "@/components/settings/reset-settings-dialog"
import { KeyboardShortcutsDialog } from "@/components/settings/keyboard-shortcuts-dialog"
import {
  matchSettingsTabs,
  settingsTabGroups,
  settingsTabs,
} from "@/components/settings/settings-tabs"
import { SettingsGeneralSection } from "@/components/settings/general-section"
import { SettingsDocsSection } from "@/components/settings/docs-section"
import { SettingsBetterC0deSection } from "@/components/settings/betterc0de-section"
import { SettingsRemoteAccessSection } from "@/components/settings/remote-access-section"

export function SettingsPage({
  tab,
  onTabChange,
  onClose,
}: {
  tab: string
  onTabChange: (tab: string) => void
  onClose: () => void
}) {
  const { theme, setTheme } = useTheme()
  const settings = useSettingsStore()
  const { init: initSettings, refreshCli } = settings
  const isSimple = useAppearanceStore((s) => s.chatUiStyle === "simple")
  const [gettingStartedOpen, setGettingStartedOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [query, setQuery] = useState("")
  const matches = matchSettingsTabs(query)
  const activeTab = settingsTabs.some((entry) => entry.id === tab)
    ? tab
    : "general"

  useEffect(() => {
    initSettings()
    refreshCli()
  }, [initSettings, refreshCli])

  return (
    <main className="@container/settings flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      {/* Scales the whole page with its width; a zoomed column fills its
          parent exactly. */}
      <div className="flex min-h-0 flex-1 flex-col @min-[1280px]/settings:[zoom:1.08] @min-[1600px]/settings:[zoom:1.16] @min-[2000px]/settings:[zoom:1.24]">
        <header className="flex h-11 shrink-0 items-center border-b border-border/40 bg-background px-3">
          <div className="flex items-center gap-2.5">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Back to chat"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground active:scale-[0.96]"
            >
              <ArrowLeftIcon className="size-4" strokeWidth={1.75} />
            </Button>
            <div className="flex items-center gap-2">
              <SettingsIcon
                className="size-4 text-muted-foreground"
                strokeWidth={1.75}
              />
              <h1 className="text-[13px] font-medium">Settings</h1>
            </div>
          </div>
        </header>

        <Tabs
          value={activeTab}
          onValueChange={onTabChange}
          orientation="vertical"
          className="flex min-h-0 flex-1 gap-0 overflow-hidden"
        >
          {/* Rail: a quiet search, then the sections under plain group
              labels. Rows are plain: the icon takes the primary color and
              the row a soft fill when active. Unstyled Radix triggers keep
              the tab semantics and arrow-key movement. */}
          <nav
            aria-label="Settings sections"
            className="flex min-h-0 w-[clamp(220px,22%,272px)] shrink-0 flex-col border-r border-border/40"
          >
            <div className="shrink-0 px-3 pt-3 pb-2">
              <label className="flex h-9 items-center gap-2 rounded-lg bg-muted/40 px-3 transition-colors focus-within:bg-muted/60 focus-within:ring-1 focus-within:ring-ring/40">
                <SearchIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && matches[0]) {
                      onTabChange(matches[0].id)
                    } else if (event.key === "Escape" && query) {
                      event.preventDefault()
                      setQuery("")
                    }
                  }}
                  aria-label="Search settings"
                  placeholder="Search"
                  className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
                />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
              <TabsPrimitive.List
                aria-label="Settings sections"
                className="flex flex-col gap-4 pt-1"
              >
                {settingsTabGroups.map((group) => {
                  const entries = matches.filter(
                    (entry) => entry.group === group
                  )
                  if (entries.length === 0) return null
                  return (
                    <div
                      key={group}
                      role="presentation"
                      className="flex flex-col gap-0.5"
                    >
                      <div
                        role="presentation"
                        className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground/70"
                      >
                        {group}
                      </div>
                      {entries.map((entry) => (
                        <TabsPrimitive.Trigger
                          key={entry.id}
                          value={entry.id}
                          title={entry.description}
                          className="group/nav flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none data-[state=active]:bg-muted/70 data-[state=active]:font-medium data-[state=active]:text-foreground"
                        >
                          <HugeiconsIcon
                            icon={entry.icon}
                            strokeWidth={1.8}
                            className="size-4 shrink-0 transition-colors group-data-[state=active]/nav:text-primary"
                          />
                          <span className="truncate">{entry.label}</span>
                        </TabsPrimitive.Trigger>
                      ))}
                    </div>
                  )
                })}
              </TabsPrimitive.List>
              {matches.length === 0 ? (
                <p className="px-2.5 pt-2 text-[12.5px] text-muted-foreground/70">
                  No matching settings.
                </p>
              ) : null}
            </div>
          </nav>

          {/* Content: sections were laid out at a 16px base inside the old
              dialog, so the column keeps it for their em-based sizes. */}
          <div className="relative min-h-0 min-w-0 flex-1">
            {settingsTabs.map((entry) => (
              <TabsContent
                key={entry.id}
                value={entry.id}
                className="absolute inset-0 mt-0 data-[state=active]:animate-in data-[state=active]:duration-150 data-[state=active]:fade-in-0 data-[state=inactive]:hidden"
              >
                <div className="h-full overflow-y-auto">
                  <div
                    className="w-full space-y-7 px-6 py-8 @min-[900px]/settings:px-10"
                    style={{ fontSize: "16px" }}
                  >
                    <div className="flex items-center gap-3.5">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
                        <HugeiconsIcon
                          icon={entry.icon}
                          strokeWidth={1.8}
                          className="size-5"
                        />
                      </span>
                      <div className="min-w-0">
                        <h2 className="text-xl leading-tight font-semibold">
                          {entry.label}
                        </h2>
                        <p className="mt-0.5 text-[13px] text-muted-foreground">
                          {entry.description}
                        </p>
                      </div>
                    </div>

                    {entry.id === "general" && (
                      <SettingsGeneralSection
                        onOpenResetConfirm={() => setResetConfirmOpen(true)}
                      />
                    )}
                    {entry.id === "appearance" && (
                      <SettingsAppearanceSection
                        theme={theme}
                        setTheme={setTheme}
                      />
                    )}
                    {entry.id === "layout" && <SettingsLayoutSection />}
                    {entry.id === "chat" && <SettingsChatSection />}
                    {entry.id === "notifications" && (
                      <SettingsNotificationsSection />
                    )}
                    {entry.id === "models" && (
                      <>
                        <SettingsProvidersSection />
                        <SettingsModelVisibilitySection />
                      </>
                    )}
                    {entry.id === "plugins" && <SettingsPluginsSection />}
                    {entry.id === "rules" && <SettingsRulesSection />}
                    {entry.id === "skills" && <SettingsSkillsSection />}
                    {entry.id === "tools" && <SettingsMcpSection />}
                    {entry.id === "experimental" && (
                      <>
                        <SettingsOrchestratorSection />
                        <SettingsCodeSearchSection />
                      </>
                    )}
                    {entry.id === "hooks" && <SettingsHooksSection />}
                    {entry.id === "remote" && <SettingsRemoteAccessSection />}
                    {entry.id === "permissions" && (
                      <SettingsPermissionsSection />
                    )}
                    {entry.id === "privacy" && (
                      <>
                        <SettingsPrivacySection />
                        <SettingsDiagnosticsSection />
                      </>
                    )}
                    {entry.id === "betterc0de" && <SettingsBetterC0deSection />}
                    {entry.id === "docs" && (
                      <SettingsDocsSection
                        onOpenGettingStarted={() => setGettingStartedOpen(true)}
                        onOpenShortcuts={() => setShortcutsOpen(true)}
                      />
                    )}
                  </div>
                </div>
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </div>

      {/* Outside the tabs: Reset is opened from General and the other two
          from Docs, and an inactive tab's content is not mounted. */}
      <GettingStartedDialog
        open={gettingStartedOpen}
        onOpenChange={setGettingStartedOpen}
        isSimple={isSimple}
      />
      <ResetSettingsDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        isSimple={isSimple}
      />
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        isSimple={isSimple}
      />
    </main>
  )
}
