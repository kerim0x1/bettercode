import type { Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import {
  AUTOMATION_ID_PATTERN,
  AUTOMATION_LIMITS,
  AUTOMATION_WEBHOOK_PATH_PREFIX,
  AUTOMATION_WEBHOOK_TOKEN_PATTERN,
  type AutomationWebhookEndpoint,
} from "@betterc0de/schema"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import {
  discoverRemoteEndpoints,
  isLocalOwnerRequest,
  isRemoteRequestTransportAllowed,
} from "../../remote/http"
import { automationServices } from "../../services/automations/registry"
import type { AutomationService } from "../../services/automations/service"
import { contractJson, handleHttpContract } from "../contracts"

/**
 * Where a webhook can be delivered: the Remote Access addresses while it is
 * on (custom URL, Tailscale, local network, this computer), otherwise only
 * this computer.
 */
async function webhookEndpoints(state: AppState): Promise<{
  endpoints: AutomationWebhookEndpoint[]
  remoteAccessEnabled: boolean
}> {
  const remoteAccessEnabled =
    state.settings.get().remote_access_enabled === true
  const discovered = remoteAccessEnabled
    ? await discoverRemoteEndpoints(state.config, state)
    : []
  const endpoints: AutomationWebhookEndpoint[] =
    discovered.length > 0
      ? discovered.map((endpoint) => ({
          id: endpoint.id,
          label: endpoint.label,
          baseUrl: endpoint.httpBaseUrl,
          reachability: endpoint.reachability,
          isDefault: endpoint.isDefault,
        }))
      : [
          {
            id: "loopback",
            label: "This computer",
            baseUrl: `http://127.0.0.1:${state.config.port}`,
            reachability: "loopback",
            isDefault: true,
          },
        ]
  return { endpoints, remoteAccessEnabled }
}

/**
 * `/automations/*`: list, create, edit, pause or resume, run now, delete,
 * and rotate a webhook URL. Desktop only: `DESKTOP_ONLY_PATHS` refuses
 * paired devices before a route runs, and each route checks again.
 */
export function registerAutomationRoutes(api: Hono, state: AppState): void {
  const service = (c: Context): AutomationService => {
    if (!isLocalOwnerRequest(c, state.config, state)) {
      throw new HttpError(
        403,
        "Automations are managed in the BetterC0de desktop app.",
        "desktop_only"
      )
    }
    const found = automationServices.get(state)
    if (!found) {
      throw new HttpError(
        503,
        "Automations are unavailable.",
        "automations_unavailable"
      )
    }
    return found
  }
  const automationId = (c: Context): string => c.req.param("id") ?? ""

  api.get("/automations", (c) =>
    contractJson(c, "automationList", { automations: service(c).list() })
  )

  // Before `/automations/:id`, which would otherwise take this path.
  api.get("/automations/webhook-endpoints", async (c) => {
    service(c)
    return contractJson(
      c,
      "automationWebhookEndpoints",
      await webhookEndpoints(state)
    )
  })

  api.get("/automations/:id", (c) =>
    contractJson(c, "automationGet", service(c).detail(automationId(c)))
  )

  api.post("/automations", (c) =>
    handleHttpContract(
      c,
      "automationCreate",
      async (body, context) => ({
        automation: await service(context).create(body),
      }),
      { operation: "automation create" }
    )
  )

  api.put("/automations/:id", (c) =>
    handleHttpContract(
      c,
      "automationUpdate",
      async (body, context) => ({
        automation: await service(context).update(automationId(context), body),
      }),
      { operation: "automation update" }
    )
  )

  api.delete("/automations/:id", (c) =>
    contractJson(c, "automationDelete", {
      deleted: service(c).remove(automationId(c)),
    })
  )

  api.post("/automations/:id/enabled", (c) =>
    handleHttpContract(
      c,
      "automationSetEnabled",
      async (body, context) => ({
        automation: service(context).setEnabled(
          automationId(context),
          body.enabled
        ),
      }),
      { operation: "automation pause or resume" }
    )
  )

  api.post("/automations/:id/run", (c) =>
    contractJson(c, "automationRunNow", {
      run: service(c).runNow(automationId(c)),
    })
  )

  api.post("/automations/:id/webhook/rotate", (c) =>
    contractJson(c, "automationWebhookRotate", {
      automation: service(c).rotateWebhook(automationId(c)),
    })
  )
}

/**
 * `POST /hooks/automations/:id/:token`: the public webhook, mounted beside
 * `/api/v1` so it needs no session. It can do one thing: hand a delivery to
 * the automation whose token it carries (`AutomationService.receiveWebhook`,
 * constant-time token check, per-automation rate limit, optional GitHub
 * signature). The body is read as raw bytes, at most 256 KB, so the
 * signature covers exactly what was sent. The transport rules match the API:
 * HTTPS, this computer, the tailnet or a private network.
 */
export function registerAutomationWebhookRoute(
  app: Hono,
  state: AppState
): void {
  app.use(
    `${AUTOMATION_WEBHOOK_PATH_PREFIX}/*`,
    bodyLimit({
      maxSize: AUTOMATION_LIMITS.webhookMaxBodyBytes,
      onError: (c) =>
        c.json(
          {
            error: "The request body is larger than 256 KB.",
            code: "request_too_large",
          },
          413
        ),
    })
  )

  app.post("/hooks/automations/:id/:token", async (c) => {
    c.header("Cache-Control", "no-store")
    if (!isRemoteRequestTransportAllowed(c, state.config)) {
      return c.json(
        {
          error: "secure transport required",
          code: "secure_transport_required",
        },
        426
      )
    }
    const service = automationServices.get(state)
    if (!service) {
      return c.json(
        {
          error: "Automations are unavailable.",
          code: "automations_unavailable",
        },
        503
      )
    }
    const id = c.req.param("id") ?? ""
    const token = c.req.param("token") ?? ""
    if (
      !AUTOMATION_ID_PATTERN.test(id) ||
      !AUTOMATION_WEBHOOK_TOKEN_PATTERN.test(token)
    ) {
      return c.json({ error: "Not found.", code: "not_found" }, 404)
    }
    let outcome: ReturnType<AutomationService["receiveWebhook"]>
    try {
      const body = new Uint8Array(await c.req.arrayBuffer())
      const headers: Array<[string, string]> = []
      c.req.raw.headers.forEach((value, name) => {
        headers.push([name, value])
      })
      outcome = service.receiveWebhook({
        automationId: id,
        token,
        body,
        contentType: c.req.header("Content-Type"),
        headers,
      })
    } catch (error) {
      // Handled here rather than by the app's error handler, which logs the
      // request path, and this path carries the webhook's token.
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "an automation webhook delivery failed"
      )
      return c.json(
        { error: "The delivery failed.", code: "webhook_failed" },
        500
      )
    }
    if ("response" in outcome) {
      return contractJson(
        c,
        "automationWebhook",
        outcome.response,
        outcome.status
      )
    }
    if (outcome.retryAfterMs !== undefined) {
      c.header(
        "Retry-After",
        String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)))
      )
    }
    return c.json({ error: outcome.error, code: outcome.code }, outcome.status)
  })
}
