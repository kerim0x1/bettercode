import { beforeEach, describe, expect, it, vi } from "vitest"

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
const deleteCheckpointsAfter = vi.hoisted(() => vi.fn())
vi.mock("@/lib/checkpoint-store", () => ({
  autoCheckpointFromToolCalls: vi.fn().mockResolvedValue(undefined),
  useCheckpointStore: {
    getState: () => ({
      deleteCheckpointsAfter,
      clearCheckpointsForThread: vi.fn(),
    }),
  },
}))
const rewindApi = vi.hoisted(() => ({
  loadThreadRewindPlan: vi.fn(),
  rewindThreadToMessage: vi.fn(),
}))
vi.mock("@/services/backend/rewind-api", () => rewindApi)

import { browserElementAttachment } from "@betterc0de/schema"
import { emptyStreamState, useChatStore } from "@/lib/chat-store"
import type { ChatMessage } from "@/lib/chat-store"
import {
  changedFilesAfter,
  editableAttachments,
  fileRevertBlockerText,
  mergeChangedFiles,
  previewRewind,
  resendAttachments,
  rewindAndResend,
} from "@/lib/message-rewind"

const element = {
  url: "https://example.com/",
  selector: "#hero",
  tagName: "h1",
  text: "Welcome",
  label: "Welcome",
}

const image = {
  type: "file",
  filename: "screen.png",
  mediaType: "image/png",
  url: "data:image/png;base64,aGVsbG8=",
}

function message(
  id: string,
  role: ChatMessage["role"],
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    role,
    content: id,
    createdAt: "2026-10-20T10:00:00.000Z",
    ...overrides,
  }
}

const transcript: ChatMessage[] = [
  message("user-1", "user"),
  message("answer-1", "assistant", {
    diffs: [
      {
        path: "/repo/src/a.ts",
        additions: 1,
        deletions: 0,
        oldText: "",
        newText: "",
        isNew: false,
      },
    ],
  }),
  message("user-2", "user", {
    content: "Make it blue",
    attachments: [image, browserElementAttachment(element)],
  }),
  message("answer-2", "assistant", {
    diffs: [
      {
        path: "/repo/src/b.ts",
        additions: 2,
        deletions: 1,
        oldText: "",
        newText: "",
        isNew: false,
      },
    ],
  }),
]

function resetChat() {
  useChatStore.setState({
    threads: [
      {
        id: "thread-1",
        title: "Thread",
        projectName: "repo",
        projectPath: "/repo",
        messages: transcript,
        messageCount: transcript.length,
        createdAt: "2026-10-20T09:00:00.000Z",
        updatedAt: "2026-10-20T10:00:00.000Z",
      },
    ],
    activeThreadId: "thread-1",
    messagesLoadedByThread: { "thread-1": true },
    activitiesByThread: { "thread-1": [] },
    activitiesLoadedByThread: { "thread-1": true },
    streamingByThread: {},
    autonomyByThread: {},
    draftsByThread: {},
  })
}

describe("edit and resend helpers", () => {
  it("lists the message's attachments for the editor", () => {
    expect(editableAttachments(transcript[2]!)).toEqual([
      { key: "0", kind: "file", label: "screen.png" },
      { key: "1", kind: "element", label: "<h1> Welcome" },
    ])
  })

  it("resends kept files as files and kept elements as element tags", () => {
    const kept = resendAttachments(transcript[2]!, new Set(["0", "1"]))
    expect(kept.files).toEqual([
      {
        type: "file",
        filename: "screen.png",
        mediaType: "image/png",
        url: image.url,
      },
    ])
    expect(kept.elements).toEqual([expect.objectContaining(element)])
    expect(kept.missingData).toBe(false)
    expect(resendAttachments(transcript[2]!, new Set()).files).toEqual([])
  })

  it("notices a kept attachment whose data a light page left out", () => {
    const light = message("user-3", "user", {
      attachments: [
        { ...image, url: "data:image/png;base64,", dataOmitted: true },
      ],
    })
    expect(resendAttachments(light, new Set(["0"])).missingData).toBe(true)
    expect(resendAttachments(light, new Set()).missingData).toBe(false)
  })

  it("names each changed file once, relative to the workspace", () => {
    expect(changedFilesAfter(transcript, 2)).toEqual(["/repo/src/b.ts"])
    expect(
      mergeChangedFiles(
        [["src/b.ts", "src\\c.ts"], changedFilesAfter(transcript, 0)],
        "/repo/"
      )
    ).toEqual(["src/b.ts", "src/c.ts", "src/a.ts"])
  })

  it("explains every reason a file revert is unavailable", () => {
    expect(fileRevertBlockerText(null)).toBeNull()
    for (const blocker of [
      "unsaved",
      "no_session",
      "not_git",
      "no_checkpoint",
      "no_changes",
    ] as const) {
      expect(fileRevertBlockerText(blocker)).toMatch(/\w/)
    }
  })
})

describe("previewRewind", () => {
  beforeEach(() => {
    resetChat()
    rewindApi.loadThreadRewindPlan.mockReset()
  })

  it("joins the backend's checkpoint files with the answers' diffs", async () => {
    rewindApi.loadThreadRewindPlan.mockResolvedValue({
      messageId: "user-2",
      removedMessages: 2,
      changedFiles: ["src/b.ts", "src/c.ts"],
      changedFilesTruncated: false,
      fileRevert: { available: true, blocker: null, checkpointTurn: 1 },
    })
    const preview = await previewRewind("thread-1", "user-2", "/repo")
    expect(preview.changedFiles).toEqual(["src/b.ts", "src/c.ts"])
    expect(preview.running).toBe(false)
  })
})

describe("rewindAndResend", () => {
  beforeEach(() => {
    resetChat()
    deleteCheckpointsAfter.mockReset()
    rewindApi.rewindThreadToMessage.mockReset()
  })

  it("rewinds to just before the message and sends the edited text", async () => {
    rewindApi.rewindThreadToMessage.mockResolvedValue({
      rewound: true,
      revertedFiles: false,
      deletedMessages: 2,
      rolledBackTurns: 1,
      providerSession: "rolled_back",
    })
    const resend = vi.fn().mockResolvedValue(undefined)

    await rewindAndResend({
      threadId: "thread-1",
      messageId: "user-2",
      text: "  Make it green  ",
      keptAttachmentKeys: new Set(["0", "1"]),
      revertFiles: false,
      stopRunningTurn: false,
      resend,
    })

    expect(rewindApi.rewindThreadToMessage).toHaveBeenCalledWith(
      "thread-1",
      "user-2",
      { revertFiles: false }
    )
    const thread = useChatStore.getState().threads[0]!
    expect(thread.messages.map((entry) => entry.id)).toEqual([
      "user-1",
      "answer-1",
    ])
    expect(thread.messageCount).toBe(2)
    expect(deleteCheckpointsAfter).toHaveBeenCalledWith("thread-1", {
      messageIds: ["user-2", "answer-2"],
    })
    expect(resend).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        text: "Make it green",
        files: [expect.objectContaining({ filename: "screen.png" })],
        queuedSubmission: expect.objectContaining({
          browserElements: [expect.objectContaining(element)],
        }),
      })
    )
  })

  it("changes nothing when the backend refuses the rewind", async () => {
    rewindApi.rewindThreadToMessage.mockResolvedValue({
      rewound: false,
      revertedFiles: false,
      deletedMessages: 0,
      rolledBackTurns: 0,
      providerSession: "unchanged",
      reason: "The checkpoint for turn 1 is unavailable.",
    })
    const resend = vi.fn()

    await expect(
      rewindAndResend({
        threadId: "thread-1",
        messageId: "user-2",
        text: "Make it green",
        keptAttachmentKeys: new Set(),
        revertFiles: true,
        stopRunningTurn: false,
        resend,
      })
    ).rejects.toThrow("The checkpoint for turn 1 is unavailable.")
    expect(useChatStore.getState().threads[0]!.messages).toHaveLength(4)
    expect(resend).not.toHaveBeenCalled()
  })

  it("refuses while a turn runs unless stopping it was confirmed", async () => {
    useChatStore.setState({
      streamingByThread: {
        "thread-1": { ...emptyStreamState, isStreaming: true },
      },
    })
    await expect(
      rewindAndResend({
        threadId: "thread-1",
        messageId: "user-2",
        text: "Make it green",
        keptAttachmentKeys: new Set(),
        revertFiles: false,
        stopRunningTurn: false,
        resend: vi.fn(),
      })
    ).rejects.toThrow(/Stop it first/)
    expect(rewindApi.rewindThreadToMessage).not.toHaveBeenCalled()
  })

  it("refuses an empty message before touching the chat", async () => {
    await expect(
      rewindAndResend({
        threadId: "thread-1",
        messageId: "user-2",
        text: "   ",
        keptAttachmentKeys: new Set(["1"]),
        revertFiles: false,
        stopRunningTurn: false,
        resend: vi.fn(),
      })
    ).rejects.toThrow(/Write a message/)
    expect(rewindApi.rewindThreadToMessage).not.toHaveBeenCalled()
  })

  it("puts the text back in the composer when the send is refused", async () => {
    rewindApi.rewindThreadToMessage.mockResolvedValue({
      rewound: true,
      revertedFiles: false,
      deletedMessages: 2,
      rolledBackTurns: 0,
      providerSession: "reset",
    })

    await rewindAndResend({
      threadId: "thread-1",
      messageId: "user-2",
      text: "Make it green",
      keptAttachmentKeys: new Set(),
      revertFiles: false,
      stopRunningTurn: false,
      resend: () => false,
    })

    expect(useChatStore.getState().getDraft("thread-1")).toBe("Make it green")
  })
})
