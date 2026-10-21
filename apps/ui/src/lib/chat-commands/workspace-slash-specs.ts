import { buildWorkspaceRemoveOutput } from "./runtime-commands"
import {
  type SlashCommandRun,
  type SlashCommandRunSpec,
  abortSlashRun,
} from "./slash-run"
import { resolveAdjacentProjectThread } from "./thread-navigation"
import {
  buildAddSelectionContextOutput,
  buildClearEditorContextOutput,
  buildCloseEditorTabOutput,
  buildOpenFileOutput,
  buildWarpWorkspaceOutput,
  buildWorkspaceListOutput,
  buildWorkspaceNewOutput,
  buildWorkspaceResetOutput,
  buildWorkspaceToggleOutput,
} from "./workspace-actions"

/** Editor files and context, workspace folders, projects and worktrees. */
export const WORKSPACE_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRun>[] =
  [
    {
      names: ["open", "editor", "file.open", "prompt.editor", "prompt-editor"],
      run: async (run) => {
        const { args, threadId } = run
        run.output = await buildOpenFileOutput(threadId, args)
      },
    },
    {
      names: [
        "add-selection",
        "context.addselection",
        "context-add-selection",
        "selection-context",
      ],
      run: (run) => {
        const { threadId } = run
        run.output = buildAddSelectionContextOutput(threadId)
      },
    },
    {
      names: [
        "editor-context-clear",
        "prompt.editor_context.clear",
        "prompt-editor-context-clear",
      ],
      run: (run) => {
        run.output = buildClearEditorContextOutput()
      },
    },
    {
      names: ["close", "close-tab", "tab.close"],
      run: (run) => {
        run.output = buildCloseEditorTabOutput()
      },
    },
    {
      names: [
        "warp",
        "workspace",
        "workspace.set",
        "workspace-set",
        "project.open",
        "project-open",
        "project.update",
        "project-update",
      ],
      run: async (run) => {
        const { args, threadId } = run
        run.output = await buildWarpWorkspaceOutput(threadId, args)
      },
    },
    {
      names: ["project-next", "project.next"],
      run: (run) => {
        const { store, threadId } = run
        const target = resolveAdjacentProjectThread(store.threads, threadId, 1)
        if (target) {
          store.setActiveThread(target.id)
          return abortSlashRun(run)
        }
        run.output =
          "# Next Project\n\n> No other project is represented by recent chats."
      },
    },
    {
      names: ["project-previous", "project.previous", "project-prev"],
      run: (run) => {
        const { store, threadId } = run
        const target = resolveAdjacentProjectThread(store.threads, threadId, -1)
        if (target) {
          store.setActiveThread(target.id)
          return abortSlashRun(run)
        }
        run.output =
          "# Previous Project\n\n> No other project is represented by recent chats."
      },
    },
    {
      names: [
        "workspace-new",
        "workspace.new",
        "worktree.create",
        "worktree-create",
      ],
      run: async (run) => {
        const { threadId } = run
        run.output = await buildWorkspaceNewOutput(threadId)
      },
    },
    {
      names: [
        "workspace-toggle",
        "workspace.toggle",
        "project.list",
        "project-list",
        "project.current",
        "project-current",
      ],
      run: (run) => {
        const { activeThread } = run
        run.output = buildWorkspaceToggleOutput(activeThread)
      },
    },
    {
      names: [
        "workspace-list",
        "workspace.list",
        "worktree-list",
        "worktree.list",
      ],
      run: async (run) => {
        const { activeThread } = run
        run.output = await buildWorkspaceListOutput(activeThread)
      },
    },
    {
      names: [
        "workspace-remove",
        "workspace.remove",
        "worktree-remove",
        "worktree.remove",
      ],
      run: async (run) => {
        const { args, threadId } = run
        run.output = await buildWorkspaceRemoveOutput(threadId, args)
      },
    },
    {
      names: [
        "workspace-reset",
        "workspace.reset",
        "worktree-reset",
        "worktree.reset",
      ],
      run: async (run) => {
        const { args, threadId } = run
        run.output = await buildWorkspaceResetOutput(threadId, args)
      },
    },
  ]
