import type { AppState } from "../../appState"
import { logger } from "../../observability/logger"
import { runtimeHomeOf } from "../desktop-config/paths"
import { createAutomationRunner, resolveAutomationProject } from "./runner"
import { AutomationService } from "./service"
import { FileAutomationStore } from "./store"

/**
 * This backend's automation service. Set by `startAutomations` (bootstrap
 * phase 8, `bootstrap/schedulers.ts`); the HTTP routes read it per request,
 * as they read the goal and Autonomous Work schedulers.
 */
export const automationServices = new WeakMap<AppState, AutomationService>()

function createService(
  state: AppState,
  home: string
): AutomationService | null {
  try {
    return new AutomationService({
      store: new FileAutomationStore(home),
      runner: createAutomationRunner(state),
      resolveProject: (projectPath, runLocation) =>
        resolveAutomationProject(state, projectPath, runLocation),
      available: () => !state.taintedRef() && !state.drainingRef(),
    })
  } catch (error) {
    // Automations are an add-on: the backend starts without them, and the
    // routes answer 503.
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "automations could not be started"
    )
    return null
  }
}

/**
 * Loads the automations from the runtime home and starts their scheduler.
 * Returns the step that stops it. Without a runtime home (a bare test
 * configuration) there are no automations and the routes answer 503.
 */
export function startAutomations(state: AppState): () => void {
  const home = runtimeHomeOf(state.config)
  const service = home ? createService(state, home) : null
  if (!service) return () => undefined
  automationServices.set(state, service)
  return () => {
    service.dispose()
    if (automationServices.get(state) === service) {
      automationServices.delete(state)
    }
  }
}
