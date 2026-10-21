import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  trustWorkspaceAndRetry,
  WorkspaceTrustAction,
} from "@/components/chat/workspace-trust-action"
import { HttpError } from "@/lib/errors/types"
import {
  isWorkspaceUntrustedError,
  useWorkspaceTrustPromptStore,
} from "@/lib/workspace-trust-prompts"
import { setAgentWorkspaceTrust } from "@/services/backend/chatApi"
import { handleError } from "@/lib/errors"

vi.mock("@/services/backend/chatApi", () => ({
  setAgentWorkspaceTrust: vi.fn(),
}))
vi.mock("@/lib/errors", () => ({ handleError: vi.fn() }))
vi.mock("@/components/dialogs/confirm-provider", () => ({
  useConfirm: () => vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  useWorkspaceTrustPromptStore.setState({ byMessageId: {} })
})

describe("untrusted workspace errors", () => {
  it("recognizes the backend's workspace_untrusted refusal only", () => {
    expect(
      isWorkspaceUntrustedError(
        new HttpError(
          "This workspace has not been trusted.",
          403,
          "/chat/send",
          {
            code: "workspace_untrusted",
          }
        )
      )
    ).toBe(true)
    expect(
      isWorkspaceUntrustedError(
        new HttpError("Forbidden", 403, "/chat/send", {
          code: "agent_workspace_required",
        })
      )
    ).toBe(false)
    expect(isWorkspaceUntrustedError(new Error("workspace_untrusted"))).toBe(
      false
    )
  })
})

describe("inline workspace trust action", () => {
  it("renders only under the refused message", () => {
    useWorkspaceTrustPromptStore
      .getState()
      .register("error-1", { workspacePath: "/repo" })
    const refused = renderToStaticMarkup(
      createElement(WorkspaceTrustAction, {
        messageId: "error-1",
        onRetry: vi.fn(),
      })
    )
    expect(refused).toContain("Trust this workspace")
    expect(refused).toContain('type="button"')
    expect(
      renderToStaticMarkup(
        createElement(WorkspaceTrustAction, {
          messageId: "other",
          onRetry: vi.fn(),
        })
      )
    ).toBe("")
  })

  it("does nothing when the confirmation is cancelled", async () => {
    const onRetry = vi.fn()
    const confirm = vi.fn().mockResolvedValue(false)
    await expect(
      trustWorkspaceAndRetry({ workspacePath: "/repo" }, { confirm, onRetry })
    ).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Trust this workspace?",
        description: expect.stringContaining("/repo"),
      })
    )
    expect(setAgentWorkspaceTrust).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("trusts the workspace, clears its prompts and resends", async () => {
    const store = useWorkspaceTrustPromptStore.getState()
    store.register("error-1", { workspacePath: "/repo" })
    store.register("error-2", { workspacePath: "/repo" })
    store.register("error-3", { workspacePath: "/other" })
    vi.mocked(setAgentWorkspaceTrust).mockResolvedValueOnce({
      trust: {
        workspacePath: "/repo",
        state: "trusted",
        explicit: true,
        updatedAt: "2026-10-07T00:00:00Z",
      },
    } as Awaited<ReturnType<typeof setAgentWorkspaceTrust>>)
    const onRetry = vi.fn()
    const onTrusting = vi.fn()

    await expect(
      trustWorkspaceAndRetry(
        { workspacePath: "/repo" },
        { confirm: vi.fn().mockResolvedValue(true), onRetry, onTrusting }
      )
    ).resolves.toBe(true)

    expect(setAgentWorkspaceTrust).toHaveBeenCalledWith("/repo", "trusted")
    expect(onTrusting).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(
      Object.keys(useWorkspaceTrustPromptStore.getState().byMessageId)
    ).toEqual(["error-3"])
  })

  it("reports a failed trust request and keeps the action", async () => {
    useWorkspaceTrustPromptStore
      .getState()
      .register("error-1", { workspacePath: "/repo" })
    const failure = new Error("backend offline")
    vi.mocked(setAgentWorkspaceTrust).mockRejectedValueOnce(failure)
    const onRetry = vi.fn()

    await expect(
      trustWorkspaceAndRetry(
        { workspacePath: "/repo" },
        { confirm: vi.fn().mockResolvedValue(true), onRetry }
      )
    ).resolves.toBe(false)

    expect(handleError).toHaveBeenCalledWith(failure, {
      source: "workspace-trust",
    })
    expect(onRetry).not.toHaveBeenCalled()
    expect(
      useWorkspaceTrustPromptStore.getState().byMessageId["error-1"]
    ).toEqual({ workspacePath: "/repo" })
  })
})
