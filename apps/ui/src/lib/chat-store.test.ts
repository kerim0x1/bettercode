import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that pulls them in
// ---------------------------------------------------------------------------

vi.mock("@/services/backend/coreApi", () => ({
  upsertThreadMeta: vi.fn().mockResolvedValue(undefined),
  saveThread: vi.fn().mockResolvedValue(undefined),
  saveThreadMessage: vi.fn().mockResolvedValue(undefined),
  deleteThreadDb: vi.fn().mockResolvedValue(undefined),
  loadMessages: vi.fn().mockResolvedValue([]),
  loadMessage: vi.fn(),
}))
vi.mock("@/services/backend/chatApi", () => ({
  loadThreadActivities: vi.fn().mockResolvedValue([]),
  generateTitle: vi.fn().mockResolvedValue("AI Title"),
}))

const clearCheckpointsForThread = vi.hoisted(() => vi.fn())
vi.mock("@/lib/checkpoint-store", () => ({
  autoCheckpointFromToolCalls: vi.fn().mockResolvedValue(undefined),
  useCheckpointStore: { getState: () => ({ clearCheckpointsForThread }) },
}))

// Provide a minimal crypto.randomUUID so we get deterministic-ish IDs in Node
if (typeof globalThis.crypto === "undefined") {
  let counter = 0
  ;(globalThis as unknown as { crypto: { randomUUID: () => string } }).crypto =
    {
      randomUUID: () => `test-uuid-${++counter}`,
    }
}

import { useChatStore, emptyStreamState } from "@/lib/chat-store"
import { autoCheckpointFromToolCalls } from "@/lib/checkpoint-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { resolveComposerPreferences } from "@/lib/composer-settings"
import type { ChatMessage, ThreadActivity } from "@/lib/chat-store"
import type { ThreadAutonomy } from "@betterc0de/schema"
import {
  upsertThreadMeta as upsertThreadMetaDb,
  saveThread as saveThreadDb,
  saveThreadMessage as _saveThreadMessageDb,
  deleteThreadDb,
  loadMessage,
  loadMessages,
} from "@/services/backend/coreApi"
import { loadThreadActivities } from "@/services/backend/chatApi"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset the zustand store to pristine state between tests.
 *  We intentionally omit the `true` (replace) flag so that action
 *  functions created by zustand's `create()` callback are preserved. */
function resetStore() {
  useChatStore.setState({
    threads: [],
    activeThreadId: null,
    streamingByThread: {},
    activitiesByThread: {},
    activitiesLoadedByThread: {},
    messagesLoadedByThread: {},
    messageHydrationErrorsByThread: {},
    olderMessagesCursorByThread: {},
    olderMessagesLoadingByThread: {},
    lruOrder: [],
    pinnedThreadIds: new Set(),
    draftsByThread: {},
    settingsByThread: {},
    lastUsage: null,
    autonomyByThread: {},
  })
}

function makeRun(overrides: Partial<ThreadAutonomy> = {}): ThreadAutonomy {
  return {
    id: "run",
    status: "working",
    tasks: [{ id: "parser", text: "Write the parser", done: false }],
    iterations: 0,
    maxIterations: 50,
    timeBudgetMin: 90,
    startedAt: 1,
    updatedAt: 1,
    stopReason: null,
    ...overrides,
  }
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: "hello",
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeActivity(overrides: Partial<ThreadActivity> = {}): ThreadActivity {
  const id = overrides.id ?? crypto.randomUUID()
  return {
    id,
    threadId: overrides.threadId ?? "thread-1",
    turnId: overrides.turnId ?? null,
    providerInstanceId: overrides.providerInstanceId ?? null,
    kind: overrides.kind ?? "tool.started",
    tone: overrides.tone ?? "info",
    summary: overrides.summary ?? "activity",
    payload: overrides.payload ?? {},
    sequence: overrides.sequence ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("chat-store", () => {
  beforeEach(() => {
    resetStore()
    usePreferencesStore.setState(usePreferencesStore.getInitialState())
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps a completed handoff when an older hydration result and replay event arrive", async () => {
    const id = useChatStore.getState().createThread("Handoff", "project")
    const payload = {
      status: "compacting",
      requestMessageId: "request",
      checkpointMessageId: "checkpoint",
      sourceProvider: "claude",
      targetProvider: "codex",
      sourceModel: "model",
    }
    const pending = makeActivity({
      id: "handoff",
      threadId: id,
      kind: "context.provider-handoff",
      sequence: 1,
      payload,
    })
    const completed = {
      ...pending,
      sequence: 2,
      payload: { ...payload, status: "completed" },
    }
    useChatStore.getState().upsertThreadActivity(id, pending)
    let resolveSnapshot: (rows: ThreadActivity[]) => void = () => {
      throw new Error("Hydration did not start")
    }
    vi.mocked(loadThreadActivities).mockImplementationOnce(
      () =>
        new Promise<ThreadActivity[]>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const hydration = useChatStore.getState().hydrateThreadActivities(id, true)
    useChatStore.getState().upsertThreadActivity(id, completed)
    resolveSnapshot([pending])
    await hydration
    expect(useChatStore.getState().activitiesByThread[id]).toEqual([completed])
    useChatStore.getState().upsertThreadActivity(id, pending)
    expect(useChatStore.getState().activitiesByThread[id]).toEqual([completed])
  })

  // -----------------------------------------------------------------------
  // 1. createThread
  // -----------------------------------------------------------------------
  describe("createThread", () => {
    it("ignores retired Feature modes in saved global and thread preferences", () => {
      const preferences = {
        ...usePreferencesStore.getState(),
        specialMode: "frontend",
      }
      expect(
        resolveComposerPreferences(preferences, undefined).specialMode
      ).toBeNull()
      expect(
        resolveComposerPreferences(preferences, {
          specialMode: "performance",
          chatMode: "plan",
        })
      ).toMatchObject({ specialMode: null, chatMode: "plan" })
    })

    it("freezes the defaults of a fresh chat before another pane changes them", () => {
      usePreferencesStore.setState({
        selectedProviderId: "codex",
        selectedModel: "gpt-6-astra",
        modelSelectionByProvider: {
          codex: { selectedModel: "gpt-6-astra", thinkingMode: "max" },
        },
      })
      const id = useChatStore.getState().createThread("First", "proj")
      usePreferencesStore.setState({
        selectedModel: "gpt-5.6-sol",
        modelSelectionByProvider: {
          codex: { selectedModel: "gpt-5.6-sol", thinkingMode: "high" },
        },
      })
      expect(
        resolveComposerPreferences(
          usePreferencesStore.getState(),
          useChatStore.getState().settingsByThread[id]
        )
      ).toMatchObject({
        selectedModel: "gpt-6-astra",
        thinkingMode: "max",
      })
    })

    it("initializes an older chat once without replacing its legacy selection", () => {
      const id = useChatStore.getState().createThread("Older", "proj")
      useChatStore.setState({
        settingsByThread: {
          [id]: {
            selectedProviderId: "codex",
            selectedModel: "gpt-6-astra",
            thinkingMode: null,
          },
        },
      })
      usePreferencesStore.setState({
        modelSelectionByProvider: {
          codex: { selectedModel: "gpt-5.6-sol", thinkingMode: "high" },
        },
      })
      useChatStore.getState().initializeThreadModelSettings(id)
      const initialized = useChatStore.getState().settingsByThread[id]
      expect(initialized?.modelSelectionByProvider?.codex).toMatchObject({
        selectedModel: "gpt-6-astra",
        thinkingMode: null,
      })
      usePreferencesStore.setState({ fastMode: true })
      useChatStore.getState().initializeThreadModelSettings(id)
      expect(useChatStore.getState().settingsByThread[id]).toBe(initialized)
    })

    it("creates a thread, marks it loaded, touches LRU, and persists", () => {
      const store = useChatStore.getState()
      const id = store.createThread("Test Thread", "my-project", "/path")

      const state = useChatStore.getState()
      const thread = state.threads.find((t) => t.id === id)

      expect(thread).toBeDefined()
      expect(thread!.title).toBe("Test Thread")
      expect(thread!.projectName).toBe("my-project")
      expect(thread!.projectPath).toBe("/path")
      expect(thread!.messages).toEqual([])
      expect(state.activeThreadId).toBe(id)
      expect(state.messagesLoadedByThread[id]).toBe(true)
      expect(state.lruOrder).toContain(id)

      // Persist is called after debounce
      vi.advanceTimersByTime(600)
      expect(upsertThreadMetaDb).toHaveBeenCalled()
    })

    it("creates thread with empty projectPath when omitted", () => {
      const id = useChatStore.getState().createThread("T", "proj")
      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.projectPath).toBe("")
      expect(thread!.envMode).toBe("local")
      expect(thread!.worktreeState).toBe("none")
    })

    it("creates contextual worktree threads with branch metadata", () => {
      const id = useChatStore.getState().createThread("T", "proj", "/repo", {
        envMode: "worktree",
        branch: "agent/thread-1",
        worktreePath: "/repo-worktree",
        baseBranch: "main",
        worktreeState: "ready",
      })
      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread).toMatchObject({
        envMode: "worktree",
        branch: "agent/thread-1",
        worktreePath: "/repo-worktree",
        baseBranch: "main",
        worktreeState: "ready",
      })
    })

    it("inherits the active chat's latest provider and model selection", () => {
      const store = useChatStore.getState()
      const sourceId = store.createThread("Source", "proj", "/repo")
      store.setThreadSetting(sourceId, "selectedProviderId", "claude")
      store.setThreadSetting(sourceId, "selectedModel", "claude-opus-4-7")
      store.setThreadSetting(sourceId, "modelSelectionByProvider", {
        claude: {
          selectedModel: "claude-opus-4-7",
          thinkingMode: "High",
        },
      })
      store.setThreadSetting(sourceId, "chatMode", "plan")

      const nextId = store.createThread("New Chat", "proj", "/repo")
      const nextSettings = useChatStore.getState().settingsByThread[nextId]

      expect(nextSettings).toEqual({
        selectedProviderId: "claude",
        selectedModel: "claude-opus-4-7",
        modelSelectionByProvider: {
          claude: {
            selectedModel: "claude-opus-4-7",
            thinkingMode: "High",
            contextWindow: "1m",
            fastMode: false,
            optionSelections: [],
          },
        },
      })
      expect(nextSettings?.chatMode).toBeUndefined()
    })

    it("forks a thread with copied history, new message ids, and no provider session id", async () => {
      const store = useChatStore.getState()
      const sourceId = store.createThread("Source", "proj", "/repo")
      store.setThreadSetting(sourceId, "selectedModel", "gpt-5.5")
      store.addMessage(
        sourceId,
        makeMessage({
          id: "msg-1",
          content: "hello",
          attachments: [
            {
              type: "file",
              filename: "screen.png",
              mediaType: "image/png",
              url: "data:image/png;base64,aGVsbG8=",
            },
          ],
        })
      )
      store.addMessage(
        sourceId,
        makeMessage({
          id: "msg-2",
          role: "assistant",
          content: "world",
          turnId: "turn-1",
        })
      )

      const forkId = await store.forkThread(sourceId)

      expect(forkId).toBeTruthy()
      const state = useChatStore.getState()
      const source = state.threads.find((t) => t.id === sourceId)!
      const fork = state.threads.find((t) => t.id === forkId)!
      expect(state.activeThreadId).toBe(forkId)
      expect(fork.title).toBe(`${source.title} (fork)`)
      expect(fork.projectPath).toBe("/repo")
      expect(fork.parentThreadId).toBe(sourceId)
      expect(fork.codexThreadId).toBeNull()
      expect(fork.messages.map((message) => message.content)).toEqual(
        source.messages.map((message) => message.content)
      )
      expect(fork.messages[0].attachments).toEqual(
        source.messages[0].attachments
      )
      expect(fork.messages.map((message) => message.id)).not.toEqual(
        source.messages.map((message) => message.id)
      )
      expect(fork.messages.every((message) => message.turnId === null)).toBe(
        true
      )
      expect(state.settingsByThread[forkId!]?.selectedModel).toBe("gpt-5.5")
      expect(saveThreadDb).toHaveBeenCalledWith(
        expect.objectContaining({
          id: forkId,
          parentThreadId: sourceId,
          codexThreadId: null,
          messages: expect.any(Array),
        })
      )
    })

    it("does not expose a fork until its full snapshot is durably saved", async () => {
      let resolveSave: (() => void) | undefined
      vi.mocked(saveThreadDb).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve
          })
      )
      const store = useChatStore.getState()
      const sourceId = store.createThread("Source", "proj", "/repo")

      const forkPromise = store.forkThread(sourceId)

      expect(useChatStore.getState().threads).toHaveLength(1)
      expect(useChatStore.getState().activeThreadId).toBe(sourceId)
      resolveSave?.()
      const forkId = await forkPromise

      expect(forkId).toBeTruthy()
      expect(useChatStore.getState().activeThreadId).toBe(forkId)
      expect(useChatStore.getState().threads).toHaveLength(2)
    })

    it("does not create an in-memory fork when persistence fails", async () => {
      vi.mocked(saveThreadDb).mockRejectedValueOnce(new Error("disk full"))
      const store = useChatStore.getState()
      const sourceId = store.createThread("Source", "proj", "/repo")

      await expect(store.forkThread(sourceId)).resolves.toBeNull()
      expect(useChatStore.getState().threads).toHaveLength(1)
      expect(useChatStore.getState().activeThreadId).toBe(sourceId)
    })
  })

  // -----------------------------------------------------------------------
  // 2. setActiveThread
  // -----------------------------------------------------------------------
  describe("setActiveThread", () => {
    it("promotes thread in LRU and sets activeThreadId", () => {
      const store = useChatStore.getState()
      const id1 = store.createThread("A", "p")
      const id2 = store.createThread("B", "p")

      // id2 is at front after creation
      expect(useChatStore.getState().lruOrder[0]).toBe(id2)

      // Activate id1 — it moves to front
      useChatStore.getState().setActiveThread(id1)
      const state = useChatStore.getState()
      expect(state.activeThreadId).toBe(id1)
      expect(state.lruOrder[0]).toBe(id1)
    })

    it("triggers hydration for unloaded threads", async () => {
      vi.useRealTimers()

      // Simulate a thread that exists but is not loaded (e.g. from loadThreads)
      useChatStore.setState({
        threads: [
          {
            id: "unloaded-1",
            title: "Unloaded",
            projectName: "p",
            projectPath: "",
            messages: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        messagesLoadedByThread: { "unloaded-1": false },
      })

      const mockMessages: ChatMessage[] = [
        makeMessage({ id: "m1", content: "restored" }),
      ]
      vi.mocked(loadMessages).mockResolvedValueOnce(mockMessages)

      useChatStore.getState().setActiveThread("unloaded-1")

      // Allow microtask queue to drain (hydration is fire-and-forget)
      await new Promise((r) => setTimeout(r, 50))

      expect(loadMessages).toHaveBeenCalledWith("unloaded-1", {
        limit: 100,
        light: true,
      })

      vi.useFakeTimers()
    })

    it("setting activeThread to null clears it", () => {
      const id = useChatStore.getState().createThread("X", "p")
      expect(useChatStore.getState().activeThreadId).toBe(id)

      useChatStore.getState().setActiveThread(null)
      expect(useChatStore.getState().activeThreadId).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // 3. LRU eviction
  // -----------------------------------------------------------------------
  describe("LRU eviction", () => {
    it("evicts oldest thread when more than 10 threads are touched", () => {
      const store = useChatStore.getState()
      const ids: string[] = []

      // Create 11 threads — each creation touches LRU
      for (let i = 0; i < 11; i++) {
        ids.push(store.createThread(`Thread ${i}`, "p"))
        if (i === 0)
          useChatStore.setState((state) => ({
            threads: state.threads.map((thread) =>
              thread.id === ids[0]
                ? {
                    ...thread,
                    messages: [
                      {
                        id: "model-history",
                        role: "assistant",
                        content: "Done",
                        modelId: "gpt-6-astra",
                        createdAt: thread.createdAt,
                      },
                    ],
                  }
                : thread
            ),
          }))
      }

      const state = useChatStore.getState()

      // The first thread created (ids[0]) should be evicted
      expect(state.messagesLoadedByThread[ids[0]]).toBe(false)

      // Its messages should be cleared
      const evictedThread = state.threads.find((t) => t.id === ids[0])
      expect(evictedThread).toBeDefined()
      expect(evictedThread!.messages).toEqual([])
      expect(evictedThread!.lastModelId).toBe("gpt-6-astra")

      // Most recent thread should be loaded
      expect(state.messagesLoadedByThread[ids[10]]).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // 4. LRU pinning — streaming threads are NOT evicted
  // -----------------------------------------------------------------------
  describe("LRU pinning", () => {
    it("does not evict threads that are currently streaming", () => {
      const store = useChatStore.getState()
      const ids: string[] = []

      // Create 10 threads to fill LRU
      for (let i = 0; i < 10; i++) {
        ids.push(store.createThread(`Thread ${i}`, "p"))
      }

      // Mark the first thread (LRU tail = ids[0]) as streaming
      useChatStore.setState((s) => ({
        streamingByThread: {
          ...s.streamingByThread,
          [ids[0]]: { ...emptyStreamState, isStreaming: true },
        },
      }))

      // Create two more threads to push beyond LRU_CAPACITY.
      // The overflow will be ids[0] and ids[1].
      // ids[0] is streaming (pinned) so only ids[1] should be evicted.
      useChatStore.getState().createThread("Extra1", "p")
      useChatStore.getState().createThread("Extra2", "p")
      const state = useChatStore.getState()

      // The streaming thread should still be loaded (pinned)
      expect(state.messagesLoadedByThread[ids[0]]).toBe(true)

      // A non-streaming overflow thread should be evicted
      expect(state.messagesLoadedByThread[ids[1]]).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // 5. addMessage
  // -----------------------------------------------------------------------
  describe("addMessage", () => {
    it("appends message to a loaded thread", async () => {
      const id = useChatStore.getState().createThread("T", "p")
      const msg = makeMessage({ content: "hello world" })

      useChatStore.getState().addMessage(id, msg)
      vi.advanceTimersByTime(10)
      await Promise.resolve()

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.messages).toHaveLength(1)
      expect(thread!.messages[0].content).toBe("hello world")
      expect(_saveThreadMessageDb).toHaveBeenCalledWith(id, msg)
    })

    it("can apply a backend-persisted compaction message without overwriting metadata", () => {
      const id = useChatStore.getState().createThread("T", "p")
      const checkpoint = makeMessage({
        id: "checkpoint-backend-owned",
        role: "assistant",
        content: "# Compacted Session Context\n\nSummary",
        compactedContext: true,
        compactionGeneration: 4,
      })

      useChatStore.getState().addMessage(id, checkpoint, { persist: false })

      expect(
        useChatStore.getState().threads.find((thread) => thread.id === id)
          ?.messages
      ).toContainEqual(checkpoint)
      expect(_saveThreadMessageDb).not.toHaveBeenCalled()
    })

    it("defers via hydration when thread is not loaded", async () => {
      // Set up an unloaded thread
      useChatStore.setState({
        threads: [
          {
            id: "deferred",
            title: "D",
            projectName: "p",
            projectPath: "",
            messages: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        messagesLoadedByThread: { deferred: false },
      })

      vi.mocked(loadMessages).mockResolvedValueOnce([])

      const msg = makeMessage({ content: "deferred msg" })
      useChatStore.getState().addMessage("deferred", msg)

      // Should trigger hydration
      expect(loadMessages).toHaveBeenCalledWith("deferred", {
        limit: 100,
        light: true,
      })
    })

    it("uses first 40 chars of user message as temporary title", () => {
      const id = useChatStore.getState().createThread("Original", "p")
      const longContent =
        "This is a very long message that exceeds forty characters in total"
      const msg = makeMessage({ content: longContent, role: "user" })

      useChatStore.getState().addMessage(id, msg)
      vi.advanceTimersByTime(10)

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.title).toBe(longContent.slice(0, 40) + "...")
    })
  })

  // -----------------------------------------------------------------------
  // 6. deleteThread
  // -----------------------------------------------------------------------
  describe("deleteThread", () => {
    it("drops only the deleted chat's autonomous run after deletion succeeds", async () => {
      const owner = useChatStore.getState().createThread("Owner", "p")
      useChatStore.getState().setThreadAutonomy(owner, makeRun())
      const other = useChatStore.getState().createThread("Other", "p")
      useChatStore
        .getState()
        .setThreadAutonomy(other, makeRun({ id: "other-run" }))
      useChatStore.getState().deleteThread(other)
      await vi.waitFor(() =>
        expect(
          useChatStore.getState().threads.some((t) => t.id === other)
        ).toBe(false)
      )
      expect(useChatStore.getState().autonomyByThread).toEqual({
        [owner]: makeRun(),
      })
      useChatStore.getState().deleteThread(owner)
      await vi.waitFor(() =>
        expect(
          useChatStore.getState().threads.some((t) => t.id === owner)
        ).toBe(false)
      )
      expect(useChatStore.getState().autonomyByThread).toEqual({})
    })

    it("keeps the autonomous run when deleting its chat is denied", async () => {
      const owner = useChatStore.getState().createThread("Owner", "p")
      useChatStore.getState().setThreadAutonomy(owner, makeRun())
      vi.mocked(deleteThreadDb).mockRejectedValueOnce(new Error("denied"))
      useChatStore.getState().deleteThread(owner)
      await Promise.resolve()
      await Promise.resolve()
      expect(useChatStore.getState().autonomyByThread[owner]?.status).toBe(
        "working"
      )
    })
    it("removes thread from all maps after the database delete commits", async () => {
      const id = useChatStore.getState().createThread("T", "p")
      useChatStore.getState().setDraft(id, "my draft")

      // Simulate streaming state
      useChatStore.setState((s) => ({
        streamingByThread: {
          ...s.streamingByThread,
          [id]: { ...emptyStreamState, isStreaming: true },
        },
      }))

      useChatStore.getState().deleteThread(id)
      await vi.waitFor(() => {
        expect(
          useChatStore.getState().threads.find((t) => t.id === id)
        ).toBeUndefined()
      })

      const state = useChatStore.getState()
      expect(state.threads.find((t) => t.id === id)).toBeUndefined()
      expect(state.lruOrder).not.toContain(id)
      expect(clearCheckpointsForThread).toHaveBeenCalledWith(id)
      expect(state.draftsByThread[id]).toBeUndefined()
      expect(state.streamingByThread[id]).toBeUndefined()
      expect(state.messagesLoadedByThread[id]).toBeUndefined()
      expect(deleteThreadDb).toHaveBeenCalledWith(id)
    })

    it("clears activeThreadId when deleting the active thread", async () => {
      const id = useChatStore.getState().createThread("T", "p")
      expect(useChatStore.getState().activeThreadId).toBe(id)

      useChatStore.getState().deleteThread(id)
      await vi.waitFor(() => {
        expect(useChatStore.getState().activeThreadId).toBeNull()
      })
    })

    it("preserves activeThreadId when deleting a non-active thread", async () => {
      const id1 = useChatStore.getState().createThread("A", "p")
      const id2 = useChatStore.getState().createThread("B", "p")
      // id2 is active after creation
      expect(useChatStore.getState().activeThreadId).toBe(id2)

      useChatStore.getState().deleteThread(id1)
      await vi.waitFor(() => {
        expect(
          useChatStore.getState().threads.find((t) => t.id === id1)
        ).toBeUndefined()
      })
      expect(useChatStore.getState().activeThreadId).toBe(id2)
    })

    it("keeps the thread visible when the database delete fails", async () => {
      vi.mocked(deleteThreadDb).mockRejectedValueOnce(
        new Error("database busy")
      )
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().deleteThread(id)
      await Promise.resolve()
      await Promise.resolve()

      expect(
        useChatStore.getState().threads.find((thread) => thread.id === id)
      ).toBeDefined()
      expect(useChatStore.getState().activeThreadId).toBe(id)
    })
  })

  // -----------------------------------------------------------------------
  // 7. setDraft / getDraft
  // -----------------------------------------------------------------------
  describe("setDraft / getDraft", () => {
    it("stores and retrieves per-thread draft", () => {
      const id = useChatStore.getState().createThread("T", "p")
      useChatStore.getState().setDraft(id, "my draft text")

      expect(useChatStore.getState().getDraft(id)).toBe("my draft text")
    })

    it("removes key when setting empty string", () => {
      const id = useChatStore.getState().createThread("T", "p")
      useChatStore.getState().setDraft(id, "something")
      expect(useChatStore.getState().draftsByThread[id]).toBe("something")

      useChatStore.getState().setDraft(id, "")
      expect(id in useChatStore.getState().draftsByThread).toBe(false)
    })

    it("returns empty string for thread with no draft", () => {
      const id = useChatStore.getState().createThread("T", "p")
      expect(useChatStore.getState().getDraft(id)).toBe("")
    })

    it("returns empty string for nonexistent thread", () => {
      expect(useChatStore.getState().getDraft("nonexistent")).toBe("")
    })
  })

  describe("setThreadSetting / getThreadSettings", () => {
    it("skips no-op writes so selector subscribers do not re-render", () => {
      const id = useChatStore.getState().createThread("T", "p")
      useChatStore.getState().setThreadSetting(id, "chatMode", "plan")
      const before = useChatStore.getState().settingsByThread
      const listener = vi.fn()
      const unsubscribe = useChatStore.subscribe(listener)

      useChatStore.getState().setThreadSetting(id, "chatMode", "plan")

      expect(useChatStore.getState().settingsByThread).toBe(before)
      expect(listener).not.toHaveBeenCalled()
      unsubscribe()
    })
  })

  describe("thread activities", () => {
    it("caps proposed plan activities while preserving other activity history", () => {
      const id = useChatStore.getState().createThread("T", "p")
      const activities = Array.from({ length: 205 }, (_, index) =>
        makeActivity({
          id: `plan-${index}`,
          threadId: id,
          kind: "turn.proposed.completed",
          summary: `Plan ${index}`,
          sequence: index,
          createdAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
        })
      )
      activities.splice(
        25,
        0,
        makeActivity({
          id: "tool-old",
          threadId: id,
          kind: "tool.completed",
          sequence: 25.5,
        })
      )

      useChatStore.getState().setThreadActivities(id, activities)

      const stored = useChatStore.getState().activitiesByThread[id]
      const proposedPlans = stored.filter(
        (activity) => activity.kind === "turn.proposed.completed"
      )
      expect(proposedPlans).toHaveLength(200)
      expect(proposedPlans[0].id).toBe("plan-5")
      expect(proposedPlans.at(-1)?.id).toBe("plan-204")
      expect(stored.some((activity) => activity.id === "tool-old")).toBe(true)
    })

    it("applies the proposed plan cap to live upserts", () => {
      const id = useChatStore.getState().createThread("T", "p")

      for (let index = 0; index < 201; index += 1) {
        useChatStore.getState().upsertThreadActivity(
          id,
          makeActivity({
            id: `plan-${index}`,
            threadId: id,
            kind: "turn.proposed.completed",
            sequence: index,
          })
        )
      }

      const stored = useChatStore.getState().activitiesByThread[id]
      expect(
        stored.filter((activity) => activity.kind === "turn.proposed.completed")
      ).toHaveLength(200)
      expect(stored.some((activity) => activity.id === "plan-0")).toBe(false)
      expect(stored.some((activity) => activity.id === "plan-200")).toBe(true)
    })

    it("bounds non-plan activities on live upserts, retaining the newest", () => {
      const id = useChatStore.getState().createThread("T", "p")

      // A long tool-heavy turn emits far more than the retention cap; the store
      // must keep a bounded tail rather than growing without limit.
      for (let index = 0; index < 1_050; index += 1) {
        useChatStore.getState().upsertThreadActivity(
          id,
          makeActivity({
            id: `tool-${index}`,
            threadId: id,
            kind: "tool.completed",
            sequence: index,
          })
        )
      }

      const stored = useChatStore.getState().activitiesByThread[id]
      expect(stored.length).toBeLessThanOrEqual(1_000)
      // Oldest evicted, newest retained, order preserved.
      expect(stored.some((activity) => activity.id === "tool-0")).toBe(false)
      expect(stored.at(-1)?.id).toBe("tool-1049")
    })
  })

  // -----------------------------------------------------------------------
  // 8. appendStreamDelta
  // -----------------------------------------------------------------------
  describe("appendStreamDelta", () => {
    it("accumulates text in streaming state", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().appendStreamDelta(id, "Hello")
      useChatStore.getState().appendStreamDelta(id, " world")

      const stream = useChatStore.getState().streamingByThread[id]
      expect(stream).toBeDefined()
      expect(stream.streamingText).toBe("Hello world")
      expect(stream.isStreaming).toBe(true)
      expect(stream.isReasoning).toBe(false)
    })

    it("creates streaming state for unknown thread", () => {
      useChatStore.getState().appendStreamDelta("unknown-id", "data")
      const stream = useChatStore.getState().streamingByThread["unknown-id"]
      expect(stream).toBeDefined()
      expect(stream.streamingText).toBe("data")
    })

    it("handles empty delta", () => {
      const id = useChatStore.getState().createThread("T", "p")
      useChatStore.getState().appendStreamDelta(id, "")

      const stream = useChatStore.getState().streamingByThread[id]
      expect(stream.isStreaming).toBe(true)
      expect(stream.streamingText).toBe("")
    })
  })

  // -----------------------------------------------------------------------
  // 9. finalizeStream
  // -----------------------------------------------------------------------
  describe("finalizeStream", () => {
    it.each([null, "C:/worktrees/test"])(
      "binds file checkpoints to their own chat's runtime path (%s)",
      (worktreePath) => {
        const id = useChatStore
          .getState()
          .createThread("Source", "kittycord", "C:/projects/kittycord", {
            worktreePath,
          })
        const other = useChatStore
          .getState()
          .createThread("Other", "other", "C:/projects/other")
        useChatStore.getState().setActiveThread(other)
        const tool = {
          id: "edit-1",
          name: "Edit",
          state: "output-available" as const,
          input: { file_path: "src/app.ts" },
        }
        useChatStore.getState().addToolCall(id, tool)
        useChatStore.getState().finalizeStream(id)
        expect(autoCheckpointFromToolCalls).toHaveBeenCalledWith(
          id,
          expect.any(String),
          expect.arrayContaining([expect.objectContaining({ id: "edit-1" })]),
          worktreePath ?? "C:/projects/kittycord"
        )
      }
    )

    it("creates assistant message from accumulated stream text", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().appendStreamDelta(id, "response text")
      useChatStore.getState().finalizeStream(id)
      vi.advanceTimersByTime(10)

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.messages).toHaveLength(1)
      expect(thread!.messages[0].role).toBe("assistant")
      expect(thread!.messages[0].content).toBe("response text")
    })

    it("can finalize a backend-owned transcript without writing a duplicate", async () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().appendStreamDelta(id, "server-owned response")
      useChatStore.getState().finalizeStream(id, {
        messageId: "provider-assistant:thread-1:turn-1",
        persist: false,
      })
      await Promise.resolve()

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.messages[0].id).toBe("provider-assistant:thread-1:turn-1")
      expect(_saveThreadMessageDb).not.toHaveBeenCalled()
    })

    it("reconciles a backend-owned transcript by message id after replay hydration", () => {
      const id = useChatStore.getState().createThread("T", "p")
      const messageId = "provider-assistant:thread-1:turn-1"
      useChatStore
        .getState()
        .addMessage(
          id,
          makeMessage({ id: messageId, role: "assistant", content: "partial" })
        )

      useChatStore.getState().appendStreamDelta(id, "complete response")
      useChatStore.getState().finalizeStream(id, {
        messageId,
        persist: false,
      })

      const thread = useChatStore
        .getState()
        .threads.find((item) => item.id === id)
      expect(thread?.messages).toHaveLength(1)
      expect(thread?.messages[0]).toMatchObject({
        id: messageId,
        content: "complete response",
      })
    })

    it("includes reasoning text when present", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().appendReasoningDelta(id, "thinking...")
      useChatStore.getState().appendStreamDelta(id, "answer")
      useChatStore.getState().finalizeStream(id)
      vi.advanceTimersByTime(10)

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      const msg = thread!.messages[0]
      expect(msg.reasoning).toBe("thinking...")
      expect(msg.content).toBe("answer")
    })

    it("includes tool calls when present", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().appendStreamDelta(id, "done")
      useChatStore.getState().addToolCall(id, {
        id: "tc-1",
        name: "read",
        input: { path: "/foo" },
        state: "input-available",
      })
      useChatStore.getState().finalizeStream(id)
      vi.advanceTimersByTime(10)

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.messages[0].toolCalls).toHaveLength(1)
      expect(thread!.messages[0].toolCalls![0].name).toBe("read")
    })

    it("clears streaming state for the thread", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().appendStreamDelta(id, "text")
      useChatStore.getState().finalizeStream(id)

      expect(useChatStore.getState().streamingByThread[id]).toBeUndefined()
    })

    it("does not create message when stream had no content", () => {
      const id = useChatStore.getState().createThread("T", "p")

      // No appendStreamDelta — finalize with empty state
      useChatStore.getState().finalizeStream(id)
      vi.advanceTimersByTime(10)

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.messages).toHaveLength(0)
    })

    it("creates message with reasoning-only content when no text", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().appendReasoningDelta(id, "deep thought")
      useChatStore.getState().finalizeStream(id)
      vi.advanceTimersByTime(10)

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.messages).toHaveLength(1)
      expect(thread!.messages[0].content).toBe("(reasoning only)")
      expect(thread!.messages[0].reasoning).toBe("deep thought")
    })

    // A reasoning block delivered in one piece spans only its own delivery,
    // which showed "Thought for 69ms" after a minute of work. The duration is
    // measured from the previous boundary instead: the turn start, or the
    // last tool that finished.
    it("times a reasoning block delivered in one piece from the turn start", () => {
      const id = useChatStore.getState().createThread("T", "p")
      vi.setSystemTime(new Date("2026-09-17T00:00:00.000Z"))
      useChatStore.getState().setActiveTurnId(id, "turn-1")
      vi.setSystemTime(new Date("2026-09-17T00:00:04.000Z"))
      useChatStore
        .getState()
        .appendReasoningDelta(id, "all of the thinking at once")
      useChatStore.getState().finalizeStream(id)
      vi.advanceTimersByTime(10)

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.messages[0].reasoningDurationMs).toBe(4000)
    })

    it("does not count a tool's run time as thinking", () => {
      const id = useChatStore.getState().createThread("T", "p")
      vi.setSystemTime(new Date("2026-09-17T00:00:00.000Z"))
      useChatStore.getState().setActiveTurnId(id, "turn-1")
      vi.setSystemTime(new Date("2026-09-17T00:00:01.000Z"))
      useChatStore.getState().appendReasoningDelta(id, "first")
      useChatStore.getState().addToolCall(id, {
        id: "tc-1",
        name: "read",
        input: {},
        state: "input-available",
      })
      vi.setSystemTime(new Date("2026-09-17T00:00:09.000Z"))
      useChatStore.getState().updateToolResult(id, "tc-1", "ok")
      vi.setSystemTime(new Date("2026-09-17T00:00:11.000Z"))
      useChatStore.getState().appendReasoningDelta(id, "second")
      useChatStore.getState().finalizeStream(id)
      vi.advanceTimersByTime(10)

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      // 1s before the tool plus 2s after it; the 8s tool run is not thinking.
      expect(thread!.messages[0].reasoningDurationMs).toBe(3000)
    })
  })

  // -----------------------------------------------------------------------
  // 10. dismissPendingQuestions
  // -----------------------------------------------------------------------
  describe("dismissPendingQuestions", () => {
    it("clears pending questions from streaming state", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().addQuestion(id, {
        id: "q1",
        text: "Pick one?",
        options: [{ label: "A" }, { label: "B" }],
      })

      const beforeDismiss =
        useChatStore.getState().streamingByThread[id].pendingQuestions
      expect(beforeDismiss).toHaveLength(1)

      useChatStore.getState().dismissPendingQuestions(id)

      const afterDismiss =
        useChatStore.getState().streamingByThread[id]?.pendingQuestions ?? []
      expect(afterDismiss).toHaveLength(0)
    })

    it("strips questions from last assistant message", () => {
      const id = useChatStore.getState().createThread("T", "p")
      // Add an assistant message with questions
      useChatStore.setState((s) => ({
        threads: s.threads.map((t) =>
          t.id === id
            ? {
                ...t,
                messages: [
                  {
                    id: "m1",
                    role: "assistant" as const,
                    content: "Choose one",
                    questions: [
                      {
                        id: "q1",
                        text: "Pick?",
                        options: [{ label: "A" }],
                      },
                    ],
                    createdAt: new Date().toISOString(),
                  },
                ],
              }
            : t
        ),
      }))

      useChatStore.getState().dismissPendingQuestions(id)

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.messages[0].questions).toBeUndefined()
    })

    it("handles thread with no streaming state gracefully", () => {
      const id = useChatStore.getState().createThread("T", "p")
      // No streaming state for this thread
      expect(() =>
        useChatStore.getState().dismissPendingQuestions(id)
      ).not.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Additional edge cases
  // -----------------------------------------------------------------------
  describe("clearStreaming", () => {
    it("clears streaming for a specific thread", () => {
      const id = useChatStore.getState().createThread("T", "p")
      useChatStore.getState().appendStreamDelta(id, "data")

      useChatStore.getState().clearStreaming(id)
      expect(useChatStore.getState().streamingByThread[id]).toBeUndefined()
    })

    it("clears all streaming when called with no argument", () => {
      const id1 = useChatStore.getState().createThread("A", "p")
      const id2 = useChatStore.getState().createThread("B", "p")
      useChatStore.getState().appendStreamDelta(id1, "x")
      useChatStore.getState().appendStreamDelta(id2, "y")

      useChatStore.getState().clearStreaming()
      expect(useChatStore.getState().streamingByThread).toEqual({})
    })
  })

  describe("updateThreadUsage", () => {
    it("updates usage on a thread", () => {
      const id = useChatStore.getState().createThread("T", "p")
      useChatStore.getState().updateThreadUsage(id, {
        inputTokens: 100,
        outputTokens: 200,
        usedTokens: 300,
      })

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.usage).toEqual({
        inputTokens: 100,
        outputTokens: 200,
        usedTokens: 300,
      })
    })
  })

  describe("updateThreadTitle", () => {
    it("updates the title of a thread", () => {
      const id = useChatStore.getState().createThread("Old Title", "p")
      useChatStore.getState().updateThreadTitle(id, "New Title")

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.title).toBe("New Title")
    })

    it("does not let async generated titles overwrite explicit titles", async () => {
      const store = useChatStore.getState()
      const id = store.createThread("Implement Custom Plan", "p")
      const message = makeMessage({
        content: "Implement the proposed plan.",
      })

      store.addMessage(id, message)
      store.updateThreadTitle(id, "Implement Custom Plan")

      await Promise.resolve()
      await Promise.resolve()

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread!.title).toBe("Implement Custom Plan")
    })
  })

  describe("updateThreadContext", () => {
    it("updates branch/worktree metadata and persists the thread", () => {
      const id = useChatStore.getState().createThread("T", "p", "/repo", {
        branch: "main",
      })
      vi.clearAllMocks()

      useChatStore.getState().updateThreadContext(id, {
        branch: "feature/git-panel-sync",
        worktreePath: "/repo-worktree",
        worktreeState: "ready",
      })

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread).toMatchObject({
        branch: "feature/git-panel-sync",
        worktreePath: "/repo-worktree",
        worktreeState: "ready",
      })

      vi.advanceTimersByTime(600)
      expect(upsertThreadMetaDb).toHaveBeenCalledWith(
        expect.objectContaining({
          id,
          branch: "feature/git-panel-sync",
          worktreePath: "/repo-worktree",
          worktreeState: "ready",
        })
      )
    })

    it("ignores omitted and undefined context fields", () => {
      const id = useChatStore.getState().createThread("T", "p", "/repo", {
        branch: "main",
        worktreePath: "/repo-worktree",
      })
      vi.clearAllMocks()

      useChatStore.getState().updateThreadContext(id, {
        branch: undefined,
      })

      const thread = useChatStore.getState().threads.find((t) => t.id === id)
      expect(thread).toMatchObject({
        branch: "main",
        worktreePath: "/repo-worktree",
      })

      vi.advanceTimersByTime(600)
      expect(upsertThreadMetaDb).not.toHaveBeenCalled()
    })
  })

  describe("appendReasoningDelta", () => {
    it("accumulates reasoning text separately from content", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().appendReasoningDelta(id, "step1 ")
      useChatStore.getState().appendReasoningDelta(id, "step2")

      const stream = useChatStore.getState().streamingByThread[id]
      expect(stream.reasoningText).toBe("step1 step2")
      expect(stream.isReasoning).toBe(true)
      expect(stream.isStreaming).toBe(true)
    })
  })

  describe("addToolCall", () => {
    it("adds a tool call to streaming state", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().addToolCall(id, {
        id: "tc-1",
        name: "grep",
        input: { pattern: "foo" },
        state: "input-available",
      })

      const stream = useChatStore.getState().streamingByThread[id]
      expect(stream.streamingTools).toHaveLength(1)
      expect(stream.streamingTools[0].name).toBe("grep")
    })

    it("updates existing tool call by id", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().addToolCall(id, {
        id: "tc-1",
        name: "read",
        input: { path: "/a" },
        state: "input-available",
      })
      useChatStore.getState().addToolCall(id, {
        id: "tc-1",
        name: "read",
        input: { path: "/b" },
        state: "input-available",
      })

      const stream = useChatStore.getState().streamingByThread[id]
      expect(stream.streamingTools).toHaveLength(1)
      expect((stream.streamingTools[0].input as { path?: string }).path).toBe(
        "/b"
      )
    })
  })

  describe("appendToolOutputDelta", () => {
    it("appends chunks by default", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore
        .getState()
        .appendToolOutputDelta(id, "tc-1", "line 1\n", "shell", "codex")
      useChatStore.getState().appendToolOutputDelta(id, "tc-1", "line 2\n")

      const stream = useChatStore.getState().streamingByThread[id]
      expect(stream.streamingTools).toHaveLength(1)
      expect(stream.streamingTools[0]).toMatchObject({
        id: "tc-1",
        name: "shell",
        providerKind: "codex",
        output: "line 1\nline 2\n",
      })
    })

    it("replaces the output for a cumulative snapshot instead of compounding it", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore
        .getState()
        .appendToolOutputDelta(
          id,
          "tc-1",
          "npm test",
          "shell",
          "cursor",
          undefined,
          "replace"
        )
      useChatStore
        .getState()
        .appendToolOutputDelta(
          id,
          "tc-1",
          "npm test\nok",
          "shell",
          "cursor",
          undefined,
          "replace"
        )

      const stream = useChatStore.getState().streamingByThread[id]
      expect(stream.streamingTools).toHaveLength(1)
      expect(stream.streamingTools[0].output).toBe("npm test\nok")
      expect(stream.streamingTools[0].output).not.toContain("npm testnpm test")
    })
  })

  describe("updateToolResult", () => {
    it("sets output and state on a tool call", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().addToolCall(id, {
        id: "tc-1",
        name: "read",
        input: {},
        state: "input-available",
      })
      useChatStore.getState().updateToolResult(id, "tc-1", "file contents")

      const stream = useChatStore.getState().streamingByThread[id]
      expect(stream.streamingTools[0].output).toBe("file contents")
      expect(stream.streamingTools[0].state).toBe("output-available")
    })
  })

  describe("answerQuestion", () => {
    it("sets answer on the matching question", () => {
      const id = useChatStore.getState().createThread("T", "p")

      useChatStore.getState().addQuestion(id, {
        id: "q1",
        text: "Which?",
        options: [{ label: "A" }, { label: "B" }],
      })
      useChatStore.getState().answerQuestion(id, "q1", "B")

      const stream = useChatStore.getState().streamingByThread[id]
      expect(stream.pendingQuestions[0].answer).toBe("B")
      expect(stream.pendingQuestions[0].answeredAt).toBeDefined()
    })
  })

  describe("hydrateThreadMessages", () => {
    it("is idempotent for already-loaded threads", async () => {
      const id = useChatStore.getState().createThread("T", "p")
      // Already loaded from createThread
      await useChatStore.getState().hydrateThreadMessages(id)
      expect(loadMessages).not.toHaveBeenCalled()
    })

    it("force reloads already-loaded threads after a replay gap", async () => {
      const id = useChatStore.getState().createThread("T", "p")
      const persisted = makeMessage({
        id: "provider-assistant:thread-1:turn-1",
        role: "assistant",
        content: "persisted transcript",
      })
      vi.mocked(loadMessages).mockResolvedValueOnce([persisted])

      await useChatStore.getState().hydrateThreadMessages(id, true)

      expect(loadMessages).toHaveBeenCalledWith(id, { limit: 100, light: true })
      expect(
        useChatStore.getState().threads.find((thread) => thread.id === id)
          ?.messages
      ).toEqual([persisted])
    })

    it("retries a transient message hydration failure without requiring reload", async () => {
      const id = useChatStore.getState().createThread("T", "p")
      useChatStore.setState((state) => ({
        messagesLoadedByThread: {
          ...state.messagesLoadedByThread,
          [id]: false,
        },
      }))
      const recovered = makeMessage({
        id: "recovered-message",
        role: "assistant",
        content: "history is back",
      })
      vi.mocked(loadMessages)
        .mockRejectedValueOnce(new Error("backend still recovering"))
        .mockResolvedValueOnce([recovered])

      await useChatStore.getState().hydrateThreadMessages(id)
      expect(useChatStore.getState().messagesLoadedByThread[id]).toBe(true)
      expect(
        useChatStore.getState().messageHydrationErrorsByThread[id]
      ).toContain("backend still recovering")

      await useChatStore.getState().hydrateThreadMessages(id)
      expect(loadMessages).toHaveBeenCalledTimes(2)
      expect(
        useChatStore.getState().messageHydrationErrorsByThread[id]
      ).toBeUndefined()
      expect(
        useChatStore.getState().threads.find((thread) => thread.id === id)
          ?.messages
      ).toEqual([recovered])
    })

    it("queues a forced reload behind stale in-flight message hydration", async () => {
      const id = useChatStore.getState().createThread("T", "p")
      useChatStore.setState((state) => ({
        messagesLoadedByThread: {
          ...state.messagesLoadedByThread,
          [id]: false,
        },
      }))
      let resolveStale!: (messages: ChatMessage[]) => void
      vi.mocked(loadMessages)
        .mockImplementationOnce(
          () =>
            new Promise<ChatMessage[]>((resolve) => {
              resolveStale = resolve
            })
        )
        .mockResolvedValueOnce([
          makeMessage({ id: "fresh", role: "assistant", content: "fresh" }),
        ])

      const initial = useChatStore.getState().hydrateThreadMessages(id)
      const forced = useChatStore.getState().hydrateThreadMessages(id, true)
      resolveStale([makeMessage({ id: "stale", content: "stale" })])
      await Promise.all([initial, forced])

      expect(loadMessages).toHaveBeenCalledTimes(2)
      expect(
        useChatStore.getState().threads.find((thread) => thread.id === id)
          ?.messages
      ).toEqual([expect.objectContaining({ id: "fresh" })])
    })

    it("queues a forced reload behind stale in-flight activity hydration", async () => {
      const id = useChatStore.getState().createThread("T", "p")
      useChatStore.setState((state) => ({
        activitiesLoadedByThread: {
          ...state.activitiesLoadedByThread,
          [id]: false,
        },
      }))
      let resolveStale!: (activities: ThreadActivity[]) => void
      vi.mocked(loadThreadActivities)
        .mockImplementationOnce(
          () =>
            new Promise<ThreadActivity[]>((resolve) => {
              resolveStale = resolve
            })
        )
        .mockResolvedValueOnce([
          makeActivity({ id: "fresh-activity", sequence: 2 }),
        ])

      const initial = useChatStore.getState().hydrateThreadActivities(id)
      const forced = useChatStore.getState().hydrateThreadActivities(id, true)
      resolveStale([makeActivity({ id: "stale-activity", sequence: 1 })])
      await Promise.all([initial, forced])

      expect(loadThreadActivities).toHaveBeenCalledTimes(2)
      expect(useChatStore.getState().activitiesByThread[id]).toEqual([
        expect.objectContaining({ id: "fresh-activity" }),
      ])
    })
  })

  describe("transcript paging", () => {
    function withSequence(message: ChatMessage, sequence: number): ChatMessage {
      return { ...message, sequence } as ChatMessage
    }

    function rows(from: number, count: number): ChatMessage[] {
      return Array.from({ length: count }, (_, index) =>
        withSequence(
          makeMessage({
            id: `m${from + index}`,
            content: `row ${from + index}`,
          }),
          from + index
        )
      )
    }

    async function flushMicrotasks() {
      for (let index = 0; index < 10; index += 1) await Promise.resolve()
    }

    function unloadedThread(id: string) {
      useChatStore.setState({
        threads: [
          {
            id,
            title: id,
            projectName: "p",
            projectPath: "",
            messages: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        messagesLoadedByThread: { [id]: false },
      })
    }

    function messageIds(id: string) {
      return (
        useChatStore
          .getState()
          .threads.find((thread) => thread.id === id)
          ?.messages.map((message) => message.id) ?? []
      )
    }

    it("reads the newest page first and prepends older pages on demand", async () => {
      unloadedThread("paged")
      vi.mocked(loadMessages)
        .mockResolvedValueOnce(rows(100, 100))
        .mockResolvedValueOnce(rows(60, 40))

      await useChatStore.getState().hydrateThreadMessages("paged")
      expect(loadMessages).toHaveBeenCalledWith("paged", {
        limit: 100,
        light: true,
      })
      expect(useChatStore.getState().olderMessagesCursorByThread.paged).toBe(
        100
      )
      expect(messageIds("paged")).toHaveLength(100)

      await useChatStore.getState().loadOlderThreadMessages("paged")
      expect(loadMessages).toHaveBeenLastCalledWith("paged", {
        limit: 100,
        beforeSequence: 100,
        light: true,
      })
      const ids = messageIds("paged")
      expect(ids).toHaveLength(140)
      expect(ids[0]).toBe("m60")
      expect(ids.at(-1)).toBe("m199")
      // A short page means the start of the chat is loaded.
      expect(
        useChatStore.getState().olderMessagesCursorByThread.paged
      ).toBeUndefined()
      expect(
        useChatStore.getState().olderMessagesLoadingByThread.paged
      ).toBeUndefined()
    })

    it("loads every page for commands that need the whole conversation", async () => {
      unloadedThread("full")
      vi.mocked(loadMessages)
        .mockResolvedValueOnce(rows(300, 100))
        .mockResolvedValueOnce(rows(250, 50))

      await useChatStore.getState().ensureFullThreadMessages("full")

      expect(loadMessages).toHaveBeenLastCalledWith("full", {
        limit: 2_000,
        beforeSequence: 300,
        light: false,
      })
      expect(messageIds("full")).toHaveLength(150)
      expect(
        useChatStore.getState().olderMessagesCursorByThread.full
      ).toBeUndefined()
    })

    it("keeps a message sent while a forced refresh was reading", async () => {
      const id = useChatStore.getState().createThread("T", "p")
      let resolveSnapshot!: (messages: ChatMessage[]) => void
      vi.mocked(loadMessages).mockImplementationOnce(
        () =>
          new Promise<ChatMessage[]>((resolve) => {
            resolveSnapshot = resolve
          })
      )
      const refresh = useChatStore.getState().hydrateThreadMessages(id, true)
      const sent = makeMessage({ id: "sent-during-read", content: "hi" })
      useChatStore.getState().addMessage(id, sent)
      await flushMicrotasks()

      resolveSnapshot([makeMessage({ id: "server-row", role: "assistant" })])
      await refresh

      expect(messageIds(id)).toEqual(["server-row", "sent-during-read"])
    })

    it("drops a saved message that the server no longer has", async () => {
      const id = useChatStore.getState().createThread("T", "p")
      useChatStore.getState().addMessage(id, makeMessage({ id: "reverted" }))
      await flushMicrotasks()
      vi.mocked(loadMessages).mockResolvedValueOnce([])

      await useChatStore.getState().hydrateThreadMessages(id, true)

      expect(messageIds(id)).toEqual([])
    })
  })

  describe("light transcript payloads", () => {
    const FULL_DIFF = {
      path: "src/a.ts",
      additions: 1,
      deletions: 1,
      oldText: "before",
      newText: "after",
      isNew: false,
    }
    const IMAGE_URL = `data:image/png;base64,${"A".repeat(64)}`

    function fullMessage(id: string): ChatMessage {
      return {
        ...makeMessage({ id, role: "assistant", content: `full ${id}` }),
        sequence: 1,
        diffs: [FULL_DIFF],
        attachments: [{ type: "image", filename: "a.png", url: IMAGE_URL }],
      } as ChatMessage
    }

    function lightMessage(id: string): ChatMessage {
      const full = fullMessage(id)
      return {
        ...full,
        diffs: [{ ...FULL_DIFF, oldText: "", newText: "", textOmitted: true }],
        attachments: [
          {
            type: "image",
            filename: "a.png",
            url: "data:image/png;base64,",
            dataOmitted: true,
          },
        ],
      }
    }

    function loadedThread(id: string, messages: ChatMessage[], loaded = true) {
      useChatStore.setState({
        threads: [
          {
            id,
            title: id,
            projectName: "p",
            projectPath: "",
            messages,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        messagesLoadedByThread: { [id]: loaded },
      })
    }

    function storedMessage(threadId: string, messageId: string) {
      return useChatStore
        .getState()
        .threads.find((thread) => thread.id === threadId)
        ?.messages.find((message) => message.id === messageId)
    }

    it("reads a message in full once and keeps newer local changes", async () => {
      loadedThread("lazy", [lightMessage("m1")])
      let resolveFull!: (message: ChatMessage) => void
      vi.mocked(loadMessage).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFull = resolve as (message: ChatMessage) => void
          }) as ReturnType<typeof loadMessage>
      )

      const first = useChatStore.getState().hydrateFullMessage("lazy", "m1")
      const second = useChatStore.getState().hydrateFullMessage("lazy", "m1")
      expect(loadMessage).toHaveBeenCalledTimes(1)
      expect(loadMessage).toHaveBeenCalledWith("lazy", "m1")

      // The message changes while the full copy is in flight.
      useChatStore.setState((state) => ({
        threads: state.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.map((message) => ({
            ...message,
            content: "streamed later",
          })),
        })),
      }))
      resolveFull(fullMessage("m1"))
      await Promise.all([first, second])

      const message = storedMessage("lazy", "m1")
      expect(message?.content).toBe("streamed later")
      expect(message?.diffs).toEqual([FULL_DIFF])
      expect(message?.attachments).toEqual([
        { type: "image", filename: "a.png", url: IMAGE_URL },
      ])

      // Nothing left to read.
      await useChatStore.getState().hydrateFullMessage("lazy", "m1")
      expect(loadMessage).toHaveBeenCalledTimes(1)
    })

    it("keeps payloads read in full when a light page is read again", async () => {
      loadedThread("refresh", [fullMessage("m1")])
      vi.mocked(loadMessages).mockResolvedValueOnce([lightMessage("m1")])

      await useChatStore.getState().hydrateThreadMessages("refresh", true)

      expect(storedMessage("refresh", "m1")?.diffs).toEqual([FULL_DIFF])
      expect(loadMessage).not.toHaveBeenCalled()
    })

    it("leaves a thread evicted while the read ran alone", async () => {
      loadedThread("evicted", [lightMessage("m1")])
      vi.mocked(loadMessage).mockImplementation(async () => {
        useChatStore.setState({ messagesLoadedByThread: { evicted: false } })
        return fullMessage("m1")
      })

      await useChatStore.getState().hydrateFullMessage("evicted", "m1")

      expect(storedMessage("evicted", "m1")?.diffs?.[0]?.textOmitted).toBe(true)
    })

    it("fills every placeholder for whole-conversation commands only", async () => {
      loadedThread("all", [], false)
      vi.mocked(loadMessages).mockResolvedValueOnce([
        lightMessage("m1"),
        { ...makeMessage({ id: "m2" }), sequence: 2 } as ChatMessage,
      ])
      vi.mocked(loadMessage).mockImplementation(async (_threadId, messageId) =>
        fullMessage(messageId)
      )

      await useChatStore
        .getState()
        .ensureFullThreadMessages("all", { payloads: false })
      expect(loadMessage).not.toHaveBeenCalled()

      await useChatStore.getState().ensureFullThreadMessages("all")
      expect(loadMessage).toHaveBeenCalledTimes(1)
      expect(storedMessage("all", "m1")?.diffs).toEqual([FULL_DIFF])
    })

    it("saves the full payloads instead of light placeholders", async () => {
      const light = {
        ...lightMessage("m1"),
        questions: [{ id: "q1", text: "Which?", options: [] }],
      } as ChatMessage
      loadedThread("persist", [light])
      vi.mocked(loadMessage).mockResolvedValue(fullMessage("m1"))

      useChatStore.getState().dismissPendingQuestions("persist")
      for (let index = 0; index < 20; index += 1) await Promise.resolve()

      expect(loadMessage).toHaveBeenCalledWith("persist", "m1")
      expect(_saveThreadMessageDb).toHaveBeenCalledTimes(1)
      const saved = vi.mocked(_saveThreadMessageDb).mock
        .calls[0]?.[1] as ChatMessage
      expect(saved.diffs).toEqual([FULL_DIFF])
      expect(saved.attachments).toEqual([
        { type: "image", filename: "a.png", url: IMAGE_URL },
      ])
      expect(saved.questions).toBeUndefined()
    })
  })

  describe("LRU residency", () => {
    it("evicts prefetched threads and their activities, keeping the active one", () => {
      const threads = Array.from({ length: 12 }, (_, index) => ({
        id: `r${index}`,
        title: `r${index}`,
        projectName: "p",
        projectPath: "",
        messages: [makeMessage({ id: `r${index}-m` })],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }))
      useChatStore.setState({
        threads,
        lruOrder: [],
        messagesLoadedByThread: Object.fromEntries(
          threads.map((thread) => [thread.id, true])
        ),
        activitiesByThread: Object.fromEntries(
          threads.map((thread) => [
            thread.id,
            [makeActivity({ threadId: thread.id, kind: "tool.completed" })],
          ])
        ),
        activitiesLoadedByThread: Object.fromEntries(
          threads.map((thread) => [thread.id, true])
        ),
      })

      // r1 is r0's sidebar neighbour and stays; r10 and r11 are the cold end.
      useChatStore.getState().setActiveThread("r0")

      const state = useChatStore.getState()
      expect(state.lruOrder).toHaveLength(10)
      expect(state.lruOrder[0]).toBe("r0")
      const evicted = threads
        .map((thread) => thread.id)
        .filter((id) => !state.lruOrder.includes(id))
      expect(evicted).toEqual(["r10", "r11"])
      for (const id of evicted) {
        expect(state.messagesLoadedByThread[id]).toBe(false)
        expect(state.activitiesByThread[id]).toBeUndefined()
        expect(state.activitiesLoadedByThread[id]).toBeUndefined()
      }
      expect(state.activitiesByThread.r0).toHaveLength(1)
      expect(state.activitiesByThread.r1).toHaveLength(1)
    })
  })
})
