import type { AppState } from "../../appState"
import type { ChatResumeScheduler } from "./resume-scheduler"

/**
 * The backend's chat resume scheduler (resume-runtime.ts), for the turn
 * path to tell it about sends and stops without importing its wiring.
 */
export const chatResumes = new WeakMap<AppState, ChatResumeScheduler>()
