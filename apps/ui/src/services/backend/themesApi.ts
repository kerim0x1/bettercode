import type { ImportedTheme, ImportedThemeSummary } from "@betterc0de/schema"
import type { InstalledThemeInfo } from "@betterc0de/schema/http-contracts"
import { invokeContract } from "./contracts"

// The `/themes` calls go through their shared contracts
// (`@betterc0de/schema/http-contracts`).

/** A color theme an installed VS Code or Cursor offers (desktop-only). */
export type { InstalledThemeInfo }

export function listImportedThemes(): Promise<ImportedThemeSummary[]> {
  return invokeContract("listThemes").then((r) => r.themes)
}

export function getImportedTheme(id: string): Promise<ImportedTheme> {
  return invokeContract("getTheme", { id })
}

export function listInstalledThemes(): Promise<InstalledThemeInfo[]> {
  return invokeContract("listInstalledThemes").then((r) => r.themes)
}

export function importInstalledTheme(id: string): Promise<ImportedTheme> {
  return invokeContract("importTheme", { body: { kind: "installed", id } })
}

export function importThemeText(input: {
  text: string
  name?: string
  source: "file" | "paste"
  label?: string
}): Promise<ImportedTheme> {
  return invokeContract("importTheme", { body: { kind: "text", ...input } })
}

export function deleteImportedTheme(id: string): Promise<{ deleted: boolean }> {
  return invokeContract("deleteTheme", { id })
}
