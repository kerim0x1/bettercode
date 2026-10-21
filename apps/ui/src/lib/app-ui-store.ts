import type { SetStateAction } from "react"
import { create } from "zustand"
import type { ConfirmAction } from "@/lib/confirm-action"
import { useApprovalModalStore } from "@/lib/approval-modal-store"
import { useChatStore } from "@/lib/chat-store"
import {
  normalizePlanModalInput,
  type PlanModalInput,
  type SourceProposedPlanReference,
} from "@/lib/plan-modal"

export type SystemBrowserIntent = "agent-new-thread" | "editor-open-folder"
export type NewProjectStatus = "idle" | "running" | "done" | "error"

/**
 * Transient app chrome state: modal open flags, their one-off inputs, the
 * global confirm-action payload and the New Project wizard.
 *
 * It used to be `useState` inside the app-shell hook, so opening a dialog or
 * typing into one (chat search, the wizard's name field) re-rendered the
 * whole shell, including every chat pane. As a store, only the components
 * that read a value subscribe to it; the shell and everything else get the
 * setters, which never change identity.
 *
 * None of this is persisted: it is per-window and per-session.
 */
export interface AppUiValues {
  modelModalOpen: boolean
  settingsOpen: boolean
  settingsTab: string
  editingFile: string | null
  /** Non-empty while the chat search dialog is open (`" "` opens it empty). */
  chatSearch: string
  chatDateFilter: string
  planModalContent: string | null
  planModalSourceProposedPlan: SourceProposedPlanReference | null
  planModalImplemented: boolean
  planModalThreadId: string | null
  confirmAction: ConfirmAction | null
  editorModeModalOpen: boolean
  editorModalPath: string
  newThreadModalOpen: boolean
  newThreadModalPath: string
  fileExplorerModal: boolean
  fileTreeSidebar: boolean
  gitModal: boolean
  marketplaceOpen: boolean
  shortcutsOpen: boolean
  commandPaletteOpen: boolean
  quickOpenOpen: boolean
  goToLineOpen: boolean
  documentSymbolsOpen: boolean
  workspaceSymbolsOpen: boolean
  autonomousDialogOpen: boolean
  systemBrowserOpen: boolean
  systemBrowserIntent: SystemBrowserIntent
  newProjectOpen: boolean
  newProjectStep: number
  newProjectName: string
  newProjectPath: string
  newProjectPM: string
  newProjectTemplate: string | null
  newProjectUI: string | null
  newProjectStatus: NewProjectStatus
  newProjectLog: string
}

/** Same contract as a `useState` setter, including updater functions. */
export type AppUiSetter<T> = (value: SetStateAction<T>) => void

type PlanModalKey =
  | "planModalContent"
  | "planModalSourceProposedPlan"
  | "planModalImplemented"
  | "planModalThreadId"
type SimpleKey = Exclude<keyof AppUiValues, PlanModalKey>

export type AppUiSetters = {
  [K in SimpleKey as `set${Capitalize<K>}`]: AppUiSetter<AppUiValues[K]>
}

export interface AppUiActions extends AppUiSetters {
  /**
   * Opens (or, with `null`, closes) the plan modal. Records which thread the
   * plan belongs to and latches the approval modal closed in the same tick,
   * so the two dialogs never stack.
   */
  setPlanModalContent: (input: PlanModalInput) => void
  /** Resets every wizard field and opens the New Project dialog. */
  openNewProjectWizard: () => void
}

export type AppUiState = AppUiValues & AppUiActions

const NEW_PROJECT_WIZARD_DEFAULTS = {
  newProjectOpen: false,
  newProjectStep: 0,
  newProjectName: "",
  newProjectPath: "",
  newProjectPM: "npm",
  newProjectTemplate: null,
  newProjectUI: null,
  newProjectStatus: "idle",
  newProjectLog: "",
} satisfies Partial<AppUiValues>

export const INITIAL_APP_UI_VALUES: AppUiValues = {
  modelModalOpen: false,
  settingsOpen: false,
  settingsTab: "general",
  editingFile: null,
  chatSearch: "",
  chatDateFilter: "all",
  planModalContent: null,
  planModalSourceProposedPlan: null,
  planModalImplemented: false,
  planModalThreadId: null,
  confirmAction: null,
  editorModeModalOpen: false,
  editorModalPath: "",
  newThreadModalOpen: false,
  newThreadModalPath: "",
  fileExplorerModal: false,
  fileTreeSidebar: true,
  gitModal: false,
  marketplaceOpen: false,
  shortcutsOpen: false,
  commandPaletteOpen: false,
  quickOpenOpen: false,
  goToLineOpen: false,
  documentSymbolsOpen: false,
  workspaceSymbolsOpen: false,
  autonomousDialogOpen: false,
  systemBrowserOpen: false,
  systemBrowserIntent: "agent-new-thread",
  ...NEW_PROJECT_WIZARD_DEFAULTS,
}

function applyUpdate<T>(value: SetStateAction<T>, previous: T): T {
  return typeof value === "function"
    ? (value as (previous: T) => T)(previous)
    : value
}

export const useAppUiStore = create<AppUiState>()((set, get) => {
  const field =
    <K extends SimpleKey>(key: K): AppUiSetter<AppUiValues[K]> =>
    (value) => {
      const previous = get()[key]
      const next = applyUpdate(value, previous)
      if (Object.is(next, previous)) return
      set({ [key]: next } as Pick<AppUiValues, K>)
    }

  return {
    ...INITIAL_APP_UI_VALUES,
    setModelModalOpen: field("modelModalOpen"),
    setSettingsOpen: field("settingsOpen"),
    setSettingsTab: field("settingsTab"),
    setEditingFile: field("editingFile"),
    setChatSearch: field("chatSearch"),
    setChatDateFilter: field("chatDateFilter"),
    setConfirmAction: field("confirmAction"),
    setEditorModeModalOpen: field("editorModeModalOpen"),
    setEditorModalPath: field("editorModalPath"),
    setNewThreadModalOpen: field("newThreadModalOpen"),
    setNewThreadModalPath: field("newThreadModalPath"),
    setFileExplorerModal: field("fileExplorerModal"),
    setFileTreeSidebar: field("fileTreeSidebar"),
    setGitModal: field("gitModal"),
    setMarketplaceOpen: field("marketplaceOpen"),
    setShortcutsOpen: field("shortcutsOpen"),
    setCommandPaletteOpen: field("commandPaletteOpen"),
    setQuickOpenOpen: field("quickOpenOpen"),
    setGoToLineOpen: field("goToLineOpen"),
    setDocumentSymbolsOpen: field("documentSymbolsOpen"),
    setWorkspaceSymbolsOpen: field("workspaceSymbolsOpen"),
    setAutonomousDialogOpen: field("autonomousDialogOpen"),
    setSystemBrowserOpen: field("systemBrowserOpen"),
    setSystemBrowserIntent: field("systemBrowserIntent"),
    setNewProjectOpen: field("newProjectOpen"),
    setNewProjectStep: field("newProjectStep"),
    setNewProjectName: field("newProjectName"),
    setNewProjectPath: field("newProjectPath"),
    setNewProjectPM: field("newProjectPM"),
    setNewProjectTemplate: field("newProjectTemplate"),
    setNewProjectUI: field("newProjectUI"),
    setNewProjectStatus: field("newProjectStatus"),
    setNewProjectLog: field("newProjectLog"),

    setPlanModalContent: (input) => {
      const payload = normalizePlanModalInput(input)
      set({
        planModalThreadId: payload
          ? (payload.sourceProposedPlan?.threadId ??
            (payload.threadId === undefined
              ? useChatStore.getState().activeThreadId
              : payload.threadId))
          : null,
        planModalContent: payload?.content ?? null,
        planModalSourceProposedPlan: payload?.sourceProposedPlan ?? null,
        planModalImplemented: Boolean(payload?.implemented),
      })
      // Same tick as the state write, so there's no frame where the approval
      // modal could mount on top of the plan dialog.
      useApprovalModalStore.getState().setPlanModalOpen(payload !== null)
    },

    openNewProjectWizard: () =>
      set({ ...NEW_PROJECT_WIZARD_DEFAULTS, newProjectOpen: true }),
  }
})

/**
 * The store's setters. They are created once with the store, so reading
 * them does not subscribe the caller to any value.
 */
export function appUiActions(): AppUiActions {
  return useAppUiStore.getState()
}
