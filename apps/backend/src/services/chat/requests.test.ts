import {
  chatApprovalSchema,
  chatPermissionModeSchema,
} from "@betterc0de/schema"
import { describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import {
  capRemoteChatPermissions,
  DESKTOP_PERMISSION_ACCESS,
  permittedApprovalUpdates,
  respondToChatApproval,
  updateChatPermissionMode,
} from "./requests"

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

  it("never lets a paired device write durable grants or switch to bypass", async () => {
    const { state, upsertGrant, respond } = fixture("hub", false)
    const body = chatApprovalSchema.parse({
      ...approval("hub"),
      updatedPermissions: [
        ...(approval("hub").updatedPermissions ?? []),
        {
          type: "addRules",
          behavior: "allow",
          destination: "session",
          rules: [{ toolName: "Read", ruleContent: "src/**" }],
        },
        { type: "setMode", mode: "bypassPermissions", destination: "session" },
      ],
    })
    await respondToChatApproval(state, body, { remote: true, mayBypass: false })
    expect(upsertGrant).not.toHaveBeenCalled()
    const forwarded = (
      respond.mock.calls[0] as unknown as [
        unknown,
        unknown,
        unknown,
        { updatedPermissions?: Array<{ destination: string; type: string }> },
      ]
    )[3]
    expect(forwarded.updatedPermissions).toEqual([
      expect.objectContaining({ type: "addRules", destination: "session" }),
    ])
  })
})

describe("remote permission caps", () => {
  const remote = { remote: true, mayBypass: false } as const

  it("lowers bypass, aliases of it and a missing level for a paired device without the grant", () => {
    for (const level of ["bypass", " BYPASS ", null, ""]) {
      expect(
        capRemoteChatPermissions(
          {
            permission_level: level,
            sandbox: "dangerFullAccess",
            approvalPolicy: "never",
          },
          remote
        )
      ).toEqual({
        permission_level: "ask-on-edit",
        sandbox: null,
        approvalPolicy: null,
      })
    }
    // `full-access` is the old "Full Access" label: allow-edits, not bypass.
    for (const level of [
      "allow-edits",
      "full-access",
      "read-only",
      "ask-on-edit",
    ]) {
      expect(
        capRemoteChatPermissions({ permission_level: level }, remote)
          .permission_level
      ).toBe(level)
    }
  })

  it("keeps bypass for the desktop and for a device with the terminal grant", () => {
    const body = { permission_level: "bypass", sandbox: "dangerFullAccess" }
    expect(capRemoteChatPermissions(body, DESKTOP_PERMISSION_ACCESS)).toBe(body)
    expect(
      capRemoteChatPermissions(body, { remote: true, mayBypass: true })
    ).toBe(body)
  })

  it("refuses a paired device switching a thread to bypass", async () => {
    const state = {} as AppState
    for (const permissionLevel of ["bypass", "Bypass"]) {
      await expect(
        updateChatPermissionMode(
          state,
          chatPermissionModeSchema.parse({
            threadId: "thread-remote",
            providerKind: "claude",
            permissionLevel,
          }),
          remote
        )
      ).rejects.toMatchObject({
        statusCode: 403,
        code: "remote_bypass_disabled",
      })
    }
  })

  it("filters approval updates only for paired devices", () => {
    const updates = [
      { type: "addRules", destination: "userSettings" },
      { type: "addRules", destination: "session" },
      { type: "setMode", mode: "bypassPermissions", destination: "session" },
    ]
    expect(
      permittedApprovalUpdates(updates, DESKTOP_PERMISSION_ACCESS)
    ).toEqual(updates)
    expect(
      permittedApprovalUpdates(updates, { remote: true, mayBypass: true })
    ).toEqual([updates[1], updates[2]])
    expect(permittedApprovalUpdates(updates, remote)).toEqual([updates[1]])
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
  return { state, upsertGrant, acknowledged, respond }
}
