import { z } from "zod"
import {
  automationDetailResponseSchema,
  automationInputSchema,
  automationListResponseSchema,
  automationRunSchema,
  automationViewSchema,
  automationWebhookEndpointsResponseSchema,
  automationWebhookResponseSchema,
} from "./automations"
import { endpoint, ignoredBody, noBody } from "./http-endpoint"

/**
 * The Automations routes (`apps/backend/src/http/routes/automations.ts`).
 * Everything under `/automations` belongs to the desktop host: paired
 * devices get a 403 (`DESKTOP_ONLY_PATHS` in `remote/http.ts`).
 *
 * `POST /hooks/automations/:id/:token` is the public webhook. It is mounted
 * beside `/api/v1`, needs no session, takes any JSON, form or text body (the
 * route reads it itself) and answers a delivery it took with
 * `automationWebhookResponseSchema`; refusals are `{ error, code }`.
 */

const automationResponseSchema = z.object({ automation: automationViewSchema })

export const automationHttpContracts = {
  automationList: endpoint(
    "GET",
    "/automations",
    noBody,
    automationListResponseSchema
  ),
  automationWebhookEndpoints: endpoint(
    "GET",
    "/automations/webhook-endpoints",
    noBody,
    automationWebhookEndpointsResponseSchema
  ),
  automationGet: endpoint(
    "GET",
    "/automations/:id",
    noBody,
    automationDetailResponseSchema
  ),
  automationCreate: endpoint(
    "POST",
    "/automations",
    automationInputSchema,
    automationResponseSchema
  ),
  automationUpdate: endpoint(
    "PUT",
    "/automations/:id",
    automationInputSchema,
    automationResponseSchema
  ),
  automationDelete: endpoint(
    "DELETE",
    "/automations/:id",
    noBody,
    z.object({ deleted: z.boolean() })
  ),
  /** Pause (`false`) or resume (`true`). */
  automationSetEnabled: endpoint(
    "POST",
    "/automations/:id/enabled",
    z.object({ enabled: z.boolean() }).strict(),
    automationResponseSchema
  ),
  /** Run now, whatever the trigger; a run still going is not doubled. */
  automationRunNow: endpoint(
    "POST",
    "/automations/:id/run",
    ignoredBody,
    z.object({ run: automationRunSchema })
  ),
  /** A new webhook token; the old URL stops working at once. */
  automationWebhookRotate: endpoint(
    "POST",
    "/automations/:id/webhook/rotate",
    ignoredBody,
    automationResponseSchema
  ),
  automationWebhook: endpoint(
    "POST",
    "/hooks/automations/:id/:token",
    ignoredBody,
    automationWebhookResponseSchema
  ),
} as const
