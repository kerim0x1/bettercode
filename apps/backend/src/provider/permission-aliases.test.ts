import { describe, expect, it } from "vitest"
import {
  evaluatePermission,
  isBypassPermissionLevel,
  normalizeGatePermissionLevel,
  normalizeLevel,
  providerPermissionModeForLevel,
  providerRuntimeModeForLevel,
} from "./permissions"
import { isImagegenAutoAllowed } from "./shared/chat-mode-tools"
import {
  bindAgentPermissionRuntimeContext,
  clearAgentPermissionRuntimeContext,
  configuredAgentAllowMayAutoApprove,
} from "./agent-permission-runtime"

describe("permission aliases read and full", () => {
  it("maps read and full to the same gate outcomes as their canonical forms", () => {
    expect(normalizeLevel("read")).toBe("read-only")
    expect(normalizeLevel("full")).toBe("allow-edits")
    expect(normalizeGatePermissionLevel("read")).toBe("read-only")
    expect(normalizeGatePermissionLevel("full")).toBe("allow-edits")
    expect(normalizeGatePermissionLevel("full-access")).toBe("allow-edits")

    expect(evaluatePermission("read", "write")).toBe(
      evaluatePermission("read-only", "write")
    )
    expect(evaluatePermission("full", "write")).toBe(
      evaluatePermission("allow-edits", "write")
    )
    expect(isImagegenAutoAllowed("agent", "read")).toBe(
      isImagegenAutoAllowed("agent", "read-only")
    )
    expect(isImagegenAutoAllowed("agent", "full")).toBe(
      isImagegenAutoAllowed("agent", "allow-edits")
    )
  })

  it("gives every alias one meaning across gates, live modes and runtime modes", () => {
    // `full`/`full-access` were the "Full Access" label for allow-edits; no
    // mapper may read them as bypass.
    for (const alias of [
      "full",
      "full-access",
      "FULL-ACCESS",
      "auto-accept-edits",
    ]) {
      expect(normalizeLevel(alias)).toBe("allow-edits")
      expect(normalizeGatePermissionLevel(alias)).toBe("allow-edits")
      expect(isBypassPermissionLevel(alias)).toBe(false)
      expect(providerPermissionModeForLevel(alias)).toBe("acceptEdits")
      expect(providerRuntimeModeForLevel(alias)).toBe("auto-accept-edits")
    }
    expect(isBypassPermissionLevel(" Bypass ")).toBe(true)
    expect(providerPermissionModeForLevel("bypass")).toBe("bypassPermissions")
    expect(providerRuntimeModeForLevel("bypass")).toBe("full-access")
    expect(normalizeLevel("approval-required")).toBe("ask-on-edit")
    expect(providerRuntimeModeForLevel("approval-required")).toBe(
      "approval-required"
    )
    expect(providerPermissionModeForLevel("plan")).toBe("plan")
    expect(providerPermissionModeForLevel("read")).toBe("default")
    expect(providerRuntimeModeForLevel("read")).toBe("read-only")
    // Unknown spellings fail closed instead of inheriting a stored mode;
    // only a missing level or `default` defers to the caller.
    expect(isBypassPermissionLevel("bypassPermissions")).toBe(false)
    expect(providerRuntimeModeForLevel("something-new")).toBe(
      "approval-required"
    )
    expect(providerRuntimeModeForLevel(null)).toBeUndefined()
    expect(providerRuntimeModeForLevel("default")).toBeUndefined()
  })

  it("treats read as read-only for durable allow auto-approve", () => {
    const token = bindAgentPermissionRuntimeContext({
      threadId: "alias-thread",
      permissionLevel: "read",
      chatMode: "agent",
    })
    try {
      expect(configuredAgentAllowMayAutoApprove("alias-thread")).toBe(false)
    } finally {
      clearAgentPermissionRuntimeContext("alias-thread", token)
    }
    const allowToken = bindAgentPermissionRuntimeContext({
      threadId: "alias-thread-full",
      permissionLevel: "full",
      chatMode: "agent",
    })
    try {
      expect(configuredAgentAllowMayAutoApprove("alias-thread-full")).toBe(true)
    } finally {
      clearAgentPermissionRuntimeContext("alias-thread-full", allowToken)
    }
  })
})
