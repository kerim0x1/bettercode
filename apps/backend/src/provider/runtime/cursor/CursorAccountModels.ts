import { createHash } from "node:crypto"
import type { ProviderModel } from "../contracts"
import { CliModelSnapshot } from "../CliModelSnapshot"
import type { CursorAcpAdapterOptions } from "./CursorAcpAdapter"
import { probeCursorProviderStatus } from "./CursorProviderStatus"

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export async function cursorModelAccountIdentity(
  options: CursorAcpAdapterOptions,
  input: { readonly force: boolean }
): Promise<string | null> {
  // A runtime factory is the deterministic test seam and must never probe the
  // developer's actual Cursor login or environment.
  const env = options.statusEnv ?? (options.runtimeFactory ? {} : process.env)
  for (const name of ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] as const) {
    const value = env[name]?.trim()
    if (value) return fingerprint(`${name}\0${value}`)
  }
  if (options.runtimeFactory) return options.modelAccountIdentity ?? null
  const status = await probeCursorProviderStatus({
    binaryPath: options.binaryPath ?? "",
    env,
    refresh: input.force,
  })
  const email = status.auth.email?.trim().toLowerCase()
  return status.auth.status === "authenticated" && email
    ? fingerprint(`cursor-login\0${email}`)
    : null
}

export function cursorAccountModels(
  options: CursorAcpAdapterOptions,
  identity: string | null
): ReadonlyArray<ProviderModel> {
  return (
    new CliModelSnapshot(options.modelCacheDir).read(
      "cursor",
      options.providerInstanceId ?? "cursor",
      identity
    ) ?? []
  )
}

export function saveCursorAccountModels(
  options: CursorAcpAdapterOptions,
  models: ReadonlyArray<ProviderModel>,
  identity: string | null
): void {
  new CliModelSnapshot(options.modelCacheDir).write(
    "cursor",
    options.providerInstanceId ?? "cursor",
    identity,
    models
  )
}
