import type { Hono } from "hono"
import type { ServerConfig } from "../../config"
import { collectProviderUsage } from "../../services/provider-usage"

/** Usage reports read from the locally installed provider CLIs' own stores. */
export function registerUsageRoutes(api: Hono, config: ServerConfig): void {
  api.get("/usage/providers", async (c) => {
    const refresh = c.req.query("refresh") === "1"
    return c.json(
      await collectProviderUsage({ dataDir: config.dataDir, refresh })
    )
  })
}
