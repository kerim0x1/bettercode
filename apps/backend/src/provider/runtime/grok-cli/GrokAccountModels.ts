import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ProviderModel } from "../contracts"
import { CliModelSnapshot, cliAccountIdentity } from "../CliModelSnapshot"
import type { GrokAcpAdapterOptions } from "./GrokAcpAdapter"
import { grokModelCachePath, readGrokModelCache } from "./GrokModelCache"

function homeDir(options: GrokAcpAdapterOptions): string {
  return options.modelHomeDir ?? os.homedir()
}

export function grokModelAccountIdentity(
  options: GrokAcpAdapterOptions
): string | null {
  const home = path.join(homeDir(options), ".grok")
  const credential = cliAccountIdentity("grok-cli", home)
  if (credential) return credential
  const apiKey =
    options.environment?.find((entry) => entry.name === "XAI_API_KEY")?.value ??
    process.env.XAI_API_KEY
  return apiKey?.trim()
    ? createHash("sha256").update(apiKey.trim()).digest("hex")
    : null
}

export function grokAccountModels(
  options: GrokAcpAdapterOptions
): ReadonlyArray<ProviderModel> {
  const account = grokModelAccountIdentity(options)
  if (!account) return []
  const instanceId = options.providerInstanceId ?? "grok-cli"
  const snapshot = new CliModelSnapshot(options.modelCacheDir).read(
    "grok-cli",
    instanceId,
    account
  )
  if (snapshot) return snapshot

  // The CLI cache predates our own snapshots. Use it only when it was written
  // after the current on-disk login, so an account switch cannot revive the
  // preceding account's models.
  const home = homeDir(options)
  const authHome = path.join(home, ".grok")
  const authModified = ["credentials.json", "auth.json", "config.toml"]
    .map((name) => modifiedAt(path.join(authHome, name)))
    .filter((value): value is number => value !== null)
  const catalogModified = modifiedAt(grokModelCachePath(home))
  if (
    authModified.length === 0 ||
    catalogModified === null ||
    catalogModified < Math.max(...authModified)
  )
    return []
  return readGrokModelCache(home)
}

export function saveGrokAccountModels(
  options: GrokAcpAdapterOptions,
  models: ReadonlyArray<ProviderModel>
): void {
  new CliModelSnapshot(options.modelCacheDir).write(
    "grok-cli",
    options.providerInstanceId ?? "grok-cli",
    grokModelAccountIdentity(options),
    models
  )
}

function modifiedAt(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}
