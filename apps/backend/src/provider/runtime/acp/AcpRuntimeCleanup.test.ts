import { describe, expect, it, vi } from "vitest"
import { AcpJsonRpcClient } from "./AcpJsonRpcClient"
import { createCursorAcpRuntime } from "../cursor/CursorAcpRuntime"
import { createGrokAcpRuntime } from "../grok-cli/GrokAcpRuntime"

describe("ACP runtime cleanup retention", () => {
  it("retains the Cursor client when failed startup cleanup must be retried", async () => {
    const startFailure = new Error("cursor spawn failed")
    const cleanupFailure = new Error("cursor client close failed")
    const spawnChild = vi
      .spyOn(AcpJsonRpcClient.prototype, "spawnChild")
      .mockRejectedValue(startFailure)
    const close = vi
      .spyOn(AcpJsonRpcClient.prototype, "close")
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const runtime = createCursorAcpRuntime({
      // Spawning is mocked, but the spawn-input guard requires an absolute path.
      settings: { binaryPath: process.execPath },
      cwd: process.cwd(),
      clientInfo: { name: "test", version: "0.0.0" },
    })

    try {
      await expect(runtime.start()).rejects.toMatchObject({
        name: "AggregateError",
        errors: [startFailure, cleanupFailure],
      })
      expect(
        (runtime as unknown as { client: AcpJsonRpcClient | null }).client
      ).toBeInstanceOf(AcpJsonRpcClient)

      await expect(runtime.close()).resolves.toBeUndefined()
      expect(
        (runtime as unknown as { client: AcpJsonRpcClient | null }).client
      ).toBeNull()
      expect(close).toHaveBeenCalledTimes(2)
    } finally {
      spawnChild.mockRestore()
      close.mockRestore()
    }
  })

  it("retains the Grok client when failed startup cleanup must be retried", async () => {
    const startFailure = new Error("grok spawn failed")
    const cleanupFailure = new Error("grok client close failed")
    const spawnChild = vi
      .spyOn(AcpJsonRpcClient.prototype, "spawnChild")
      .mockRejectedValue(startFailure)
    const close = vi
      .spyOn(AcpJsonRpcClient.prototype, "close")
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const runtime = createGrokAcpRuntime({
      settings: { binaryPath: "grok" },
      cwd: process.cwd(),
      clientInfo: { name: "test", version: "0.0.0" },
    })

    try {
      await expect(runtime.start()).rejects.toMatchObject({
        name: "AggregateError",
        errors: [startFailure, cleanupFailure],
      })
      expect(
        (runtime as unknown as { client: AcpJsonRpcClient | null }).client
      ).toBeInstanceOf(AcpJsonRpcClient)

      await expect(runtime.close()).resolves.toBeUndefined()
      expect(
        (runtime as unknown as { client: AcpJsonRpcClient | null }).client
      ).toBeNull()
      expect(close).toHaveBeenCalledTimes(2)
    } finally {
      spawnChild.mockRestore()
      close.mockRestore()
    }
  })
})
