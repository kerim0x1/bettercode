import { describe, expect, it, vi } from "vitest"
import {
  describeCliScanProjectScope,
  resolveCliScanContext,
} from "./cli-scan-context"

describe("resolveCliScanContext", () => {
  it("reports no selection without asking the trust service", async () => {
    const lookup = vi.fn()

    await expect(resolveCliScanContext(null, lookup)).resolves.toBeUndefined()
    expect(lookup).not.toHaveBeenCalled()
  })

  it("forwards the backend-normalized trusted project root", async () => {
    const lookup = vi.fn(async () => ({
      trust: {
        workspacePath: "C:\\workspace",
        state: "trusted" as const,
        explicit: true,
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
    }))

    await expect(
      resolveCliScanContext("C:\\workspace\\.", lookup)
    ).resolves.toEqual({
      projectPath: "C:\\workspace",
      workspaceTrusted: true,
    })
  })

  it("does not treat the backend's compatibility default as trust", async () => {
    const lookup = vi.fn(async () => ({
      trust: {
        workspacePath: "C:\\workspace",
        state: "trusted" as const,
        explicit: false,
        updatedAt: null,
      },
    }))

    await expect(
      resolveCliScanContext("C:\\workspace", lookup)
    ).resolves.toEqual({
      projectPath: "C:\\workspace",
      workspaceTrusted: false,
    })
  })

  it("fails closed when workspace trust cannot be resolved", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("backend unavailable")
    })

    await expect(
      resolveCliScanContext("C:\\workspace", lookup)
    ).resolves.toEqual({
      projectPath: "C:\\workspace",
      workspaceTrusted: false,
    })
  })

  it("preserves an explicit backend untrusted decision", async () => {
    const lookup = vi.fn(async () => ({
      trust: {
        workspacePath: "C:\\workspace",
        state: "untrusted" as const,
        explicit: true,
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
    }))

    await expect(
      resolveCliScanContext("C:\\workspace", lookup)
    ).resolves.toEqual({
      projectPath: "C:\\workspace",
      workspaceTrusted: false,
    })
  })

  it("describes the intentional user-global-only scan states", () => {
    expect(
      describeCliScanProjectScope({
        status: "not-selected",
        projectPath: null,
        workspaceTrusted: false,
      })
    ).toContain("no project is selected")
    expect(
      describeCliScanProjectScope({
        status: "untrusted",
        projectPath: "C:\\workspace",
        workspaceTrusted: false,
      })
    ).toContain("workspace is not trusted")
    expect(
      describeCliScanProjectScope({
        status: "trusted",
        projectPath: "C:\\workspace",
        workspaceTrusted: true,
      })
    ).toBe("")
  })
})
