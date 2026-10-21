import { runEditorSave } from "@/lib/editor-save"
import { copyText } from "@/lib/clipboard"
import { toggleDiffView } from "@/lib/diff-view"
import { useChatStore } from "@/lib/chat-store"
import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CopyIcon,
  FileTextIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  KeyboardIcon,
  LayoutGridIcon,
  ListTreeIcon,
  LocateFixedIcon,
  PanelBottomIcon,
  PanelsTopLeftIcon,
  PencilLineIcon,
  PinIcon,
  SaveIcon,
  SearchCodeIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SplitSquareHorizontalIcon,
  SquareTerminalIcon,
  TextSearchIcon,
  Undo2Icon,
  XIcon,
  type LucideIcon,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useAppearanceStore } from "@/lib/appearance-store"
import { confirmCloseDirtyEditorTabs } from "@/lib/editor-close-confirmation"
import { relativeEditorPath } from "@/lib/editor-path"
import { dispatchEditorRevealFile } from "@/lib/editor-reveal-event"
import { useEditorStore } from "@/lib/editor-store"
import { useMultiAgentStore } from "@/lib/multi-agent-store"
import { openPullRequestsPage } from "@/lib/pull-requests-page"
import { dispatchTerminalNewSession } from "@/lib/terminal-events"
import { requestChatFind } from "@/lib/chat-find-events"
import {
  usePreferencesStore,
  type EditorSidebarView,
} from "@/lib/preferences-store"
import { cn } from "@/lib/utils"

interface EditorCommandPaletteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath?: string | null
  appMode: "agent" | "editor" | "design"
  setAppMode: (mode: "agent" | "editor" | "design") => void
  setSidebarOpen: (open: boolean) => void
  setEditorSidebarView: (view: EditorSidebarView) => void
  terminalOpen: boolean
  setTerminalOpen: (open: boolean) => void
  setQuickOpenOpen: (open: boolean) => void
  setGoToLineOpen: (open: boolean) => void
  setDocumentSymbolsOpen: (open: boolean) => void
  setWorkspaceSymbolsOpen: (open: boolean) => void
  setMarketplaceOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setSettingsTab: (tab: string) => void
  setShortcutsOpen: (open: boolean) => void
  setSystemBrowserOpen: (open: boolean) => void
  setSystemBrowserIntent: (
    intent: "agent-new-thread" | "editor-open-folder"
  ) => void
  setNewThreadModalOpen: (open: boolean) => void
  setNewThreadModalPath: (path: string) => void
  onNewProject: () => void
}

interface PaletteCommand {
  id: string
  group: "Workspace" | "Editor" | "Panels" | "App"
  label: string
  detail?: string
  shortcut?: string
  icon: LucideIcon
  disabled?: boolean
  run: () => void | Promise<void>
}

const GROUPS: PaletteCommand["group"][] = [
  "Workspace",
  "Editor",
  "Panels",
  "App",
]

const CODE_FONT_SIZE_MIN = 10
const CODE_FONT_SIZE_MAX = 20
const CODE_FONT_SIZE_DEFAULT = 13

export function EditorCommandPaletteDialog({
  open,
  onOpenChange,
  projectPath,
  appMode,
  setAppMode,
  setSidebarOpen,
  setEditorSidebarView,
  terminalOpen,
  setTerminalOpen,
  setQuickOpenOpen,
  setGoToLineOpen,
  setDocumentSymbolsOpen,
  setWorkspaceSymbolsOpen,
  setMarketplaceOpen,
  setSettingsOpen,
  setSettingsTab,
  setShortcutsOpen,
  setSystemBrowserOpen,
  setSystemBrowserIntent,
  setNewThreadModalOpen,
  setNewThreadModalPath,
  onNewProject,
}: EditorCommandPaletteDialogProps) {
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const activeChatId = useChatStore((s) => s.activeThreadId)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const activeTab = useEditorStore((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId)
  )
  const tabs = useEditorStore((s) => s.tabs)
  const tabsLength = tabs.length
  const navigationBackCount = useEditorStore(
    (s) => s.navigationBackStack.length
  )
  const navigationForwardCount = useEditorStore(
    (s) => s.navigationForwardStack.length
  )
  const saveActiveTab = useEditorStore((s) => s.saveActiveTab)
  const saveAllTabs = useEditorStore((s) => s.saveAllTabs)
  const moveTab = useEditorStore((s) => s.moveTab)
  const togglePinTab = useEditorStore((s) => s.togglePinTab)
  const closeTab = useEditorStore((s) => s.closeTab)
  const closeOtherTabs = useEditorStore((s) => s.closeOtherTabs)
  const closeTabsToRight = useEditorStore((s) => s.closeTabsToRight)
  const closeSavedTabs = useEditorStore((s) => s.closeSavedTabs)
  const closeAllTabs = useEditorStore((s) => s.closeAllTabs)
  const activateAdjacentTab = useEditorStore((s) => s.activateAdjacentTab)
  const reopenClosedTab = useEditorStore((s) => s.reopenClosedTab)
  const recentlyClosedTabs = useEditorStore((s) => s.recentlyClosedTabs)
  const goBack = useEditorStore((s) => s.goBack)
  const goForward = useEditorStore((s) => s.goForward)
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap)
  const editorMinimap = usePreferencesStore((s) => s.editorMinimap)
  const editorStickyScroll = usePreferencesStore((s) => s.editorStickyScroll)
  const editorRenderWhitespace = usePreferencesStore(
    (s) => s.editorRenderWhitespace
  )
  const editorInlayHints = usePreferencesStore((s) => s.editorInlayHints)
  const editorLineNumbers = usePreferencesStore((s) => s.editorLineNumbers)
  const setPreference = usePreferencesStore((s) => s.set)
  const codeFontSize = useAppearanceStore((s) => s.codeFontSize)
  const setAppearance = useAppearanceStore((s) => s.set)
  const dirtyTabsCount = useEditorStore(
    (s) => s.tabs.filter((tab) => tab.isDirty).length
  )
  const closableSavedTabsCount = tabs.filter(
    (tab) => !tab.isDirty && !tab.isPinned
  ).length
  const closableTabsCount = tabs.filter((tab) => !tab.isPinned).length
  const closeOtherTabsCount = activeTabId
    ? tabs.filter((tab) => tab.id !== activeTabId && !tab.isPinned).length
    : 0
  const activeTabIndex = activeTabId
    ? tabs.findIndex((tab) => tab.id === activeTabId)
    : -1
  const tabsRightCount =
    activeTabIndex === -1
      ? 0
      : tabs.slice(activeTabIndex + 1).filter((tab) => !tab.isPinned).length
  const canMoveActiveTabLeft =
    activeTabIndex > 0 &&
    tabs[activeTabIndex - 1]?.isPinned === activeTab?.isPinned
  const canMoveActiveTabRight =
    activeTabIndex !== -1 &&
    activeTabIndex < tabsLength - 1 &&
    tabs[activeTabIndex + 1]?.isPinned === activeTab?.isPinned

  const openEditorView = (view: EditorSidebarView) => {
    setAppMode("editor")
    setSidebarOpen(true)
    setEditorSidebarView(view)
  }

  const runCommand = (command: PaletteCommand) => {
    if (command.disabled) return
    onOpenChange(false)
    void Promise.resolve(command.run()).catch(() => {})
  }

  const copyActivePath = async (kind: "absolute" | "relative") => {
    if (!activeTab) return
    const path =
      kind === "relative"
        ? relativeEditorPath(projectPath, activeTab.filePath)
        : activeTab.filePath
    await copyText(path)
  }

  const closeActiveEditor = () => {
    if (!activeTabId || !activeTab) return
    if (!confirmCloseDirtyEditorTabs([activeTab], "closing this editor")) return
    closeTab(activeTabId)
  }

  const closeOtherEditors = () => {
    if (!activeTabId) return
    const closingTabs = tabs.filter(
      (tab) => tab.id !== activeTabId && !tab.isPinned
    )
    if (!confirmCloseDirtyEditorTabs(closingTabs, "closing other editors"))
      return
    closeOtherTabs(activeTabId)
  }

  const closeEditorsToRight = () => {
    if (!activeTabId || activeTabIndex === -1) return
    const closingTabs = tabs
      .slice(activeTabIndex + 1)
      .filter((tab) => !tab.isPinned)
    if (
      !confirmCloseDirtyEditorTabs(closingTabs, "closing editors to the right")
    )
      return
    closeTabsToRight(activeTabId)
  }

  const closeAllEditors = () => {
    const closingTabs = tabs.filter((tab) => !tab.isPinned)
    if (!confirmCloseDirtyEditorTabs(closingTabs, "closing all editors")) return
    closeAllTabs()
  }

  const revealActiveFileInExplorer = () => {
    if (!activeTab) return
    openEditorView("files")
    dispatchEditorRevealFile(activeTab.filePath, { defer: true })
  }

  const commands: PaletteCommand[] = [
    {
      id: "workspace.files",
      group: "Workspace",
      label: "Show Explorer",
      detail: "Switch to the workspace file tree",
      shortcut: "Ctrl+Shift+E",
      icon: FolderOpenIcon,
      run: () => openEditorView("files"),
    },
    {
      id: "workspace.reveal-active-file",
      group: "Workspace",
      label: "Reveal Active File in Explorer",
      detail: activeTab
        ? relativeEditorPath(projectPath, activeTab.filePath)
        : "No active editor",
      icon: FolderOpenIcon,
      disabled: !activeTab,
      run: revealActiveFileInExplorer,
    },
    {
      id: "workspace.quick-open",
      group: "Workspace",
      label: "Quick Open File",
      detail: "Search files by name or path",
      shortcut: "Ctrl+P",
      icon: FileTextIcon,
      run: () => {
        setAppMode("editor")
        setQuickOpenOpen(true)
      },
    },
    {
      id: "workspace.symbols",
      group: "Workspace",
      label: "Workspace Symbols",
      detail: "Search functions, classes, and components",
      shortcut: "Ctrl+T",
      icon: LocateFixedIcon,
      run: () => {
        setAppMode("editor")
        setWorkspaceSymbolsOpen(true)
      },
    },
    {
      id: "editor.document-symbols",
      group: "Editor",
      label: "Go to Symbol in File",
      detail: activeTab?.fileName ?? "No active editor",
      shortcut: appMode === "editor" ? "Ctrl+Shift+O" : undefined,
      icon: ListTreeIcon,
      disabled: !activeTabId,
      run: () => setDocumentSymbolsOpen(true),
    },
    {
      id: "workspace.search",
      group: "Workspace",
      label: "Search Workspace",
      detail: "Search file contents across the project",
      shortcut: "Ctrl+Shift+F",
      icon: SearchIcon,
      run: () => openEditorView("search"),
    },
    {
      id: "workspace.map",
      group: "Workspace",
      label: "Show Code Map",
      detail: "Inspect project structure, file types, and entry points",
      icon: LayoutGridIcon,
      run: () => openEditorView("map"),
    },
    {
      id: "workspace.references",
      group: "Workspace",
      label: "Show References",
      detail: "Inspect project references for the selected editor symbol",
      icon: SearchCodeIcon,
      run: () => openEditorView("references"),
    },
    {
      id: "workspace.outline",
      group: "Workspace",
      label: "Show Outline",
      detail: "Open the persistent symbol outline sidebar",
      icon: ListTreeIcon,
      run: () => openEditorView("outline"),
    },
    {
      id: "workspace.git",
      group: "Workspace",
      label: "Source Control",
      detail: "Open the editor source-control sidebar",
      shortcut: "Ctrl+Shift+G",
      icon: GitBranchIcon,
      run: () => openEditorView("source-control"),
    },
    {
      id: "workspace.agents",
      group: "Workspace",
      label: "Multiagent",
      detail: "Configure parallel agents with isolated worktrees",
      icon: BotIcon,
      run: () => useMultiAgentStore.getState().openConfig(),
    },
    {
      id: "workspace.open-folder",
      group: "Workspace",
      label: "Open Folder",
      detail: "Attach a workspace to Editor Mode",
      icon: PanelsTopLeftIcon,
      run: () => {
        setSystemBrowserIntent("editor-open-folder")
        setSystemBrowserOpen(true)
      },
    },
    {
      id: "editor.go-back",
      group: "Editor",
      label: "Go Back",
      detail: "Return to the previous editor location",
      shortcut: "Alt+Left",
      icon: ArrowLeftIcon,
      disabled: navigationBackCount === 0,
      run: goBack,
    },
    {
      id: "editor.go-forward",
      group: "Editor",
      label: "Go Forward",
      detail: "Move to the next editor location",
      shortcut: "Alt+Right",
      icon: ArrowRightIcon,
      disabled: navigationForwardCount === 0,
      run: goForward,
    },
    {
      id: "editor.previous-tab",
      group: "Editor",
      label: "Previous Editor",
      detail: "Activate the editor tab to the left",
      shortcut: "Ctrl+PageUp",
      icon: ArrowLeftIcon,
      disabled: tabsLength <= 1,
      run: () => activateAdjacentTab("previous"),
    },
    {
      id: "editor.next-tab",
      group: "Editor",
      label: "Next Editor",
      detail: "Activate the editor tab to the right",
      shortcut: "Ctrl+PageDown",
      icon: ArrowRightIcon,
      disabled: tabsLength <= 1,
      run: () => activateAdjacentTab("next"),
    },
    {
      id: "editor.split-right",
      group: "Editor",
      label: "Split Editor Right",
      detail: activeTab?.fileName,
      shortcut: "Ctrl+\\",
      icon: SplitSquareHorizontalIcon,
      disabled: !activeTabId,
      run: () => {
        window.dispatchEvent(
          new CustomEvent("betterc0de:editor-split-right", {
            detail: { tabId: activeTabId },
          })
        )
      },
    },
    {
      id: "editor.close-split",
      group: "Editor",
      label: "Close Split Editor",
      detail: "Return to a single editor group",
      icon: XIcon,
      run: () => {
        window.dispatchEvent(new CustomEvent("betterc0de:editor-close-split"))
      },
    },
    {
      id: "editor.edit-with-ai",
      group: "Editor",
      label: "Edit with AI",
      detail: activeTab?.fileName,
      shortcut: "Ctrl+K",
      icon: SparklesIcon,
      disabled: !activeTabId,
      run: () => {
        window.dispatchEvent(
          new CustomEvent("betterc0de:editor-edit-with-ai", {
            detail: { filePath: activeTab?.filePath },
          })
        )
      },
    },
    {
      id: "editor.go-to-line",
      group: "Editor",
      label: "Go to Line",
      detail: activeTab?.fileName,
      shortcut: "Ctrl+G",
      icon: LocateFixedIcon,
      disabled: !activeTabId,
      run: () => setGoToLineOpen(true),
    },
    {
      id: "editor.go-to-definition",
      group: "Editor",
      label: "Go to Definition",
      detail: activeTab?.fileName,
      shortcut: "F12",
      icon: LocateFixedIcon,
      disabled: !activeTabId,
      run: () => {
        window.dispatchEvent(
          new CustomEvent("betterc0de:editor-go-to-definition", {
            detail: { filePath: activeTab?.filePath },
          })
        )
      },
    },
    {
      id: "editor.find-references",
      group: "Editor",
      label: "Find References",
      detail: activeTab?.fileName,
      shortcut: "Shift+F12",
      icon: SearchCodeIcon,
      disabled: !activeTabId,
      run: () => {
        window.dispatchEvent(
          new CustomEvent("betterc0de:editor-find-references", {
            detail: { filePath: activeTab?.filePath },
          })
        )
      },
    },
    {
      id: "editor.rename-symbol",
      group: "Editor",
      label: "Rename Symbol in Open Files",
      detail: activeTab?.fileName,
      shortcut: "F2",
      icon: PencilLineIcon,
      disabled: !activeTabId,
      run: () => {
        window.dispatchEvent(
          new CustomEvent("betterc0de:editor-rename-symbol", {
            detail: { filePath: activeTab?.filePath },
          })
        )
      },
    },
    {
      id: "editor.toggle-word-wrap",
      group: "Editor",
      label: "Toggle Word Wrap",
      detail: editorWordWrap ? "Currently on" : "Currently off",
      shortcut: "Alt+Z",
      icon: FileTextIcon,
      disabled: !activeTab,
      run: () => setPreference("editorWordWrap", !editorWordWrap),
    },
    {
      id: "editor.toggle-minimap",
      group: "Editor",
      label: "Toggle Minimap",
      detail: editorMinimap ? "Currently on" : "Currently off",
      icon: FileTextIcon,
      disabled: !activeTab,
      run: () => setPreference("editorMinimap", !editorMinimap),
    },
    {
      id: "editor.toggle-sticky-scroll",
      group: "Editor",
      label: "Toggle Sticky Scroll",
      detail: editorStickyScroll ? "Currently on" : "Currently off",
      icon: FileTextIcon,
      disabled: !activeTab,
      run: () => setPreference("editorStickyScroll", !editorStickyScroll),
    },
    {
      id: "editor.toggle-render-whitespace",
      group: "Editor",
      label: "Toggle Render Whitespace",
      detail: editorRenderWhitespace ? "Currently on" : "Currently off",
      icon: FileTextIcon,
      disabled: !activeTab,
      run: () =>
        setPreference("editorRenderWhitespace", !editorRenderWhitespace),
    },
    {
      id: "editor.toggle-inlay-hints",
      group: "Editor",
      label: "Toggle Inlay Hints",
      detail: editorInlayHints ? "Currently on" : "Currently off",
      icon: FileTextIcon,
      disabled: !activeTab,
      run: () => setPreference("editorInlayHints", !editorInlayHints),
    },
    {
      id: "editor.toggle-line-numbers",
      group: "Editor",
      label: "Toggle Line Numbers",
      detail: editorLineNumbers ? "Currently on" : "Currently off",
      icon: FileTextIcon,
      disabled: !activeTab,
      run: () => setPreference("editorLineNumbers", !editorLineNumbers),
    },
    {
      id: "editor.font-size-increase",
      group: "Editor",
      label: "Increase Editor Font Size",
      detail: `Currently ${codeFontSize}px`,
      icon: FileTextIcon,
      disabled: codeFontSize >= CODE_FONT_SIZE_MAX,
      run: () =>
        setAppearance(
          "codeFontSize",
          Math.min(CODE_FONT_SIZE_MAX, codeFontSize + 1)
        ),
    },
    {
      id: "editor.font-size-decrease",
      group: "Editor",
      label: "Decrease Editor Font Size",
      detail: `Currently ${codeFontSize}px`,
      icon: FileTextIcon,
      disabled: codeFontSize <= CODE_FONT_SIZE_MIN,
      run: () =>
        setAppearance(
          "codeFontSize",
          Math.max(CODE_FONT_SIZE_MIN, codeFontSize - 1)
        ),
    },
    {
      id: "editor.font-size-reset",
      group: "Editor",
      label: "Reset Editor Font Size",
      detail: `Set to ${CODE_FONT_SIZE_DEFAULT}px`,
      icon: FileTextIcon,
      disabled: codeFontSize === CODE_FONT_SIZE_DEFAULT,
      run: () => setAppearance("codeFontSize", CODE_FONT_SIZE_DEFAULT),
    },
    {
      id: "editor.format-document",
      group: "Editor",
      label: "Format Document",
      detail: activeTab?.fileName,
      shortcut: "Shift+Alt+F",
      icon: FileTextIcon,
      disabled: !activeTab,
      run: () => {
        window.dispatchEvent(
          new CustomEvent("betterc0de:editor-format-document", {
            detail: { filePath: activeTab?.filePath },
          })
        )
      },
    },
    {
      id: "editor.copy-path",
      group: "Editor",
      label: "Copy Path",
      detail: activeTab?.filePath,
      icon: CopyIcon,
      disabled: !activeTab,
      run: () => copyActivePath("absolute"),
    },
    {
      id: "editor.copy-relative-path",
      group: "Editor",
      label: "Copy Relative Path",
      detail: activeTab
        ? relativeEditorPath(projectPath, activeTab.filePath)
        : undefined,
      icon: CopyIcon,
      disabled: !activeTab,
      run: () => copyActivePath("relative"),
    },
    {
      id: "editor.save",
      group: "Editor",
      label: "Save Active File",
      detail: activeTab?.fileName,
      shortcut: "Ctrl+S",
      icon: SaveIcon,
      disabled: !activeTabId,
      run: () => runEditorSave(saveActiveTab),
    },
    {
      id: "editor.save-all",
      group: "Editor",
      label: "Save All",
      detail: `${dirtyTabsCount} modified`,
      shortcut: "Ctrl+Alt+S",
      icon: SaveIcon,
      disabled: dirtyTabsCount === 0,
      run: () => runEditorSave(saveAllTabs),
    },
    {
      id: "editor.pin-active",
      group: "Editor",
      label: activeTab?.isPinned ? "Unpin Active Editor" : "Pin Active Editor",
      detail: activeTab?.fileName,
      icon: PinIcon,
      disabled: !activeTabId,
      run: () => {
        if (activeTabId) togglePinTab(activeTabId)
      },
    },
    {
      id: "editor.move-left",
      group: "Editor",
      label: "Move Editor Left",
      detail: activeTab?.fileName,
      shortcut: "Ctrl+Shift+PageUp",
      icon: ArrowLeftIcon,
      disabled: !activeTabId || !canMoveActiveTabLeft,
      run: () => {
        if (activeTabId) moveTab(activeTabId, "left")
      },
    },
    {
      id: "editor.move-right",
      group: "Editor",
      label: "Move Editor Right",
      detail: activeTab?.fileName,
      shortcut: "Ctrl+Shift+PageDown",
      icon: ArrowRightIcon,
      disabled: !activeTabId || !canMoveActiveTabRight,
      run: () => {
        if (activeTabId) moveTab(activeTabId, "right")
      },
    },
    {
      id: "editor.reopen-closed",
      group: "Editor",
      label: "Reopen Closed Editor",
      detail: recentlyClosedTabs[0]?.fileName ?? "No closed editors",
      shortcut: "Ctrl+Shift+T",
      icon: Undo2Icon,
      disabled: recentlyClosedTabs.length === 0,
      run: reopenClosedTab,
    },
    {
      id: "editor.close-active",
      group: "Editor",
      label: "Close Active Editor",
      detail: activeTab?.fileName,
      shortcut: "Ctrl+W",
      icon: XIcon,
      disabled: !activeTabId,
      run: closeActiveEditor,
    },
    {
      id: "editor.close-others",
      group: "Editor",
      label: "Close Other Editors",
      detail: activeTab?.fileName,
      icon: XIcon,
      disabled: !activeTabId || closeOtherTabsCount === 0,
      run: closeOtherEditors,
    },
    {
      id: "editor.close-right",
      group: "Editor",
      label: "Close Editors to the Right",
      detail: `${tabsRightCount} right`,
      icon: XIcon,
      disabled: !activeTabId || tabsRightCount === 0,
      run: closeEditorsToRight,
    },
    {
      id: "editor.close-saved",
      group: "Editor",
      label: "Close Saved Editors",
      detail: `${closableSavedTabsCount} saved`,
      icon: XIcon,
      disabled: closableSavedTabsCount === 0,
      run: closeSavedTabs,
    },
    {
      id: "editor.close-all",
      group: "Editor",
      label: "Close All Editors",
      detail: `${closableTabsCount} closable`,
      icon: XIcon,
      disabled: closableTabsCount === 0,
      run: closeAllEditors,
    },
    {
      id: "editor.browser-preview",
      group: "Editor",
      label: "Open Browser Preview",
      detail: "Switch the editor surface to browser preview",
      icon: FileTextIcon,
      run: () => {
        window.dispatchEvent(new CustomEvent("betterc0de:editor-open-preview"))
      },
    },
    {
      id: "panels.sidebar",
      group: "Panels",
      label: "Toggle Sidebar",
      detail: "Show or hide the workspace sidebar",
      shortcut: "Ctrl+B",
      icon: PanelsTopLeftIcon,
      run: () => setSidebarOpen(!usePreferencesStore.getState().sidebarOpen),
    },
    {
      id: "panels.terminal",
      group: "Panels",
      label: "Toggle Terminal",
      shortcut: "Ctrl+`",
      icon: SquareTerminalIcon,
      run: () => setTerminalOpen(!terminalOpen),
    },
    {
      id: "terminal.new",
      group: "Panels",
      label: "New Terminal",
      detail: "Open the terminal panel with a new session",
      shortcut: "Ctrl+Alt+T",
      icon: SquareTerminalIcon,
      run: () => {
        const wasOpen = terminalOpen
        setTerminalOpen(true)
        if (wasOpen) {
          const threadId = useChatStore.getState().activeThreadId
          window.setTimeout(() => {
            dispatchTerminalNewSession({
              mode: appMode,
              cwd: projectPath,
              threadId,
            })
          }, 0)
        }
      },
    },
    {
      id: "panels.diff",
      group: "Panels",
      label: "Toggle Diff Panel",
      shortcut: "Ctrl+Shift+D",
      icon: SplitSquareHorizontalIcon,
      run: () => {
        toggleDiffView()
      },
    },
    {
      id: "panels.new-agent",
      group: "App",
      label: "New Chat",
      shortcut: "Ctrl+N",
      icon: FileTextIcon,
      run: () => {
        setNewThreadModalPath("")
        setNewThreadModalOpen(true)
      },
    },
    {
      id: "chat.find",
      group: "App",
      label: "Find in Chat",
      detail: "Search every message of the open chat",
      shortcut: "Ctrl+F",
      icon: TextSearchIcon,
      disabled: !activeChatId,
      // After the palette has closed and handed focus back, so the find
      // field keeps it.
      run: () => {
        window.setTimeout(() => requestChatFind(), 0)
      },
    },
    {
      id: "app.new-project",
      group: "App",
      label: "New Project",
      detail: "Create a new workspace from a template",
      shortcut: "Ctrl+Shift+N",
      icon: FolderOpenIcon,
      run: onNewProject,
    },
    {
      id: "app.system-browser",
      group: "App",
      label: "Open System Browser",
      detail: "Pick any folder from the native file browser",
      shortcut: appMode === "editor" ? undefined : "Ctrl+Shift+O",
      icon: FolderOpenIcon,
      run: () => {
        setSystemBrowserIntent(
          appMode !== "agent" ? "editor-open-folder" : "agent-new-thread"
        )
        setSystemBrowserOpen(true)
      },
    },
    {
      id: "app.marketplace",
      group: "App",
      label: "Marketplace",
      shortcut: appMode === "editor" ? undefined : "Ctrl+Shift+M",
      icon: PanelBottomIcon,
      run: () => setMarketplaceOpen(true),
    },
    {
      id: "app.pull-requests",
      group: "App",
      label: "Pull Requests",
      detail: "Open pull requests of your projects, through GitHub CLI",
      icon: GitPullRequestIcon,
      run: () => openPullRequestsPage(),
    },
    {
      id: "app.settings",
      group: "App",
      label: "Settings",
      shortcut: "Ctrl+,",
      icon: SettingsIcon,
      run: () => {
        setSettingsTab("general")
        setSettingsOpen(true)
      },
    },
    {
      id: "app.shortcuts",
      group: "App",
      label: "Keyboard Shortcuts",
      shortcut: "Ctrl+/",
      icon: KeyboardIcon,
      run: () => setShortcutsOpen(true),
    },
    {
      id: "app.switch-editor",
      group: "App",
      label:
        appMode === "editor" ? "Stay in Editor Mode" : "Switch to Editor Mode",
      detail: "Use the IDE workspace layout",
      icon: PanelsTopLeftIcon,
      disabled: appMode === "editor",
      run: () => setAppMode("editor"),
    },
  ]

  const filteredGroups = GROUPS.map((group) => ({
    group,
    commands: commands.filter(
      (command) => command.group === group && matchesCommand(command, query)
    ),
  })).filter((entry) => entry.commands.length > 0)
  const selectableCommands = useMemo(
    () =>
      filteredGroups.flatMap((entry) =>
        entry.commands.filter((command) => !command.disabled)
      ),
    [filteredGroups]
  )
  const selectedCommand = selectableCommands[selectedIndex] ?? null
  const selectedOptionId = selectedCommand
    ? `command-palette-option-${selectedCommand.id}`
    : undefined

  useEffect(() => {
    if (!open) return
    setQuery("")
    setSelectedIndex(0)
  }, [open])

  useEffect(() => {
    setSelectedIndex((index) => {
      if (selectableCommands.length === 0) return 0
      return Math.min(index, selectableCommands.length - 1)
    })
  }, [selectableCommands.length])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelectedIndex((index) =>
        selectableCommands.length === 0
          ? 0
          : (index + 1) % selectableCommands.length
      )
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedIndex((index) =>
        selectableCommands.length === 0
          ? 0
          : (index - 1 + selectableCommands.length) % selectableCommands.length
      )
      return
    }
    if (event.key === "Home") {
      event.preventDefault()
      setSelectedIndex(0)
      return
    }
    if (event.key === "End") {
      event.preventDefault()
      setSelectedIndex(Math.max(0, selectableCommands.length - 1))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      if (selectedCommand) runCommand(selectedCommand)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-1/3 max-w-xl translate-y-0 overflow-hidden rounded-3xl p-0"
      >
        <DialogTitle className="sr-only">Command Palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search editor and app commands
        </DialogDescription>
        <div className="border-b border-border/50 p-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setSelectedIndex(0)
              }}
              onKeyDown={handleKeyDown}
              aria-activedescendant={selectedOptionId}
              aria-controls="command-palette-results"
              aria-autocomplete="list"
              autoFocus
              placeholder="Type a command..."
              className="h-10 rounded-2xl border-transparent bg-input/55 pr-3 pl-9 text-sm"
            />
          </div>
        </div>
        <div
          id="command-palette-results"
          className="max-h-80 overflow-y-auto p-1.5"
          role="listbox"
          aria-label="Command Palette results"
        >
          {filteredGroups.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              No commands found.
            </div>
          ) : (
            filteredGroups.map(({ group, commands }) => (
              <div key={group} className="py-1">
                <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                  {group}
                </div>
                <div className="space-y-1">
                  {commands.map((command) => {
                    const Icon = command.icon
                    const isSelected = selectedCommand?.id === command.id
                    return (
                      <button
                        id={`command-palette-option-${command.id}`}
                        key={command.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        disabled={command.disabled}
                        onMouseEnter={() => {
                          const nextIndex = selectableCommands.findIndex(
                            (item) => item.id === command.id
                          )
                          if (nextIndex >= 0) setSelectedIndex(nextIndex)
                        }}
                        onClick={() => runCommand(command)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-colors outline-none",
                          isSelected
                            ? "bg-muted text-foreground"
                            : "hover:bg-muted/70",
                          "focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring/50",
                          command.disabled &&
                            "pointer-events-none cursor-not-allowed opacity-50"
                        )}
                      >
                        <Icon
                          className="size-4 shrink-0 text-muted-foreground"
                          strokeWidth={1.75}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">
                            {command.label}
                          </span>
                          {command.detail && (
                            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                              {command.detail}
                            </span>
                          )}
                        </span>
                        {command.shortcut && (
                          <span className="shrink-0 font-mono text-[10px] tracking-wide text-muted-foreground">
                            {command.shortcut}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function matchesCommand(command: PaletteCommand, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [
    command.group,
    command.label,
    command.detail ?? "",
    command.shortcut ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle)
}
