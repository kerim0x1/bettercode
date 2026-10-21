import type { Context, Hono } from "hono"
import type { AppState } from "../../appState"
import { requestIdentity } from "../../remote/http"
import * as browser from "../../services/filesystem-browser"
import { resolveApprovedWorkspaceRoot } from "../../services/workspace/authorization"
import { contractJson, handleHttpContract } from "../contracts"
import { sanitizeError } from "../errors"

/**
 * Read-only filesystem browsing endpoints, backing the System Browser
 * overlay in the renderer. Distinct from `/workspace/*` — those are
 * project-scoped (contained to a `cwd`), these accept arbitrary absolute
 * paths on the user's machine. All paths pass through
 * `assertSafeAbsolutePath` inside the service layer; the HTTP boundary
 * additionally applies zod schemas to reject malformed bodies early.
 *
 * The desktop renderer may browse the whole machine (it is the user's own
 * file picker). A paired remote device may only browse inside registered
 * workspace roots — the companion app uses these routes for a thread's
 * project files and nothing else. `/filesystem/drives` is desktop-only at
 * the router. `state` is optional only so the routes can be mounted bare in
 * tests; the router always passes it.
 *
 * No write operations are exposed here; for writes go through `/workspace/*`
 * which enforces project containment. Every route answers with its shared
 * contract (`@betterc0de/schema/http-contracts`).
 */
export function registerFilesystemRoutes(api: Hono, state?: AppState): void {
  const confineForRemote = async (
    c: Context,
    requested: string
  ): Promise<string> => {
    if (!state) return requested
    const identity = requestIdentity(c, state.config, state)
    if (identity?.kind !== "remote") return requested
    return resolveApprovedWorkspaceRoot(state, requested)
  }

  api.post("/filesystem/list", (c) =>
    handleHttpContract(
      c,
      "filesystemList",
      async (b) =>
        browser.listDirectory(
          await confineForRemote(c, b.path),
          b.showHidden,
          b.offset
        ),
      { operation: "filesystem list" }
    )
  )

  api.post("/filesystem/search", (c) =>
    handleHttpContract(
      c,
      "filesystemSearch",
      async (b) =>
        browser.searchTree(await confineForRemote(c, b.root), b.query, b.limit),
      { operation: "filesystem search" }
    )
  )

  api.get("/filesystem/drives", async (c) => {
    try {
      return contractJson(
        c,
        "filesystemDrives",
        await browser.enumerateDrives()
      )
    } catch (err) {
      const { message, statusCode } = sanitizeError(err, "filesystem drives", {
        path: "/filesystem/drives",
      })
      return c.json({ error: message }, statusCode as 500)
    }
  })
}
