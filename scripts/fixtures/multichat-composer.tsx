import { useState } from "react"
import { createRoot } from "react-dom/client"
import { ChatComposer } from "@/components/chat/chat-composer"
import { FileMentionMenu } from "@/components/file-mentions"
import { ConfirmProvider } from "@/components/dialogs/confirm-provider"
import { PromptProvider } from "@/components/dialogs/prompt-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  emptyStreamState,
  getThreadStream,
  useChatStore,
} from "@/lib/chat-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { useVoiceStore } from "@/lib/voice-store"
import { useVoiceInput } from "@/hooks/use-voice-input"
import { useAutonomousLoop } from "@/hooks/use-autonomous-loop"
import { findComposerTextarea, setComposerInput } from "@/lib/composer-input"
import { dispatchComposerDraftRestoreAfterSubmit } from "@/lib/composer-draft-events"

const provider = {
  id: "codex",
  providerKind: "codex",
  providerInstanceId: "codex",
  name: "Codex",
  logo: "",
  models: [
    { id: "gpt-6-astra", name: "Astra", context: "runtime", tier: "Runtime" },
  ],
}
const noop = () => {}
let composerSubmit: (
  id: string,
  text: string
) => void | boolean | Promise<void | boolean> = noop
let lastActivatedComposer: string | null = null
const autonomousProviders = [
  {
    ...provider,
    models: [
      ...provider.models,
      { id: "gpt-5.6-sol", name: "Sol", context: "runtime", tier: "Runtime" },
    ],
  },
]
function AutonomousProbe() {
  useAutonomousLoop({ providers: autonomousProviders })
  const ownerStreaming = useChatStore(
    (state) => getThreadStream(state, "right").isStreaming
  )
  const focus = useChatStore((state) => state.activeThreadId)
  return (
    <span
      id="autonomous-probe"
      data-streaming={ownerStreaming}
      data-focus={focus}
    />
  )
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function until(read: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0
    const deadline = setTimeout(() => {
      cancelAnimationFrame(frame)
      reject(new Error(label))
    }, 5000)
    const check = () => {
      try {
        if (read()) {
          clearTimeout(deadline)
          resolve()
          return
        }
        frame = requestAnimationFrame(check)
      } catch (error) {
        clearTimeout(deadline)
        reject(error)
      }
    }
    check()
  })
}
function click(button: HTMLElement) {
  button.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" })
  )
  button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
  button.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" })
  )
  button.click()
}
function findButton(
  text: string,
  root: ParentNode = document
): HTMLElement | undefined {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button, [role="menuitem"], [role="option"]'
    ),
  ].find((button) => button.textContent?.trim().startsWith(text))
}

function ComposerFixture({
  minimal,
  leftThread,
}: {
  minimal: boolean
  leftThread: string
}) {
  const active = useChatStore((state) => state.activeThreadId)
  const voice = useVoiceInput()
  const [mentions, setMentions] = useState(false)
  return (
    <ConfirmProvider>
      <PromptProvider>
        <TooltipProvider>
          <button id="show-mentions" onClick={() => setMentions(true)}>
            Show mentions
          </button>
          <button
            id="dictate-right"
            onClick={() => voice.handleVoiceClick("right")}
          >
            Dictate right
          </button>
          <button id="save-voice-setup" onClick={() => voice.startVoice()}>
            Save voice setup
          </button>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              marginTop: 180,
            }}
          >
            {[leftThread, "right"].map((id) => (
              <section
                key={id}
                data-composer-thread={id}
                data-composer-active={active === id}
              >
                <button
                  id={`configure-voice-${id}`}
                  onContextMenu={voice.handleVoiceContextMenu}
                >
                  Configure voice
                </button>
                {id === "right" && (
                  <FileMentionMenu
                    threadId={id}
                    query="right"
                    visible={mentions}
                    projectPath="C:/right-worktree"
                    onSelect={noop}
                    onClose={() => setMentions(false)}
                    setInputText={noop}
                  />
                )}
                <ChatComposer
                  activatePane={() => {
                    lastActivatedComposer = id
                    useChatStore.setState({ activeThreadId: id })
                  }}
                  threadId={id}
                  isActive={active === id}
                  activeProjectPath={`C:/${id}`}
                  minimalChat={minimal}
                  handleSubmit={(message) => composerSubmit(id, message.text)}
                  handleStop={noop}
                  handleVoiceClick={voice.handleVoiceClick}
                  handleVoiceContextMenu={noop}
                  thinkingMode="max"
                  setThinkingMode={noop}
                  autonomousMode={false}
                  autonomousStatus="idle"
                  autonomousTask={null}
                  autonomousIterations={0}
                  autonomousMaxIterations={1}
                  chatMode="agent"
                  setChatMode={noop}
                  specialMode={null}
                  setSpecialMode={noop}
                  permissionLevel="read-only"
                  setPermissionLevel={(value: string) =>
                    useChatStore
                      .getState()
                      .setThreadSetting(id, "permissionLevel", value)
                  }
                  contextWindow="1m"
                  setContextWindow={noop}
                  fastMode={false}
                  setFastMode={noop}
                  currentModelName="Astra"
                  selectedProvider={provider}
                  currentProvider={provider}
                  selectedProviderId="codex"
                  selectedModel="gpt-6-astra"
                  setSelectedModel={noop}
                  setSelectedProviderId={noop}
                  providers={[provider]}
                  favoriteEntries={[]}
                  toggleFavorite={noop}
                  isFavorite={() => false}
                  isLmStudio={false}
                  isStreaming={false}
                  voiceSetupComplete={true}
                  deepgram={{ isRecording: false }}
                  setTerminalOpen={noop}
                  setVoiceModalOpen={noop}
                  setAutonomousDialogOpen={noop}
                  checkSlash={noop}
                  checkMention={noop}
                  appMode="agent"
                />
              </section>
            ))}
          </div>
        </TooltipProvider>
      </PromptProvider>
    </ConfirmProvider>
  )
}

export async function runComposerSmoke() {
  const root = createRoot(document.getElementById("root")!)
  const originalFetch = window.fetch
  const originalElectron = window.electronAPI
  const requests: { url: string; body: Record<string, unknown> }[] = []
  window.fetch = async (input, init) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    requests.push({ url, body })
    if (url.endsWith("/messages") && (!init?.method || init.method === "GET"))
      return Response.json([])
    if (url.endsWith("/settings")) return Response.json({})
    if (url.includes("/chat/send"))
      return Response.json({
        status: "streaming",
        turnId: "fixture-autonomous-turn",
      })
    if (url.includes("/workspace/project-")) return Response.json([])
    if (url.includes("/workspace/effective-rules"))
      return Response.json({ content: "", sources: [] })
    if (url.includes("/workspace/search"))
      return Response.json([
        { name: "right-file.ts", path: "src/right-file.ts", is_dir: false },
      ])
    if (url.includes("/git/is-repo")) return Response.json({ isGitRepo: false })
    if (url.includes("/git/status"))
      return Response.json({
        branch:
          body.cwd === "C:/right-worktree" ? "right-branch" : "left-branch",
        staged: [],
        modified: [],
        untracked: [],
      })
    if (url.includes("/permission")) return Response.json({ status: "ok" })
    return originalFetch(input, init)
  }
  useVoiceStore.setState({ setupComplete: true, init: async () => {} })
  useChatStore.setState({
    activeThreadId: "left",
    draftsByThread: {
      left: "left draft",
      right: "right draft",
      third: "third draft",
    },
    threads: ["left", "right", "third"].map((id) => ({
      id,
      title: id,
      projectName: `${id}-project`,
      projectPath: `C:/${id}`,
      worktreePath: id === "right" ? "C:/right-worktree" : null,
      branch: `${id}-branch`,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      messages: [],
      usage: {
        usedTokens: id === "right" ? 75000 : 10000,
        maxTokens: 100000,
        inputTokens: 0,
        outputTokens: 0,
      },
    })),
  })
  const render = (minimal: boolean, leftThread = "left") =>
    root.render(<ComposerFixture minimal={minimal} leftThread={leftThread} />)
  try {
    for (const minimal of [true, false]) {
      console.log(
        `[smoke] Checking ${minimal ? "simple" : "extended"} composer inputs`
      )
      render(minimal)
      await until(
        () => Boolean(findComposerTextarea("right")),
        "Both composers must mount"
      )
      if (minimal) {
        assert(
          findComposerTextarea("left")!.value === "left draft" &&
            findComposerTextarea("right")!.value === "right draft",
          "Mount must restore each saved draft"
        )
        const rightScope = findComposerTextarea("right")!.closest(
          "[data-composer-thread]"
        )!
        assert(
          rightScope.textContent?.includes("right-project") &&
            !rightScope.textContent?.includes("left-project"),
          "Context chips must use the pane's project"
        )
      }
      const submitInput = findComposerTextarea("right")!
      setComposerInput(submitInput, "one submission")
      await until(
        () => useChatStore.getState().getDraft("right") === "one submission",
        "Submission draft must settle"
      )
      const pendingSubmit = Promise.withResolvers<void>()
      const submissions: string[] = []
      composerSubmit = (id, text) => {
        submissions.push(`${id}:${text}`)
        return pendingSubmit.promise
      }
      submitInput.form!.requestSubmit()
      submitInput.form!.requestSubmit()
      await until(
        () => submissions.length === 1,
        "Repeated submit must dispatch once"
      )
      await until(
        () =>
          Boolean(
            submitInput.form!.querySelector(
              'button[type="submit"]:disabled[aria-busy="true"]'
            )
          ),
        "Preparation must visibly disable Send"
      )
      submitInput.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      )
      setComposerInput(submitInput, "next draft while waiting")
      await until(
        () =>
          useChatStore.getState().getDraft("right") ===
          "next draft while waiting",
        "New draft must settle while sending"
      )
      pendingSubmit.resolve()
      await until(
        () => !submitInput.form!.querySelector('[aria-busy="true"]'),
        "Submission lock must release"
      )
      assert(
        submissions.length === 1 && submissions[0] === "right:one submission",
        "Clicks and Enter must not enqueue duplicates"
      )
      assert(
        submitInput.value === "next draft while waiting",
        "Finishing a send must preserve newly typed text"
      )
      const refusedSubmit = Promise.withResolvers<boolean>()
      composerSubmit = () => refusedSubmit.promise
      submitInput.form!.requestSubmit()
      await until(
        () => Boolean(submitInput.form!.querySelector('[aria-busy="true"]')),
        "Refused submission must enter preparation"
      )
      refusedSubmit.resolve(false)
      await until(
        () => !submitInput.form!.querySelector('[aria-busy="true"]'),
        "Refused submission must unlock"
      )
      assert(
        submitInput.value === "next draft while waiting",
        "Busy refusal must preserve the draft"
      )
      composerSubmit = noop
      submitInput.form!.requestSubmit()
      await until(
        () => submitInput.value === "",
        "Successful retry must clear the submitted draft"
      )

      setComposerInput(findComposerTextarea("right"), "right @right.ts")
      await until(
        () => useChatStore.getState().getDraft("right") === "right @right.ts",
        "Typing must save to the right draft"
      )
      const leftValue = findComposerTextarea("left")!.value
      if (!minimal) {
        const rightScope = findComposerTextarea("right")!.closest(
          "[data-composer-thread]"
        )!
        const leftScope = findComposerTextarea("left")!.closest(
          "[data-composer-thread]"
        )!
        assert(
          rightScope
            .querySelector('[aria-label="Inspect context sources"]')
            ?.textContent?.includes("75.0%"),
          "Context usage must belong to the right chat"
        )
        assert(
          leftScope
            .querySelector('[aria-label="Inspect context sources"]')
            ?.textContent?.includes("10.0%"),
          "Context usage must not mirror the focused chat"
        )
      }
      useChatStore.setState({ activeThreadId: "right" })
      await until(
        () =>
          document
            .querySelector('[data-composer-thread="right"]')
            ?.getAttribute("data-composer-active") === "true",
        "Focus must update"
      )
      assert(
        findComposerTextarea("left")!.value === leftValue,
        "Focus must not replace the other draft"
      )
      assert(
        !findComposerTextarea("left")!
          .closest("[data-composer-thread]")!
          .textContent?.includes("right.ts"),
        "Mention chips must stay in their own composer"
      )

      usePreferencesStore.setState({
        promptHistoryEntries: [
          { id: "history", input: "history entry", timestamp: 1 },
        ],
      })
      const right = findComposerTextarea("right")!
      right.setSelectionRange(0, 0)
      right.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowUp",
          bubbles: true,
          cancelable: true,
        })
      )
      await until(
        () => right.value === "history entry",
        "History keys must affect the event's textarea"
      )
      assert(
        findComposerTextarea("left")!.value === leftValue,
        "History must leave the other composer intact"
      )

      window.dispatchEvent(
        new CustomEvent("betterc0de:insert-prompt", {
          detail: { threadId: "right", text: "right suggestion" },
        })
      )
      await until(
        () => right.value === "right suggestion",
        "Suggestions must target their source chat"
      )
      assert(
        findComposerTextarea("left")!.value === leftValue,
        "Suggestions must not populate every composer"
      )
      dispatchComposerDraftRestoreAfterSubmit({
        threadId: "left",
        text: "restored left",
      })
      await until(
        () => findComposerTextarea("left")!.value === "restored left",
        "Restore must reach its owner while another chat is focused"
      )
      assert(
        right.value === "right suggestion",
        "Restoring the left draft must leave the right draft intact"
      )

      render(minimal, "third")
      await until(
        () => Boolean(findComposerTextarea("third")),
        "Tab switch must mount the other thread"
      )
      assert(
        findComposerTextarea("third")!.value === "third draft",
        "Tab switch must load the destination draft"
      )
      render(minimal)
      await until(
        () => findComposerTextarea("left")?.value === "restored left",
        "Returning to the tab must restore its own draft"
      )

      const inputBeforeAsync = findComposerTextarea("right")!
      useChatStore.setState({ activeThreadId: "left" })
      setComposerInput(inputBeforeAsync, "right clipboard")
      await until(
        () => findComposerTextarea("right")!.value === "right clipboard",
        "Captured clipboard target must survive focus changes"
      )
      click(document.getElementById("dictate-right")!)
      const callbacks = (
        window as unknown as {
          fixtureVoice: { onFinal: (text: string) => void }
        }
      ).fixtureVoice
      assert(callbacks, "Voice capture must start")
      callbacks.onFinal("dictation")
      await until(
        () => right.value.includes("dictation"),
        "Dictation must stay with its captured composer"
      )
      assert(
        findComposerTextarea("left")!.value === "restored left",
        "Dictation must not write into the focused left pane"
      )
      document
        .getElementById("configure-voice-left")!
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
        )
      useChatStore.setState({ activeThreadId: "right" })
      click(document.getElementById("save-voice-setup")!)
      const setupCallbacks = (
        window as unknown as {
          fixtureVoice: { onFinal: (text: string) => void }
        }
      ).fixtureVoice
      const rightBeforeSetup = right.value
      setupCallbacks.onFinal("left setup dictation")
      await until(
        () =>
          findComposerTextarea("left")!.value.includes("left setup dictation"),
        "Saving voice setup must retain the context menu's composer"
      )
      assert(
        right.value === rightBeforeSetup,
        "Voice setup must not reuse the previous recording's composer"
      )
      setComposerInput(findComposerTextarea("left"), "restored left")
      await until(
        () => useChatStore.getState().getDraft("left") === "restored left",
        "Left draft must settle after the voice setup check"
      )

      setComposerInput(findComposerTextarea("right"), "@right")
      click(document.getElementById("show-mentions")!)
      await until(
        () => Boolean(findButton("right-file.ts")),
        "File mention result must load"
      )
      click(findButton("right-file.ts")!)
      await until(
        () => right.value.includes("@src/right-file.ts"),
        "File selection must edit the right composer"
      )
      assert(
        findComposerTextarea("left")!.value === "restored left",
        "File selection must not edit the first textarea"
      )

      const leftScope = findComposerTextarea("left")!.closest(
        "[data-composer-thread]"
      )!
      click(findButton("Read-only", leftScope)!)
      await until(
        () => Boolean(findButton("Bypass Permission")),
        "Permission menu must open"
      )
      click(findButton("Bypass Permission")!)
      await until(
        () => Boolean(findButton("Enable Bypass")),
        "Bypass must require confirmation"
      )
      useChatStore.setState({ activeThreadId: "right" })
      const count = requests.length
      click(findButton("Enable Bypass")!)
      await until(
        () =>
          requests
            .slice(count)
            .some((request) => request.url.includes("/permission")),
        "Confirmed permission must reach the backend"
      )
      assert(
        requests
          .slice(count)
          .filter((request) => request.url.includes("/permission"))
          .every((request) => request.body.threadId === "left"),
        "Confirmation must not apply permissions to the newly focused thread"
      )
      assert(
        useChatStore.getState().settingsByThread.left.permissionLevel ===
          "bypass",
        "Permission preference belongs to the initiating thread"
      )
    }
    console.log("[smoke] Checking delayed project picker ownership")
    let finishFolder: ((path: string | null) => void) | undefined
    window.electronAPI = {
      ...originalElectron,
      pickFolder: () =>
        new Promise<string | null>((resolve) => {
          finishFolder = resolve
        }),
    } as NonNullable<typeof window.electronAPI>
    render(true)
    await until(
      () =>
        Boolean(
          findButton(
            "left-project",
            findComposerTextarea("left")!.closest("[data-composer-thread]")!
          )
        ),
      "Project picker must mount"
    )
    const beginFolderPick = async () => {
      finishFolder = undefined
      click(
        findButton(
          "left-project",
          findComposerTextarea("left")!.closest("[data-composer-thread]")!
        )!
      )
      await until(
        () => Boolean(findButton("New project")),
        "Project menu must open"
      )
      click(findButton("New project")!)
      await until(() => Boolean(finishFolder), "Folder picker must be pending")
    }
    await beginFolderPick()
    useChatStore.setState({ activeThreadId: "right" })
    lastActivatedComposer = null
    finishFolder!("C:/picked-project")
    await until(
      () =>
        useChatStore
          .getState()
          .threads.some((thread) => thread.projectPath === "C:/picked-project"),
      "Selected project must create its chat"
    )
    assert(
      lastActivatedComposer === "left",
      "Delayed folder selection must reactivate its source composer"
    )
    await beginFolderPick()
    render(true, "third")
    await until(
      () => Boolean(findComposerTextarea("third")),
      "Switching the source tab must unmount its project picker"
    )
    const beforeClosedPicker = useChatStore.getState().threads.length
    finishFolder!("C:/discarded-project")
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    assert(
      useChatStore.getState().threads.length === beforeClosedPicker,
      "A closed composer must not create a project in another pane"
    )
    window.electronAPI = originalElectron
    console.log("[smoke] Checking autonomous continuation ownership")
    useChatStore.setState({
      activeThreadId: "right",
      autonomousMode: true,
      autonomousThreadId: "right",
      autonomousStatus: "working",
      autonomousIterations: 0,
      autonomousMaxIterations: 3,
      autonomousTaskList: null,
      autonomousTimeBudgetMin: 0,
      settingsByThread: {
        right: {
          selectedProviderId: "codex",
          selectedModel: "gpt-6-astra",
          permissionLevel: "read-only",
        },
        left: {
          selectedProviderId: "codex",
          selectedModel: "gpt-5.6-sol",
          permissionLevel: "bypass",
        },
      },
      streamingByThread: { right: { ...emptyStreamState, isStreaming: true } },
    })
    root.render(<AutonomousProbe />)
    await until(
      () =>
        document.getElementById("autonomous-probe")?.dataset.streaming ===
        "true",
      "Autonomous loop must observe its owner's turn"
    )
    useChatStore.setState({ activeThreadId: "left" })
    await until(
      () =>
        document.getElementById("autonomous-probe")?.dataset.focus === "left",
      "Another pane must gain focus during the run"
    )
    const beforeContinuation = requests.length
    useChatStore.setState({
      streamingByThread: { right: { ...emptyStreamState, isStreaming: false } },
    })
    await until(
      () =>
        requests
          .slice(beforeContinuation)
          .some((request) => request.url.includes("/chat/send")),
      "Autonomous continuation must dispatch after its owner's turn"
    )
    const continuation = requests
      .slice(beforeContinuation)
      .find((request) => request.url.includes("/chat/send"))!.body
    assert(
      continuation.threadId === "right" &&
        continuation.modelId === "gpt-6-astra",
      "Autonomous continuation must retain its owner's thread and model"
    )
    assert(
      continuation.projectPath === "C:/right-worktree" &&
        continuation.permissionLevel === "read-only",
      "Autonomous continuation must retain its owner's worktree and permissions"
    )
    assert(
      useChatStore.getState().threads.find((thread) => thread.id === "left")
        ?.messages.length === 0,
      "Autonomous work must not add a message to the focused chat"
    )
    useChatStore.getState().resetAutonomous()
  } catch (error) {
    console.error(
      `Composer fixture state: ${useChatStore.getState().autonomousStatus}; requests: ${JSON.stringify(requests.slice(-16))}`
    )
    throw error
  } finally {
    root.unmount()
    window.fetch = originalFetch
    window.electronAPI = originalElectron
  }
}
