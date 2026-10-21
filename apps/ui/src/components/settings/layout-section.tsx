import {
  FolderTreeIcon,
  GitCompareIcon,
  MoveHorizontalIcon,
  PanelLeftIcon,
  PanelRightIcon,
  ScrollTextIcon,
} from "lucide-react"
import { isDiffViewOpen, setDiffViewOpen } from "@/lib/diff-view"
import { Switch } from "@/components/ui/switch"
import {
  SettingsRow,
  SettingsSection,
  SettingsSlider,
} from "@/components/settings/atoms"
import {
  clampLeftSidebarWidth,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
} from "@/lib/editor-layout"
import { usePreferencesStore } from "@/lib/preferences-store"

/**
 * "Layout" settings: which workspace panels are open, and the sidebar
 * width. Each switch writes the same state as the title bar, the shortcuts
 * and the slash commands, per mode: Agent keeps files and diffs in the right
 * panel, Editor and Canvas in the left sidebar.
 */
export function SettingsLayoutSection() {
  const preferences = usePreferencesStore()
  const filesInSidebar = preferences.appMode !== "agent"
  const filesOpen = filesInSidebar
    ? preferences.sidebarOpen && preferences.editorSidebarView === "files"
    : preferences.rightSidebarOpen && preferences.workspaceTab === "files"

  const setFilesOpen = (open: boolean) => {
    if (filesInSidebar) {
      if (open) {
        preferences.setMultiple({
          sidebarOpen: true,
          editorSidebarView: "files",
        })
      } else if (preferences.editorSidebarView === "files") {
        preferences.set("sidebarOpen", false)
      }
    } else if (open) {
      preferences.setMultiple({ rightSidebarOpen: true, workspaceTab: "files" })
    } else if (preferences.workspaceTab === "files") {
      preferences.set("workspaceTab", "overview")
    }
  }

  return (
    <>
      <SettingsSection
        title="Panels"
        description="The same panels as the title bar, the shortcuts and /sidebar, /files, /review.toggle and /console."
      >
        <SettingsRow
          icon={<PanelLeftIcon />}
          label="Main Sidebar"
          description="Your chats in Agent mode; files, search and source control in Editor and Canvas."
        >
          <Switch
            aria-label="Main Sidebar"
            checked={preferences.sidebarOpen}
            onCheckedChange={(value) => preferences.set("sidebarOpen", value)}
          />
        </SettingsRow>
        <SettingsRow
          icon={<PanelRightIcon />}
          label="Right Panel"
          description="Agent mode: Overview, Files, Git, Diff, Plan and Browser beside the chat."
        >
          <Switch
            aria-label="Right Panel"
            checked={preferences.rightSidebarOpen}
            onCheckedChange={(value) =>
              preferences.set("rightSidebarOpen", value)
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<FolderTreeIcon />}
          label="Files View"
          description="The project file tree: in the right panel in Agent mode, in the sidebar in Editor and Canvas."
        >
          <Switch
            aria-label="Files View"
            checked={filesOpen}
            onCheckedChange={setFilesOpen}
          />
        </SettingsRow>
        <SettingsRow
          icon={<GitCompareIcon />}
          label="Review / Diff"
          description="Code changes: in the right panel in Agent mode, in the sidebar in Editor and Canvas."
        >
          <Switch
            aria-label="Review / Diff"
            checked={isDiffViewOpen(preferences)}
            onCheckedChange={setDiffViewOpen}
          />
        </SettingsRow>
        <SettingsRow
          icon={<ScrollTextIcon />}
          label="Console"
          description="The developer console and report under the chat."
        >
          <Switch
            aria-label="Console"
            checked={preferences.consolePanelOpen}
            onCheckedChange={(value) =>
              preferences.set("consolePanelOpen", value)
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Sizes">
        <SettingsRow
          icon={<MoveHorizontalIcon />}
          label="Sidebar Width"
          description="The left sidebar in every mode. Dragging its edge changes the same width."
        >
          <SettingsSlider
            label="Sidebar Width"
            min={LEFT_SIDEBAR_MIN_WIDTH}
            max={LEFT_SIDEBAR_MAX_WIDTH}
            step={10}
            value={Math.round(preferences.sidebarWidth)}
            unit="px"
            onChange={(value) =>
              preferences.set("sidebarWidth", clampLeftSidebarWidth(value))
            }
          />
        </SettingsRow>
      </SettingsSection>
    </>
  )
}
