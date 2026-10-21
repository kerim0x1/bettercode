/**
 * Automations transport: one function per `/automations` route, nothing
 * else. The backend keeps and runs the automations
 * (apps/backend services/automations); the Automations page
 * (`components/automations`) edits them. Desktop only: a paired browser gets
 * a 403. Keep store and hook imports out of this module.
 */
import type { AutomationInputBody } from "@betterc0de/schema"
import { invokeContract } from "./contracts"

export const listAutomations = () => invokeContract("automationList")

export const getAutomationWebhookEndpoints = () =>
  invokeContract("automationWebhookEndpoints")

export const getAutomation = (id: string) =>
  invokeContract("automationGet", { id })

export const createAutomation = (body: AutomationInputBody) =>
  invokeContract("automationCreate", { body })

export const updateAutomation = (id: string, body: AutomationInputBody) =>
  invokeContract("automationUpdate", { id, body })

export const deleteAutomation = (id: string) =>
  invokeContract("automationDelete", { id })

/** Pause (`false`) or resume (`true`). */
export const setAutomationEnabled = (id: string, enabled: boolean) =>
  invokeContract("automationSetEnabled", { id, body: { enabled } })

export const runAutomationNow = (id: string) =>
  invokeContract("automationRunNow", { id, body: {} })

export const rotateAutomationWebhook = (id: string) =>
  invokeContract("automationWebhookRotate", { id, body: {} })

/** A run's chat as the chat list keeps it; `404` when it was deleted. */
export const loadAutomationRunChat = (threadId: string) =>
  invokeContract("getThread", { id: threadId, silentStatuses: [404] })
