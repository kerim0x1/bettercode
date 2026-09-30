import fs from "node:fs/promises"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { type ChildProcess, spawn } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { defaultSettings } from "@betterc0de/schema"

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}))
vi.mock("./process-termination", async (original) => ({
  ...(await original<typeof import("./process-termination")>()),
  runWindowsTaskkillDetailed: vi.fn(),
}))

import { runWindowsTaskkillDetailed } from "./process-termination"
import {
  activeNativeTextGenerationResourceCount,
  resumeNativeTextGenerationAdmissions,
  runNativeTextGeneration,
  shutdownAllNativeTextGenerationResources,
} from "./native-text-generation"

describe("native text process quarantine", () => {
  it.skipIf(process.platform !== "win32")(
    "allows a busy Windows tree helper to finish before releasing private files",
    async () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 12346,
        exitCode: null as number | null,
        signalCode: null,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => false),
      })
      const killer = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => false),
      })
      vi.mocked(spawn).mockImplementation(
        (command) =>
          (command === "taskkill.exe"
            ? killer
            : child) as unknown as ChildProcess
      )
      const actual = await vi.importActual<
        typeof import("./process-termination")
      >("./process-termination")
      vi.mocked(runWindowsTaskkillDetailed).mockImplementation(
        actual.runWindowsTaskkillDetailed
      )
      let directory = ""
      vi.useFakeTimers()
      try {
        const running = runNativeTextGeneration({
          settings: {
            ...defaultSettings(),
            provider_instances: {
              test: {
                instanceId: "test",
                driver: "codex",
                enabled: true,
                config: { binaryPath: process.execPath },
                environment: [],
              },
            },
          },
          modelSelection: { instanceId: "test", model: "gpt-5.4" },
          prompt: "private context",
          schemaName: "threadTitle",
          timeoutMs: 100,
        })
        const rejected = expect(running).rejects.toThrow("timed out")
        await vi.waitFor(() =>
          expect(
            vi
              .mocked(spawn)
              .mock.calls.some(([command]) => command === process.execPath)
          ).toBe(true)
        )
        directory = String(
          vi
            .mocked(spawn)
            .mock.calls.find(([command]) => command === process.execPath)![2]!
            .cwd
        )
        await vi.advanceTimersByTimeAsync(2_600)
        expect(killer.kill).not.toHaveBeenCalled()
        expect((await fs.stat(directory)).isDirectory()).toBe(true)
        child.exitCode = 0
        child.emit("close", 0, null)
        killer.emit("close", 0, null)
        await rejected
        expect(activeNativeTextGenerationResourceCount()).toBe(0)
        await expect(fs.stat(directory)).rejects.toMatchObject({
          code: "ENOENT",
        })
        resumeNativeTextGenerationAdmissions()
      } finally {
        vi.useRealTimers()
        vi.restoreAllMocks()
        if (directory) await fs.rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform !== "win32")(
    "keeps the live child's files and closes admission until a confirmed retry",
    async () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        exitCode: null as number | null,
        signalCode: null,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => false),
      })
      vi.mocked(spawn)
        .mockReset()
        .mockReturnValue(child as unknown as ChildProcess)
      vi.mocked(runWindowsTaskkillDetailed).mockResolvedValue({
        status: "closed",
        code: 1,
        signal: null,
      })
      let directory = ""
      vi.useFakeTimers()
      try {
        const running = runNativeTextGeneration({
          settings: {
            ...defaultSettings(),
            provider_instances: {
              test: {
                instanceId: "test",
                driver: "codex",
                enabled: true,
                config: { binaryPath: process.execPath },
                environment: [],
              },
            },
          },
          modelSelection: { instanceId: "test", model: "gpt-5.4" },
          prompt: "private context",
          schemaName: "threadTitle",
          timeoutMs: 100,
        })
        const rejected = expect(running).rejects.toThrow(
          "cleanup could not be confirmed"
        )
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
        directory = String(vi.mocked(spawn).mock.calls[0]![2]!.cwd)
        await vi.advanceTimersByTimeAsync(2_200)
        await rejected
        expect((await fs.stat(directory)).isDirectory()).toBe(true)
        expect(activeNativeTextGenerationResourceCount()).toBe(2)
        await expect(
          runNativeTextGeneration({
            settings: defaultSettings(),
            modelSelection: null,
            prompt: "blocked",
            schemaName: "threadTitle",
          })
        ).rejects.toMatchObject({
          code: "NATIVE_TEXT_GENERATION_ADMISSION_CLOSED",
        })
        vi.mocked(runWindowsTaskkillDetailed).mockImplementation(async () => {
          child.exitCode = 0
          child.emit("close", 0, null)
          return { status: "closed", code: 0, signal: null }
        })
        await expect(shutdownAllNativeTextGenerationResources()).resolves.toBe(
          2
        )
        expect(activeNativeTextGenerationResourceCount()).toBe(0)
        await expect(fs.stat(directory)).rejects.toMatchObject({
          code: "ENOENT",
        })
        resumeNativeTextGenerationAdmissions()
      } finally {
        vi.useRealTimers()
        vi.restoreAllMocks()
        if (directory) await fs.rm(directory, { recursive: true, force: true })
      }
    }
  )
})
