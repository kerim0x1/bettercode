import type { Hono } from "hono"
import { isRecord, VsCodeThemeParseError } from "@betterc0de/schema"
import type { ServerConfig } from "../../config"
import { contractJson } from "../contracts"
import { HttpError } from "../errors"
import { ThemeStore } from "../../services/themes/store"

const MAX_IMPORT_TEXT = 4 * 1024 * 1024

/**
 * Imported color themes. Reading is open to every authenticated client so a
 * paired browser renders the same theme as the desktop; scanning this
 * machine's editors, importing and deleting are desktop-only
 * (`DESKTOP_ONLY_PATHS` in remote/http.ts). Every answer is checked against
 * its shared contract (`@betterc0de/schema/http-contracts`); the import body
 * is read here, so a bad one gets this route's own reason and code.
 */
export function registerThemesRoutes(
  api: Hono,
  config: Pick<ServerConfig, "dataDir">
): void {
  // Lazy so building the app never touches the data directory.
  let cached: ThemeStore | null = null
  const storeOf = () => (cached ??= new ThemeStore(config.dataDir))

  api.get("/themes", (c) =>
    contractJson(c, "listThemes", { themes: storeOf().list() })
  )

  // Before `/themes/:id` so the literal segment wins.
  api.get("/themes/installed", (c) =>
    contractJson(c, "listInstalledThemes", {
      themes: storeOf()
        .installed()
        .map((theme) => ({
          id: theme.id,
          label: theme.label,
          app: theme.app,
          extensionId: theme.extensionId,
          extensionName: theme.extensionName,
          uiTheme: theme.uiTheme,
        })),
    })
  )

  api.get("/themes/:id", (c) => {
    const theme = storeOf().get(c.req.param("id"))
    if (!theme) throw new HttpError(404, "Theme not found", "theme_not_found")
    return contractJson(c, "getTheme", theme)
  })

  api.post("/themes/import", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      throw new HttpError(400, "Invalid import request", "invalid_request")
    }
    if (!isRecord(body)) {
      throw new HttpError(400, "Invalid import request", "invalid_request")
    }
    try {
      if (body.kind === "installed") {
        const id = typeof body.id === "string" ? body.id : ""
        const installed = storeOf()
          .installed()
          .find((theme) => theme.id === id)
        if (!installed) {
          throw new HttpError(
            404,
            "That theme is no longer installed",
            "theme_not_installed"
          )
        }
        return contractJson(
          c,
          "importTheme",
          storeOf().importInstalled(installed)
        )
      }
      if (body.kind === "text") {
        const text = typeof body.text === "string" ? body.text : ""
        if (!text.trim())
          throw new HttpError(400, "Theme text is empty", "theme_empty")
        if (text.length > MAX_IMPORT_TEXT) {
          throw new HttpError(
            413,
            "Theme file is larger than 4 MB",
            "theme_too_large"
          )
        }
        const source = body.source === "file" ? "file" : "paste"
        const label =
          typeof body.label === "string" && body.label.trim()
            ? body.label.trim().slice(0, 120)
            : source === "file"
              ? "theme.json"
              : "Pasted JSON"
        return contractJson(
          c,
          "importTheme",
          storeOf().importText({
            text,
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            source: { kind: source, label },
          })
        )
      }
      throw new HttpError(400, "Unknown import kind", "invalid_request")
    } catch (error) {
      if (error instanceof VsCodeThemeParseError) {
        throw new HttpError(422, error.message, "theme_invalid")
      }
      throw error
    }
  })

  api.delete("/themes/:id", (c) => {
    if (!storeOf().delete(c.req.param("id"))) {
      throw new HttpError(404, "Theme not found", "theme_not_found")
    }
    return contractJson(c, "deleteTheme", { deleted: true })
  })
}
