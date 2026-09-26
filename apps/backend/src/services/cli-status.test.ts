import { afterEach, describe, expect, it, vi } from "vitest"
import type { ProviderAdapter } from "../provider/adapter"
import type { ProviderAdapterRegistry } from "../provider/registry"
import type { CliStatus } from "../cli/detect"
import type { GrokProviderStatusProbe } from "../provider/runtime/grok-cli/GrokProviderStatus"
import type { ResolvedCursorBinary } from "../provider/runtime/cursor/CursorBinaryResolution"
import {
  CliStatusDeadlineError,
  createCliStatusReader,
  type CliStatusReaderDependencies,
} from "./cli-status"

afterEach(() => {
  vi.useRealTimers()
})

describe("CLI status reader", () => {
  it("uses TTL caching, honors refresh, and never calls sync CLI configuration", async () => {
    let now = 1_000
    const cliIsConfigured = vi.fn(() => {
      throw new Error("sync CLI probe must not run")
    })
    const apiIsConfigured = vi.fn(() => true)
    const registry = makeRegistry([
      makeAdapter("anthropic_cli", "Claude CLI", cliIsConfigured, "cli"),
      makeAdapter("openai", "OpenAI", apiIsConfigured, "api-key"),
    ])
    const dependencies = makeDependencies({
      now: () => now,
      ttlMs: 100,
    })
    const reader = createCliStatusReader(registry, dependencies)

    const first = await reader()
    const cached = await reader()

    expect(cached).toBe(first)
    expect(dependencies.detectClaude).toHaveBeenCalledTimes(1)
    expect(dependencies.detectCodex).toHaveBeenCalledTimes(1)
    expect(dependencies.probeGrok).toHaveBeenCalledTimes(1)
    expect(cliIsConfigured).not.toHaveBeenCalled()
    expect(apiIsConfigured).toHaveBeenCalledTimes(1)
    expect(first.adapters.anthropic_cli).toMatchObject({ configured: true })

    now += 101
    await reader()
    expect(dependencies.detectClaude).toHaveBeenCalledTimes(2)

    await reader({ refresh: true })
    expect(dependencies.detectClaude).toHaveBeenCalledTimes(3)
    expect(dependencies.detectClaude).toHaveBeenNthCalledWith(1, false)
    expect(dependencies.detectClaude).toHaveBeenNthCalledWith(3, true)
  })

  it("singleflight-coalesces concurrent cold probes", async () => {
    let resolveClaude!: (status: CliStatus) => void
    const claudePending = new Promise<CliStatus>((resolve) => {
      resolveClaude = resolve
    })
    const dependencies = makeDependencies({
      detectClaude: vi.fn(async () => claudePending),
    })
    const reader = createCliStatusReader(makeRegistry([]), dependencies)

    const first = reader()
    const second = reader({ refresh: true })

    expect(dependencies.detectClaude).toHaveBeenCalledTimes(1)
    expect(dependencies.detectCodex).toHaveBeenCalledTimes(1)
    expect(dependencies.probeGrok).toHaveBeenCalledTimes(1)

    resolveClaude(cliStatus({ binaryPath: "/bin/claude" }))
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondResult).toBe(firstResult)
  })

  it("fails a cold request at the hard response deadline", async () => {
    vi.useFakeTimers()
    const dependencies = makeDependencies({
      detectClaude: vi.fn(() => new Promise<CliStatus>(() => {})),
      deadlineMs: 50,
    })
    const reader = createCliStatusReader(makeRegistry([]), dependencies)

    const expectation = expect(reader()).rejects.toBeInstanceOf(
      CliStatusDeadlineError
    )
    await vi.advanceTimersByTimeAsync(50)
    await expectation
  })

  it("serves the stale snapshot when a refresh misses the deadline", async () => {
    vi.useFakeTimers()
    let now = 1_000
    const detectClaude = vi
      .fn<CliStatusReaderDependencies["detectClaude"]>()
      .mockResolvedValueOnce(cliStatus({ binaryPath: "/bin/claude" }))
      .mockImplementationOnce(() => new Promise<CliStatus>(() => {}))
    const dependencies = makeDependencies({
      detectClaude,
      now: () => now,
      ttlMs: 10,
      deadlineMs: 50,
    })
    const reader = createCliStatusReader(makeRegistry([]), dependencies)
    const fresh = await reader()
    now += 11

    const expectation = expect(reader()).resolves.toBe(fresh)
    await vi.advanceTimersByTimeAsync(50)
    await expectation
  })

  it("reports Cursor from filesystem resolution with auth left unknown", async () => {
    const dependencies = makeDependencies()
    const reader = createCliStatusReader(makeRegistry([]), dependencies)

    const snapshot = await reader()

    expect(snapshot.cli.cursor).toEqual({
      installed: true,
      version: null,
      binaryPath: "/bin/cursor-agent",
      authenticated: false,
      authType: null,
    })
    expect(snapshot.adapters.cursor).toBeUndefined()

    const missing = createCliStatusReader(
      makeRegistry([]),
      makeDependencies({ resolveCursor: vi.fn(async () => null) })
    )
    expect((await missing()).cli.cursor).toMatchObject({
      installed: false,
      binaryPath: "",
    })
  })
})

function makeDependencies(
  overrides: Partial<CliStatusReaderDependencies> = {}
): CliStatusReaderDependencies {
  return {
    detectClaude: vi.fn(async () =>
      cliStatus({ binaryPath: "/bin/claude" })
    ),
    detectCodex: vi.fn(async () =>
      cliStatus({ binaryPath: "/bin/codex" })
    ),
    detectOpencode: vi.fn(async () =>
      cliStatus({ binaryPath: "/bin/opencode" })
    ),
    probeGrok: vi.fn(async () => grokStatus()),
    resolveCursor: vi.fn(async () => cursorBinary()),
    now: Date.now,
    ttlMs: 30_000,
    deadlineMs: 8_000,
    ...overrides,
  }
}

function makeRegistry(
  adapters: ReadonlyArray<ProviderAdapter>
): ProviderAdapterRegistry {
  return { all: () => [...adapters] } as unknown as ProviderAdapterRegistry
}

function makeAdapter(
  provider: string,
  name: string,
  isConfigured: () => boolean,
  authType: string
): ProviderAdapter {
  return {
    providerKind: () => provider,
    displayName: () => name,
    isConfigured,
    authMeta: () => ({ authType }),
  } as unknown as ProviderAdapter
}

function cliStatus(overrides: Partial<CliStatus> = {}): CliStatus {
  return {
    installed: true,
    version: "1.2.3",
    binaryPath: "/bin/tool",
    authenticated: true,
    authType: "cli",
    ...overrides,
  }
}

function cursorBinary(): ResolvedCursorBinary {
  return { binaryPath: "/bin/cursor-agent", source: "path" }
}

function grokStatus(): GrokProviderStatusProbe {
  return {
    installed: true,
    configured: true,
    binaryPath: "/bin/grok",
    version: "1.2.3",
    status: "ready",
    auth: { status: "authenticated", type: "oauth" },
  }
}
