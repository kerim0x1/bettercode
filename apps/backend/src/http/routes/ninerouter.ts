import type { Hono, MiddlewareHandler } from "hono"
import {
  createNineRouterConnectionSchema,
  nineRouterConnectionIdSchema,
  updateNineRouterConnectionSchema,
  type NineRouterProviderView,
} from "@betterc0de/schema"
import type { AppState } from "../../appState"
import { NineRouterService } from "../../provider/ninerouter/service"
import { requestIdentity } from "../../remote/http"
import { HttpError } from "../errors"
import { parseAndHandle } from "../routeHelpers"

/**
 * 9Router connections. Reading the connection list (with models and status)
 * is open to paired devices so the phone picker matches the desktop; host
 * addresses are removed for them. Everything that writes, checks, or probes
 * the local machine is desktop-owner only.
 */
export function registerNineRouterRoutes(api: Hono, state: AppState): void {
  const service = state.nineRouter ?? new NineRouterService(state.settings)
  const ownerOnly: MiddlewareHandler = async (c, next) => {
    if (requestIdentity(c, state.config, state)?.kind !== "local")
      return c.json(
        { error: "Only the desktop owner can manage 9Router connections." },
        403
      )
    await next()
  }
  api.use("/providers/ninerouter/connections", ownerOnly)
  api.use("/providers/ninerouter/connections/*", ownerOnly)
  api.use("/providers/ninerouter/detect", ownerOnly)

  const connectionId = (raw: string) => {
    const parsed = nineRouterConnectionIdSchema.safeParse(raw)
    if (!parsed.success) throw new HttpError(400, "Invalid connection id")
    return parsed.data
  }

  api.get("/providers/ninerouter", async (c) => {
    const view = await service.view({
      refresh: c.req.query("refresh") === "1",
      includeHidden: c.req.query("includeHidden") === "1",
    })
    return c.json(
      requestIdentity(c, state.config, state)?.kind === "local"
        ? view
        : withoutHostAddresses(view)
    )
  })
  api.get("/providers/ninerouter/detect", async (c) =>
    c.json(await service.detect())
  )
  api.post("/providers/ninerouter/connections", (c) =>
    parseAndHandle(
      c,
      createNineRouterConnectionSchema,
      async (body) => service.create(body),
      { operation: "9Router connection add" }
    )
  )
  api.patch("/providers/ninerouter/connections/:id", (c) =>
    parseAndHandle(
      c,
      updateNineRouterConnectionSchema,
      async (body) => service.update(connectionId(c.req.param("id")), body),
      { operation: "9Router connection update" }
    )
  )
  api.delete("/providers/ninerouter/connections/:id", async (c) =>
    c.json(await service.remove(connectionId(c.req.param("id"))))
  )
  api.post("/providers/ninerouter/connections/:id/test", async (c) =>
    c.json(await service.test(connectionId(c.req.param("id"))))
  )
}

function withoutHostAddresses(
  view: NineRouterProviderView
): NineRouterProviderView {
  return {
    ...view,
    connections: view.connections.map((connection) => ({
      ...connection,
      baseUrl: "",
      dashboardUrl: "",
      status: { ...connection.status, message: null },
    })),
  }
}
