import { chatApprovalSchema } from "@betterc0de/schema"
import { describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { respondToChatApproval } from "./requests"

vi.mock("../checkpoint-recovery-fence", () => ({
  withCheckpointRecoveryMutation: (
    _state: unknown,
    _scope: unknown,
    operation: () => unknown
  ) => operation(),
}))
vi.mock("./dispatch", () => ({
  asHubProviderKind: (kind: string) => (kind === "claude" ? kind : null),
  chatRecoveryWorkspaces: () => [],
  resolveHubInstanceId: () => "claude-main",
}))
vi.mock("../../ws/threadActivityBroadcast", () => ({
  broadcastThreadActivity: vi.fn(),
}))

describe("approval permission persistence", () => {
  it.each(["hub", "legacy"] as const)(
    "does not persist grants when the %s rejects an approval",
    async (provider) => {
      const { state, upsertGrant } = fixture(provider, true)
      await expect(
        respondToChatApproval(state, approval(provider))
      ).rejects.toThrow()
      expect(upsertGrant).not.toHaveBeenCalled()
    }
  )

  it.each(["hub", "legacy"] as const)(
    "persists grants only after the %s acknowledges approval",
    async (provider) => {
      const { state, upsertGrant, acknowledged } = fixture(provider, false)
      await expect(
        respondToChatApproval(state, approval(provider))
      ).resolves.toEqual({
        status: "acknowledged",
      })
      expect(upsertGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: "workspace",
          toolName: "Edit",
          behavior: "allow",
        })
      )
      expect(acknowledged.mock.invocationCallOrder[0]).toBeLessThan(
        upsertGrant.mock.invocationCallOrder[0]!
      )
    }
  )

  it("does not persist allow grants from a deny response", async () => {
    const { state, upsertGrant } = fixture("hub", false)
    await respondToChatApproval(state, { ...approval("hub"), decision: "deny" })
    expect(upsertGrant).not.toHaveBeenCalled()
  })
})

function approval(provider: "hub" | "legacy") {
  return chatApprovalSchema.parse({
    threadId: "thread-approval",
    providerKind: provider === "hub" ? "claude" : "custom",
    requestId: "request-approval",
    decision: "approve",
    updatedPermissions: [
      {
        type: "addRules",
        behavior: "allow",
        destination: "projectSettings",
        rules: [{ toolName: "Edit", ruleContent: "src/**" }],
      },
    ],
  })
}

function fixture(provider: "hub" | "legacy", fail: boolean) {
  const upsertGrant = vi.fn()
  const acknowledged = vi.fn()
  const respond = vi.fn(async () => {
    if (fail) throw new Error("Approval request no longer exists")
    acknowledged()
  })
  const state = {
    agentPermissions: { upsertGrant },
    threads: { getThreadProjectPath: () => process.cwd() },
    threadActivities: { upsert: vi.fn() },
    providerSessionBindings: {},
    providerHub: { has: () => provider === "hub", respondToRequest: respond },
    providers: {
      resolveProviderKind: (kind: string) => kind,
      respondToApproval: respond,
    },
  } as unknown as AppState
  return { state, upsertGrant, acknowledged }
}
