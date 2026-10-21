import type { Hono } from "hono"
import { isRecord, remoteSettingsPatchSchema } from "@betterc0de/schema"
import type { AppState } from "../../appState"
import { requestIdentity } from "../../remote/http"
import { contractJson, handleHttpContract } from "../contracts"
import { HttpError } from "../errors"

const remoteSettingKeys = new Set(Object.keys(remoteSettingsPatchSchema.shape))

/** Keys of `patch` a remote session is not allowed to touch. */
export function remoteForbiddenSettingKeys(
  patch: Record<string, unknown>
): string[] {
  return Object.keys(patch).filter((key) => !remoteSettingKeys.has(key))
}

export function registerSettingsRoutes(api: Hono, state: AppState): void {
  api.get("/settings", (c) =>
    contractJson(c, "getSettings", state.settings.getPublic())
  )

  api.patch("/settings", (c) =>
    handleHttpContract(
      c,
      "updateSettings",
      async (parsed) => {
        // A paired device must never be able to widen its own reach or
        // make the host run something: those are desktop-owner decisions
        // like the listener itself.
        if (requestIdentity(c, state.config, state)?.kind !== "local") {
          const forbidden = remoteForbiddenSettingKeys(parsed.patch)
          if (forbidden.length > 0) {
            throw new HttpError(
              403,
              `Only the desktop host can change ${forbidden.join(", ")}`,
              "remote_host_owner_required"
            )
          }
          if (!remoteSettingsPatchSchema.safeParse(parsed.patch).success) {
            throw new HttpError(
              400,
              "Invalid presentation settings.",
              "invalid_settings_patch"
            )
          }
        }
        return state.settings.updatePublic(parsed.patch)
      },
      { operation: "settings update" }
    )
  )

  api.post("/settings/deepgram-token", async (c) =>
    c.json(await createDeepgramAccessToken(state.settings))
  )

  api.get("/ws-port", (c) => c.json(state.config.port))
}

export async function createDeepgramAccessToken(
  settings: AppState["settings"],
  request: typeof fetch = fetch
): Promise<{ accessToken: string; expiresIn: number }> {
  const apiKey = (settings.get() as unknown as Record<string, unknown>)
    .deepgram_api_key
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new HttpError(
      400,
      "No Deepgram API key is configured",
      "deepgram_key_missing"
    )
  }

  let response: Response
  try {
    response = await request("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new HttpError(
      502,
      "Could not create a Deepgram access token",
      "deepgram_token_failed"
    )
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new HttpError(
      502,
      "Could not create a Deepgram access token",
      "deepgram_token_failed"
    )
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new HttpError(
      502,
      "Deepgram returned an invalid access token",
      "deepgram_token_invalid"
    )
  }
  if (
    !isRecord(payload) ||
    typeof payload.access_token !== "string" ||
    payload.access_token.length === 0
  ) {
    throw new HttpError(
      502,
      "Deepgram returned an invalid access token",
      "deepgram_token_invalid"
    )
  }
  return {
    accessToken: payload.access_token,
    expiresIn:
      typeof payload.expires_in === "number" &&
      Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 30,
  }
}
