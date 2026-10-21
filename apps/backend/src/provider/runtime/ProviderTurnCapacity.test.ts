import { describe, expect, it } from "vitest"
import type { ProviderAdapterShape } from "./contracts"
import {
  ProviderSessionCapacityError,
  ProviderTurnCapacityError,
} from "./ProviderHubErrors"
import type { ProviderRuntimeInstance } from "./ProviderHubTypes"
import {
  ProviderTurnCapacity,
  type ProviderTurnCapacityEntry,
} from "./ProviderTurnCapacity"

function instance(
  instanceId: string,
  adapter: ProviderAdapterShape
): ProviderRuntimeInstance {
  return {
    instanceId,
    driver: "codex",
    provider: "codex",
    enabled: true,
    adapter,
  }
}

function admissions(
  entries: ReadonlyArray<ProviderTurnCapacityEntry>
): ReadonlyMap<string, ProviderTurnCapacityEntry> {
  return new Map(entries.map((entry, index) => [`thread-${index}`, entry]))
}

describe("ProviderTurnCapacity", () => {
  it("uses the defaults and clamps requested limits to the hard caps", () => {
    const defaults = new ProviderTurnCapacity({})
    expect(defaults).toMatchObject({
      maxActiveTurns: 32,
      maxActiveTurnsPerProvider: 16,
      maxActiveTurnsPerInstance: 8,
      maxLiveSessions: 64,
      maxLiveSessionsPerInstance: 16,
      sessionAdmissionQueueMaxEntries: 64,
    })

    const clamped = new ProviderTurnCapacity({
      maxActiveTurns: 10_000,
      maxActiveTurnsPerProvider: 0,
      maxActiveTurnsPerInstance: Number.NaN,
      maxLiveSessions: 2.9,
      sessionAdmissionQueueMaxEntries: 10_000,
    })
    expect(clamped).toMatchObject({
      maxActiveTurns: 128,
      maxActiveTurnsPerProvider: 1,
      maxActiveTurnsPerInstance: 8,
      maxLiveSessions: 2,
      sessionAdmissionQueueMaxEntries: 256,
    })
  })

  it("refuses a turn at the global, provider and backend limits", () => {
    const shared = {} as ProviderAdapterShape
    const other = {} as ProviderAdapterShape
    const capacity = new ProviderTurnCapacity({
      maxActiveTurns: 3,
      maxActiveTurnsPerProvider: 2,
      maxActiveTurnsPerInstance: 1,
    })
    const onShared = instance("codex", shared)

    expect(() =>
      capacity.assertTurnCapacity(admissions([]), "codex", onShared)
    ).not.toThrow()

    // Another instance on the same adapter counts against the same backend.
    const sameBackend = admissions([
      {
        providerKind: "claude",
        providerInstanceId: "codex-alias",
        providerInstance: instance("codex-alias", shared),
      },
    ])
    expect(() =>
      capacity.assertTurnCapacity(sameBackend, "codex", onShared)
    ).toThrowError(expect.objectContaining({ scope: "instance", limit: 1 }))
    // Before resolution, an admission counts by its requested instance id.
    const unresolved = admissions([
      {
        providerKind: "claude",
        providerInstanceId: "codex",
        providerInstance: null,
      },
    ])
    expect(() =>
      capacity.assertTurnCapacity(unresolved, "codex", onShared)
    ).toThrowError(ProviderTurnCapacityError)

    const sameProvider = admissions([
      {
        providerKind: "codex",
        providerInstanceId: "a",
        providerInstance: instance("a", other),
      },
      {
        providerKind: "codex",
        providerInstanceId: "b",
        providerInstance: instance("b", other),
      },
    ])
    expect(() =>
      capacity.assertTurnCapacity(sameProvider, "codex", null)
    ).toThrowError(expect.objectContaining({ scope: "provider", limit: 2 }))

    const full = admissions([
      {
        providerKind: "claude",
        providerInstanceId: null,
        providerInstance: null,
      },
      {
        providerKind: "cursor",
        providerInstanceId: null,
        providerInstance: null,
      },
      {
        providerKind: "grok_cli",
        providerInstanceId: null,
        providerInstance: null,
      },
    ])
    expect(() => capacity.assertTurnCapacity(full, "codex", null)).toThrowError(
      expect.objectContaining({ scope: "global", limit: 3 })
    )
  })

  it("refuses a session at the global and per-backend live-session limits", () => {
    const target = {} as ProviderAdapterShape
    const other = {} as ProviderAdapterShape
    const capacity = new ProviderTurnCapacity({
      maxLiveSessions: 3,
      maxLiveSessionsPerInstance: 2,
    })
    const onTarget = instance("codex", target)

    expect(() =>
      capacity.assertSessionCapacity(
        onTarget,
        new Map([[target, new Set(["t1"])]])
      )
    ).not.toThrow()
    expect(() =>
      capacity.assertSessionCapacity(
        onTarget,
        new Map([[target, new Set(["t1", "t2"])]])
      )
    ).toThrowError(expect.objectContaining({ scope: "instance", limit: 2 }))
    expect(() =>
      capacity.assertSessionCapacity(
        onTarget,
        new Map([
          [target, new Set(["t1"])],
          [other, new Set(["t2", "t3"])],
        ])
      )
    ).toThrowError(ProviderSessionCapacityError)
  })
})
