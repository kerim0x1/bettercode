import type { Hono } from "hono"
import type { ServerConfig } from "../../config"
import { collectProviderUsage } from "../../services/provider-usage"
import { contractResult } from "../contracts"

/**
 * Usage reports read from the locally installed provider CLIs' own stores,
 * checked against their shared contract (`thread-contracts.ts`).
 */
export function registerUsageRoutes(api: Hono, config: ServerConfig): void {
  api.get("/usage/providers", async (c) => {
    const refresh = c.req.query("refresh") === "1"
    return contractResult(
      c,
      "providerUsage",
      await collectProviderUsage({ dataDir: config.dataDir, refresh })
    )
  })
}
