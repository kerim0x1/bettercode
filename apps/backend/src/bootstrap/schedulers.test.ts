import { afterEach, expect, it, vi } from "vitest"
import { incrementalVacuum } from "../persistence/db"
import type {
  BootRoot,
  PersistenceContext,
  ProvidersContext,
  SettingsContext,
} from "./context"
import { startTimers } from "./schedulers"

vi.mock("../persistence/db", () => ({ incrementalVacuum: vi.fn() }))

const cleanup: BootRoot["startupCleanup"] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step.run()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it("does not turn a 30-day vacuum cadence into Node's overflowing 1ms timer", async () => {
  vi.stubEnv("BETTERC0DE_PROVIDER_SESSION_REAPER", "0")
  vi.stubEnv("BETTERC0DE_VACUUM_INTERVAL_MS", String(30 * 24 * 60 * 60 * 1000))
  const timers = startTimers(
    { startupCleanup: cleanup } as BootRoot,
    {} as PersistenceContext,
    {
      transcriptRecoveryStore: { replay: vi.fn() },
    } as unknown as SettingsContext,
    // No runtime home: the automations scheduler starts nothing.
    { state: { config: {} } } as unknown as ProvidersContext
  )
  expect(timers.vacuumTimer).not.toBeNull()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(incrementalVacuum).not.toHaveBeenCalled()
})
