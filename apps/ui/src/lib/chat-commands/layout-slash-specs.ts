import { useAppearanceStore } from "@/lib/appearance-store"
import { findComposerTextarea } from "@/lib/composer-input"
import { toggleDiffView } from "@/lib/diff-view"
import { usePreferencesStore } from "@/lib/preferences-store"
import { dispatchTerminalNewSession } from "@/lib/terminal-events"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { isSlashCommand } from "./prompt-commands"
import {
  type ActiveThreadRef,
  escapeMarkdownTableCell,
} from "./provider-config"
import { resolveToggleArg } from "./settings-actions"
import { buildToggleOutput } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"

function buildPtyTerminalOutput(
  command: string,
  open: boolean,
  activeThread: ActiveThreadRef
): string {
  const equivalent = ptyEquivalentForCommand(command)
  const cwd = resolveThreadRuntimePath(activeThread)
  return [
    "# Terminal PTY\n",
    `Compatibility reference: \`${equivalent}\`.`,
    "",
    `Terminal panel: **${open ? "Open" : "Closed"}**`,
    cwd ? `Workspace: \`${escapeMarkdownTableCell(cwd)}\`` : "Workspace: -",
    "",
    "BetterC0de uses its integrated terminal PTY UI for interactive terminal sessions. Create a new PTY with `/terminal-new` or `/pty.create`; close/remove sessions from the terminal tab controls.",
  ].join("\n")
}

function ptyEquivalentForCommand(command: string): string {
  const normalized = command.replace(/^\//, "")
  if (normalized === "pty" || normalized === "terminal") return "pty.list"
  if (normalized === "pty-list") return "pty.list"
  if (normalized === "pty-shells") return "pty.shells"
  if (normalized === "pty-get") return "pty.get"
  if (normalized === "pty-connect") return "pty.connect"
  if (normalized === "pty.connect-token") return "pty.connectToken"
  if (normalized === "pty-remove") return "pty.remove"
  return normalized
}

function focusChatComposerInput(threadId: string | null): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  const input = findComposerTextarea(threadId)
  window.setTimeout(() => {
    if (input?.isConnected) input.focus()
  }, 0)
}

/** Panels, terminal, file tree, sidebar, input focus and app behaviour toggles. */
export const LAYOUT_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["review-toggle", "review.toggle", "review-panel-toggle"],
      run: (run) => {
        const next = toggleDiffView()
        run.output = buildToggleOutput("Review / Diff Panel", next)
      },
    },
    {
      names: [
        "terminal-title",
        "terminal.title.toggle",
        "terminal-title-toggle",
        "pty.update",
      ],
      run: (run) => {
        const { args } = run
        const appearance = useAppearanceStore.getState()
        const next = resolveToggleArg(args[0], appearance.terminalTitleEnabled)
        appearance.set("terminalTitleEnabled", next)
        run.output = buildToggleOutput("Terminal Titles", next)
      },
    },
    {
      names: [
        "terminal",
        "terminal.toggle",
        "terminal.suspend",
        "pty",
        "pty.list",
        "pty-list",
        "pty.shells",
        "pty-shells",
        "pty.get",
        "pty-get",
        "pty.connect",
        "pty-connect",
        "pty.connectToken",
        "pty.connect-token",
        "pty.remove",
        "pty-remove",
      ],
      run: (run) => {
        const { cmd, activeThread } = run
        const prefs = usePreferencesStore.getState()
        const next = !prefs.terminalOpen
        prefs.set("terminalOpen", next)
        run.output = buildPtyTerminalOutput(cmd, next, activeThread)
      },
    },
    {
      names: [
        "terminal-new",
        "terminal.new",
        "new-terminal",
        "pty.create",
        "pty-create",
      ],
      run: (run) => {
        const { cmd, activeThread, threadId } = run
        const prefs = usePreferencesStore.getState()
        const wasOpen = prefs.terminalOpen
        prefs.set("terminalOpen", true)
        if (wasOpen) {
          window.setTimeout(() => {
            dispatchTerminalNewSession({
              threadId,
              mode: prefs.appMode,
              cwd: resolveThreadRuntimePath(activeThread),
            })
          }, 0)
        }
        run.output = [
          "# New Terminal\n",
          isSlashCommand(cmd, "pty.create", "pty-create")
            ? "Compatibility reference: `pty.create`.\n"
            : "",
          "Opened a new terminal session.",
        ]
          .filter(Boolean)
          .join("\n")
      },
    },
    {
      names: [
        "file-tree-toggle",
        "filetree.toggle",
        "filetree-toggle",
        "file-tree.toggle",
        "file-tree",
        "files",
        "files.toggle",
      ],
      run: (run) => {
        const { args } = run
        const prefs = usePreferencesStore.getState()
        const active =
          prefs.appMode === "editor"
            ? prefs.sidebarOpen && prefs.editorSidebarView === "files"
            : prefs.rightSidebarOpen && prefs.workspaceTab === "files"
        const next = resolveToggleArg(args[0], active)
        if (prefs.appMode === "editor") {
          if (next) prefs.set("editorSidebarView", "files")
          prefs.set("sidebarOpen", next)
        } else if (next) {
          prefs.set("rightSidebarOpen", true)
          prefs.set("workspaceTab", "files")
        } else if (prefs.workspaceTab === "files") {
          prefs.set("workspaceTab", "plan")
        }
        run.output = buildToggleOutput("File Tree", next)
      },
    },
    {
      names: [
        "sidebar",
        "toggle-sidebar",
        "sidebar.toggle",
        "session.sidebar.toggle",
      ],
      run: (run) => {
        const { args } = run
        const prefs = usePreferencesStore.getState()
        const next = resolveToggleArg(args[0], prefs.sidebarOpen)
        prefs.set("sidebarOpen", next)
        run.output = buildToggleOutput("File Tree / Sidebar", next)
      },
    },
    {
      names: ["input-focus", "input.focus", "focus-input", "composer-focus"],
      run: (run) => {
        const { threadId } = run
        focusChatComposerInput(threadId)
        run.output = "# Input Focus\n\nFocused the chat input."
      },
    },
    {
      names: ["animations", "app.toggle.animations", "app-toggle-animations"],
      run: (run) => {
        const { args } = run
        const appearance = useAppearanceStore.getState()
        const next = resolveToggleArg(args[0], appearance.animationsEnabled)
        appearance.set("animationsEnabled", next)
        run.output = buildToggleOutput("Animations", next)
      },
    },
    {
      names: [
        "file-context",
        "app.toggle.file_context",
        "app-toggle-file-context",
      ],
      run: (run) => {
        const { args } = run
        const appearance = useAppearanceStore.getState()
        const next = resolveToggleArg(args[0], appearance.fileContextEnabled)
        appearance.set("fileContextEnabled", next)
        run.output = buildToggleOutput("File Context", next)
      },
    },
    {
      names: [
        "paste-summary",
        "app.toggle.paste_summary",
        "app-toggle-paste-summary",
      ],
      run: (run) => {
        run.output =
          "Pasted text is always inserted directly and remains editable. Paste summaries have been removed."
      },
    },
    {
      names: [
        "session-directory-filter",
        "app.toggle.session_directory_filter",
        "app-toggle-session-directory-filter",
      ],
      run: (run) => {
        const { args } = run
        const appearance = useAppearanceStore.getState()
        const next = resolveToggleArg(
          args[0],
          appearance.sessionDirectoryFilterEnabled
        )
        appearance.set("sessionDirectoryFilterEnabled", next)
        run.output = buildToggleOutput("Session Directory Filter", next)
      },
    },
  ]
