import { beforeEach, describe, expect, it, vi } from "vitest"
import { useApprovalModalStore } from "./approval-modal-store"
import {
  appUiActions,
  INITIAL_APP_UI_VALUES,
  useAppUiStore,
} from "./app-ui-store"
import { useChatStore } from "./chat-store"

const initial = useAppUiStore.getState()

beforeEach(() => {
  useAppUiStore.setState(initial, true)
  useApprovalModalStore.setState({ planModalOpen: false, target: null })
  useChatStore.setState({ activeThreadId: null })
})

describe("app UI store setters", () => {
  it("accept values and updater functions like useState setters", () => {
    const { setShortcutsOpen, setNewProjectLog } = appUiActions()
    setShortcutsOpen(true)
    setShortcutsOpen((open) => !open)
    setNewProjectLog("npm init\n")
    setNewProjectLog((log) => `${log}done\n`)
    const state = useAppUiStore.getState()
    expect(state.shortcutsOpen).toBe(false)
    expect(state.newProjectLog).toBe("npm init\ndone\n")
  })

  it("does not notify subscribers when a value is unchanged", () => {
    const listener = vi.fn()
    const unsubscribe = useAppUiStore.subscribe(listener)
    appUiActions().setSettingsTab("general")
    appUiActions().setChatSearch("")
    expect(listener).not.toHaveBeenCalled()
    appUiActions().setChatSearch(" ")
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("keeps setter identities stable across updates", () => {
    const before = appUiActions()
    before.setGitModal(true)
    before.setNewProjectName("demo")
    const after = appUiActions()
    expect(after.setGitModal).toBe(before.setGitModal)
    expect(after.setPlanModalContent).toBe(before.setPlanModalContent)
  })
})

describe("plan modal", () => {
  it("records the owning thread and holds the approval modal back while open", () => {
    useChatStore.setState({ activeThreadId: "active" })
    const { setPlanModalContent } = appUiActions()

    setPlanModalContent({
      content: "# Plan",
      sourceProposedPlan: { threadId: "source", planId: "p1" },
      implemented: true,
    })
    expect(useAppUiStore.getState()).toMatchObject({
      planModalContent: "# Plan",
      planModalThreadId: "source",
      planModalSourceProposedPlan: { threadId: "source", planId: "p1" },
      planModalImplemented: true,
    })
    expect(useApprovalModalStore.getState().planModalOpen).toBe(true)

    setPlanModalContent("# Draft")
    expect(useAppUiStore.getState()).toMatchObject({
      planModalContent: "# Draft",
      planModalThreadId: "active",
      planModalSourceProposedPlan: null,
      planModalImplemented: false,
    })

    setPlanModalContent(null)
    expect(useAppUiStore.getState()).toMatchObject({
      planModalContent: null,
      planModalThreadId: null,
    })
    expect(useApprovalModalStore.getState().planModalOpen).toBe(false)
  })
})

describe("new project wizard", () => {
  it("opens with every field reset", () => {
    const actions = appUiActions()
    actions.setNewProjectName("old")
    actions.setNewProjectPath("/tmp/old")
    actions.setNewProjectPM("pnpm")
    actions.setNewProjectTemplate("vite")
    actions.setNewProjectUI("shadcn")
    actions.setNewProjectStep(3)
    actions.setNewProjectStatus("error")
    actions.setNewProjectLog("failed")

    actions.openNewProjectWizard()

    expect(useAppUiStore.getState()).toMatchObject({
      newProjectOpen: true,
      newProjectName: INITIAL_APP_UI_VALUES.newProjectName,
      newProjectPath: "",
      newProjectPM: "npm",
      newProjectTemplate: null,
      newProjectUI: null,
      newProjectStep: 0,
      newProjectStatus: "idle",
      newProjectLog: "",
    })
  })
})
