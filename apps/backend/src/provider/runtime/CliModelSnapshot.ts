import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { ProviderModel } from "./contracts"

/** A credential fingerprint is used only as a cache namespace. Credential
 * bytes and account labels are never written beside model metadata. */
export function cliAccountIdentity(
  driver: "claude" | "codex" | "grok-cli",
  home: string,
  email?: string | null
): string | null {
  const files =
    driver === "claude"
      ? [".credentials.json", "credentials.json", "auth.json"]
      : driver === "codex"
        ? ["auth.json", "credentials.json"]
        : ["credentials.json", "auth.json", "config.toml"]
  for (const name of files) {
    try {
      const contents = fs.readFileSync(path.join(home, name))
      if (contents.length > 0)
        return createHash("sha256").update(contents).digest("hex")
    } catch {
      // The CLI may keep credentials in the OS keychain instead.
    }
  }
  return email?.trim().toLowerCase() || null
}

export class CliModelSnapshot {
  constructor(private readonly directory?: string) {}

  read(
    driver: string,
    instanceId: string,
    account: string | null
  ): ProviderModel[] | null {
    const file = this.file(driver, instanceId, account)
    if (!file) return null
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) return null
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      if (!Array.isArray(parsed)) return null
      return parsed
        .filter(
          (model): model is ProviderModel =>
            model &&
            typeof model === "object" &&
            typeof model.slug === "string" &&
            typeof model.name === "string"
        )
        .slice(0, 1_000)
    } catch {
      return null
    }
  }

  write(
    driver: string,
    instanceId: string,
    account: string | null,
    models: ReadonlyArray<ProviderModel>
  ): void {
    const file = this.file(driver, instanceId, account)
    if (!file) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(models))
      fs.renameSync(temporary, file)
    } catch {
      // Metadata persistence is best effort; the live list still wins.
    }
  }

  private file(
    driver: string,
    instanceId: string,
    account: string | null
  ): string | null {
    if (!this.directory || !account) return null
    const key = createHash("sha256")
      .update(`${driver}\0${instanceId}\0${account}`)
      .digest("hex")
    return path.join(this.directory, `${driver}-${key}.json`)
  }
}
