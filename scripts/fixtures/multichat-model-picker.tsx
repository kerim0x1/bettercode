import { createElement, StrictMode, useState, type ComponentProps } from "react"
import { createRoot } from "react-dom/client"
import { ConfirmProvider } from "@/components/dialogs/confirm-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ChatColumn } from "@/components/layout/chat-column"
import { useChatStore } from "@/lib/chat-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { useSettingsStore } from "@/lib/settings-store"
import type { UiProvider } from "@/lib/provider-types"
import { usePanes } from "@/hooks/use-panes"
import { runFileReviewSmoke } from "./multichat-file-review"
import { runComposerSmoke } from "./multichat-composer"
import { runTerminalSmoke } from "./multichat-terminal"

const providers: UiProvider[] = [
  {
    id: "codex",
    providerKind: "codex",
    name: "Codex",
    logo: "",
    models: [
      { id: "gpt-6-astra", name: "Astra", context: "runtime", tier: "Runtime" },
      { id: "gpt-5.6-sol", name: "Sol", context: "runtime", tier: "Runtime" },
    ],
  },
  {
    id: "claude",
    providerKind: "claude",
    name: "Claude",
    logo: "",
    models: [
      {
        id: "claude-fable-5",
        name: "Fable 5",
        context: "runtime",
        tier: "Runtime",
      },
    ],
  },
]
const noop = () => {}
const ignoredLayoutProps = {
  appMode: "agent",
  sidebarOpen: false,
  setSidebarOpen: noop,
  minimalChat: true,
  chatMode: "agent",
  handleSubmit: noop,
  setConfirmAction: noop,
  setPlanModalContent: noop,
  selectedProvider: providers[0],
  selectedModel: "gpt-6-astra",
  thinkingMode: null,
  specialMode: null,
  permissionLevel: "read-only",
  mentionQuery: "",
  mentionActive: false,
  slashActive: false,
  slashQuery: "",
  slashTrigger: "/",
  closeMention: noop,
  closeSlash: noop,
  handleSlashSelect: noop,
  deepgram: { error: null },
  terminalOpen: false,
  setTerminalOpen: noop,
  diffOpen: false,
  setDiffOpen: noop,
} as const

// Network I/O is an explicit stub in this renderer fixture. No live backend,
// subscriptions, provider processes or user profile are reachable.
const modelSwitchRequests: string[] = []
window.__BETTERC0DE__ = { port: 1, mode: "electron" }
window.fetch = async (input) => {
  const url = String(input)
  if (url.endsWith("/activities/model-switch")) modelSwitchRequests.push(url)
  return url.endsWith("/activities")
    ? Response.json([])
    : new Response(null, { status: 204 })
}
useSettingsStore.setState({ autoSaveConversations: false })
usePreferencesStore.setState({
  selectedProviderId: "codex",
  selectedModel: "gpt-5.6-sol",
  fastMode: false,
  modelSelectionByProvider: { codex: { selectedModel: "gpt-5.6-sol" } },
})
useChatStore.setState({
  activeThreadId: "right",
  streamingByThread: {},
  activitiesByThread: {},
  threads: ["left", "right"].map((id) => ({
    id,
    title: id,
    projectName: "Test",
    projectPath: "",
    messages: [],
    createdAt: "2026-09-05",
    updatedAt: "2026-09-05",
  })),
  messagesLoadedByThread: { left: true, right: true },
  activitiesLoadedByThread: { left: true, right: true },
  // Existing chats from before provider-scoped settings were introduced.
  settingsByThread: {
    left: {
      selectedProviderId: "codex",
      selectedModel: "gpt-6-astra",
      thinkingMode: "max",
    },
    right: {
      selectedProviderId: "claude",
      selectedModel: "claude-fable-5",
      thinkingMode: "max",
    },
  },
})

function Fixture() {
  const [activePane, setActivePane] = useState("right")
  const [externalOpen, setExternalOpen] = useState(false)
  const composerProps = {
    providers,
    favoriteEntries: [],
    isFavorite: () => false,
    toggleFavorite: noop,
    modelPickerOpen: externalOpen,
    setModelPickerOpen: setExternalOpen,
    deepgram: { isRecording: false },
    voiceSetupComplete: false,
    handleStop: noop,
    handleVoiceClick: noop,
    handleVoiceContextMenu: noop,
  }
  return (
    <>
      <button id="external-picker" onClick={() => setExternalOpen(true)}>
        Open picker command
      </button>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 24,
          marginTop: 400,
        }}
      >
        {["left", "right"].map((id) => (
          <section key={id} data-pane={id}>
            <button
              data-focus={id}
              onClick={() => {
                setActivePane(id)
                useChatStore.getState().setActiveThread(id)
              }}
            >
              Focus {id}
            </button>
            <ChatColumn
              {...ignoredLayoutProps}
              threadId={id}
              tabId={id}
              isActive={activePane === id}
              onActivate={() => {
                setActivePane(id)
                useChatStore.getState().setActiveThread(id)
              }}
              composerProps={composerProps}
            />
          </section>
        ))}
      </div>
    </>
  )
}

function PaneFixture() {
  const panes = usePanes()
  const [externalOpen, setExternalOpen] = useState(false)
  return (
    <>
      <button id="add-pane" onClick={panes.addPane}>
        Add pane
      </button>
      <button
        id="split-existing"
        onClick={() =>
          panes.openThreadOnPane(
            "saved-right",
            "Existing chat",
            panes.paneLayout.panes[0].id,
            "right"
          )
        }
      >
        Open existing chat beside blank pane
      </button>
      <button id="external-picker" onClick={() => setExternalOpen(true)}>
        Open picker command
      </button>
      {panes.paneLayout.panes.map((pane, index) => {
        const tab = pane.tabs.find((entry) => entry.id === pane.activeTabId)!
        return (
          <section
            key={pane.id}
            data-pane={index === 0 ? "left" : "right"}
            data-thread={tab.threadId ?? ""}
          >
            <button
              data-focus={index === 0 ? "left" : "right"}
              onClick={() => panes.setActivePane(pane.id)}
            >
              Focus pane
            </button>
            <button
              data-close-tab={index === 0 ? "left" : "right"}
              onClick={() => panes.closeTab(pane.id, tab.id)}
            >
              Close chat tab
            </button>
            <ChatColumn
              {...ignoredLayoutProps}
              tabId={tab.id}
              threadId={tab.threadId}
              isActive={panes.paneLayout.activePaneId === pane.id}
              onActivate={() => panes.setActivePane(pane.id)}
              composerProps={{
                providers,
                favoriteEntries: [],
                isFavorite: () => false,
                toggleFavorite: noop,
                modelPickerOpen: externalOpen,
                setModelPickerOpen: setExternalOpen,
                deepgram: { isRecording: false },
                voiceSetupComplete: false,
                handleStop: noop,
                handleVoiceClick: noop,
                handleVoiceContextMenu: noop,
              }}
            />
          </section>
        )
      })}
    </>
  )
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function eventually<T>(read: () => T | undefined): Promise<T> {
  const start = performance.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        const value = read()
        if (value !== undefined) {
          resolve(value)
          return
        }
        if (performance.now() - start > 5000) {
          reject(new Error("Timed out waiting for dropdown state"))
          return
        }
        requestAnimationFrame(check)
      } catch (error) {
        reject(error)
      }
    }
    check()
  })
}
function click(target: HTMLElement) {
  target.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" })
  )
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  target.click()
}
function modelTrigger(pane: string) {
  return document.querySelector<HTMLElement>(
    `[data-pane="${pane}"] button:has(svg.lucide-chevron-down)`
  )
}
function menuControl(text: string) {
  return [
    ...document.querySelectorAll<HTMLElement>(
      "[data-simple-dropdown-panel] button, [data-simple-dropdown-panel] [role=button]"
    ),
  ].find(
    (element) =>
      [...element.querySelectorAll("span")].some(
        (span) => span.textContent === text
      ) &&
      getComputedStyle(element.closest("[data-simple-dropdown-panel]")!)
        .pointerEvents !== "none"
  )
}
async function selectModel(pane: string, provider: string, model: string) {
  const trigger = await eventually(() => modelTrigger(pane) ?? undefined)
  click(trigger)
  click(await eventually(() => menuControl("Model")))
  click(await eventually(() => menuControl(provider)))
  click(await eventually(() => menuControl(model)))
  await eventually(() =>
    modelTrigger(pane)?.textContent?.includes(model) ? true : undefined
  )
}
const modelIds: Record<string, string> = {
  Astra: "gpt-6-astra",
  Sol: "gpt-5.6-sol",
  "Fable 5": "claude-fable-5",
}
function expectModels(left: string, right: string) {
  assert(
    modelTrigger("left")?.textContent?.includes(left),
    `Left pane should show ${left}: ${modelTrigger("left")?.textContent}`
  )
  assert(
    modelTrigger("right")?.textContent?.includes(right),
    `Right pane should show ${right}: ${modelTrigger("right")?.textContent}`
  )
}

declare global {
  interface Window {
    runMultichatSmoke: () => Promise<string>
    runComposerSmoke: () => Promise<string>
    runTerminalSmoke: () => Promise<string>
  }
}
window.runMultichatSmoke = async () => {
  console.log("[smoke] Checking model dropdowns")
  const root = createRoot(document.getElementById("root")!)
  root.render(
    createElement(
      ConfirmProvider,
      null,
      createElement(TooltipProvider, null, createElement(Fixture))
    )
  )
  await eventually(() => modelTrigger("left") ?? undefined)
  expectModels("Astra", "Fable 5")
  await selectModel("left", "Codex", "Sol")
  expectModels("Sol", "Fable 5")
  await selectModel("right", "Codex", "Astra")
  expectModels("Sol", "Astra")
  await selectModel("left", "Claude", "Fable 5")
  expectModels("Fable 5", "Astra")
  // An open picker cannot migrate to the opposite pane when focus changes.
  click(modelTrigger("left")!)
  await eventually(() => menuControl("Model"))
  click(document.querySelector<HTMLElement>('[data-focus="right"]')!)
  await eventually(() => (menuControl("Model") ? undefined : true))
  expectModels("Fable 5", "Astra")
  // Slash/command-palette opening still targets the focused pane.
  click(document.getElementById("external-picker")!)
  await eventually(() => menuControl("Model"))
  click(await eventually(() => menuControl("Model")))
  click(await eventually(() => menuControl("Codex")))
  click(await eventually(() => menuControl("Sol")))
  await eventually(() =>
    useChatStore.getState().settingsByThread.right?.selectedModel ===
    modelIds.Sol
      ? true
      : undefined
  )
  expectModels("Fable 5", "Sol")
  root.render(null)
  await eventually(() => (modelTrigger("left") ? undefined : true))
  useChatStore.setState({
    activeThreadId: null,
    threads: [],
    settingsByThread: {},
    activitiesByThread: {},
  })
  usePreferencesStore.setState({
    appMode: "agent",
    selectedProviderId: "codex",
    selectedModel: "gpt-6-astra",
    modelSelectionByProvider: { codex: { selectedModel: "gpt-6-astra" } },
  })
  root.render(
    createElement(
      StrictMode,
      null,
      createElement(
        ConfirmProvider,
        null,
        createElement(TooltipProvider, null, createElement(PaneFixture))
      )
    )
  )
  await eventually(() => modelTrigger("left") ?? undefined)
  click(document.getElementById("add-pane")!)
  await eventually(() => modelTrigger("right") ?? undefined)
  await selectModel("right", "Claude", "Fable 5")
  expectModels("Astra", "Fable 5")
  const leftThread =
    document.querySelector<HTMLElement>('[data-pane="left"]')!.dataset.thread!
  const rightThread = document.querySelector<HTMLElement>(
    '[data-pane="right"]'
  )!.dataset.thread!
  assert(
    leftThread && rightThread && leftThread !== rightThread,
    "Both panes must have separate chat IDs"
  )
  assert(
    useChatStore.getState().threads.length === 2,
    "Opening two panes must create exactly two chats"
  )
  const writesBeforeLeftChange = modelSwitchRequests.length
  await selectModel("left", "Codex", "Sol")
  expectModels("Sol", "Fable 5")
  await eventually(() =>
    modelSwitchRequests.length > writesBeforeLeftChange ? true : undefined
  )
  assert(
    modelSwitchRequests
      .slice(writesBeforeLeftChange)
      .every((url) => url.includes(`/threads/${leftThread}/`)),
    "Left model changes must be persisted to the left chat only"
  )
  click(document.querySelector<HTMLElement>('[data-close-tab="left"]')!)
  await eventually(() => {
    const id =
      document.querySelector<HTMLElement>('[data-pane="left"]')?.dataset.thread
    return id && id !== leftThread ? id : undefined
  })
  assert(
    useChatStore.getState().threads.length === 3,
    "Replacing the last chat tab must create exactly one chat"
  )
  await selectModel("left", "Codex", "Astra")
  expectModels("Astra", "Fable 5")
  click(document.querySelector<HTMLElement>('[data-focus="right"]')!)
  click(document.getElementById("external-picker")!)
  click(await eventually(() => menuControl("Model")))
  click(await eventually(() => menuControl("Codex")))
  click(await eventually(() => menuControl("Sol")))
  await eventually(() =>
    modelTrigger("right")?.textContent?.includes("Sol") ? true : undefined
  )
  expectModels("Astra", "Sol")
  root.render(null)
  await eventually(() => (modelTrigger("left") ? undefined : true))
  useChatStore.setState({
    activeThreadId: null,
    threads: [
      {
        id: "saved-right",
        title: "hey",
        projectName: "Test",
        projectPath: "",
        messages: [
          {
            id: "saved-message",
            role: "user",
            content: "hey",
            createdAt: "2026-09-05",
          },
        ],
        createdAt: "2026-09-05",
        updatedAt: "2026-09-05",
      },
    ],
    settingsByThread: {
      "saved-right": {
        selectedProviderId: "claude",
        selectedModel: "claude-fable-5",
      },
    },
    activitiesByThread: {},
    messagesLoadedByThread: { "saved-right": true },
    activitiesLoadedByThread: { "saved-right": true },
  })
  usePreferencesStore.setState({
    selectedProviderId: "codex",
    selectedModel: "gpt-6-astra",
    modelSelectionByProvider: { codex: { selectedModel: "gpt-6-astra" } },
  })
  root.render(
    createElement(
      StrictMode,
      null,
      createElement(
        ConfirmProvider,
        null,
        createElement(TooltipProvider, null, createElement(PaneFixture))
      )
    )
  )
  await eventually(() => modelTrigger("left") ?? undefined)
  click(document.getElementById("split-existing")!)
  await eventually(() => modelTrigger("right") ?? undefined)
  expectModels("Astra", "Fable 5")
  await selectModel("right", "Codex", "Sol")
  expectModels("Astra", "Sol")
  await selectModel("left", "Claude", "Fable 5")
  expectModels("Fable 5", "Sol")
  assert(
    useChatStore.getState().threads.length === 2,
    "Opening an existing chat beside the initial pane must create only the placeholder's chat"
  )
  console.log("[smoke] Checking file review actions")
  await runFileReviewSmoke(root)
  await runComposerSmoke()
  await runTerminalSmoke()
  return "PASS: model dropdowns, file reviews, pane creation, composer inputs, context usage, permission confirmations and autonomous continuation remain scoped to their owning chats"
}
window.runComposerSmoke = async () => {
  await runComposerSmoke()
  return "PASS: composer drafts, history, suggestions, mentions, dictation, context usage, permission confirmation and autonomous continuation ownership"
}
window.runTerminalSmoke = async () => {
  await runTerminalSmoke()
  return "PASS: terminal events, explicit targets, manual execution and session working directories"
}

// Keep the fixture's public props checked without loading it in the app bundle.
void (ignoredLayoutProps satisfies Partial<ComponentProps<typeof ChatColumn>>)
