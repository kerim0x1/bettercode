import { beforeEach, describe, expect, it, vi } from "vitest"
import { ClaudeAgentAdapter } from "./adapter"
import type { ProviderSendTurnInput } from "../../types"
import type { SdkModule } from "./sdk-types"

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  query: vi.fn(),
  tools: vi.fn(),
  permissions: vi.fn(),
}))
vi.mock("./session-manager", () => ({ loadClaudeSdk: mocks.load }))
vi.mock("../../../services/workspace", () => ({
  listProjectTools: mocks.tools,
  listProjectPermissions: mocks.permissions,
}))

const input = {
  thread_id: "legacy-claude",
  project_path: process.cwd(),
  message: "hello",
  model_id: "claude-opus-4-7",
  history: [],
} as ProviderSendTurnInput

describe("legacy Claude startup boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.load.mockResolvedValue({ query: mocks.query })
    mocks.tools.mockResolvedValue([])
    mocks.permissions.mockResolvedValue([])
    mocks.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close: vi.fn(),
    })
  })

  it("fails closed when project permission rules cannot be read", async () => {
    const failure = new Error("project policy unreadable")
    mocks.permissions.mockRejectedValue(failure)
    await expect(new ClaudeAgentAdapter().sendMessage(input)).rejects.toBe(
      failure
    )
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it("releases the pending approval before waiting for the SDK to interrupt", async () => {
    const adapter = new ClaudeAgentAdapter()
    const emit = vi.fn()
    adapter.connectEventBus({ emitEvent: emit })
    const interrupt = vi.fn()
    mocks.query.mockImplementation(
      ({ options }: Parameters<SdkModule["query"]>[0]) => {
        const canUseTool = options!.canUseTool!
        let approval: ReturnType<typeof canUseTool>
        interrupt.mockImplementation(async () => {
          await expect(approval).resolves.toMatchObject({ behavior: "deny" })
        })
        return {
          [Symbol.asyncIterator]() {
            approval = canUseTool("Write", { file_path: "src/file.ts" })
            return {
              async next() {
                await approval
                return { done: true, value: undefined }
              },
            }
          },
          interrupt,
        }
      }
    )

    const sending = adapter.sendMessage({
      ...input,
      permission_level: "ask-on-edit",
    })
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: "tool_approval_requested" })
      )
    )
    await adapter.interrupt(input.thread_id)
    await sending
    expect(interrupt).toHaveBeenCalledOnce()
  })

  it.each(["sdk", "policy"])(
    "cancels before query creation while waiting for %s",
    async (stage) => {
      let release!: () => void
      const adapter = new ClaudeAgentAdapter()
      if (stage === "sdk")
        mocks.load.mockImplementation(
          () =>
            new Promise((resolve) => {
              release = () => resolve({ query: mocks.query })
            })
        )
      else
        mocks.permissions.mockImplementation(
          () =>
            new Promise((resolve) => {
              release = () => resolve([])
            })
        )
      const sending = adapter.sendMessage(input)
      await vi.waitFor(() => expect(release).toBeTypeOf("function"))
      await adapter.interrupt(input.thread_id)
      release()
      await sending
      expect(mocks.query).not.toHaveBeenCalled()
      mocks.load.mockResolvedValue({ query: mocks.query })
      mocks.permissions.mockResolvedValue([])
      await adapter.sendMessage(input)
      expect(mocks.query).toHaveBeenCalledOnce()
    }
  )
})
