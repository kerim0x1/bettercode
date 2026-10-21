import type { ImportedTheme, ImportedThemeSummary } from "@betterc0de/schema"
import { invoke } from "./runtime"

/** A color theme an installed VS Code or Cursor offers (desktop-only). */
export interface InstalledThemeInfo {
  id: string
  label: string
  app: "vscode" | "cursor"
  extensionId: string
  extensionName: string
  uiTheme: string | null
}

export function listImportedThemes(): Promise<ImportedThemeSummary[]> {
  return invoke<{ themes: ImportedThemeSummary[] }>("/themes").then(
    (r) => r.themes
  )
}

export function getImportedTheme(id: string): Promise<ImportedTheme> {
  return invoke<ImportedTheme>(`/themes/${encodeURIComponent(id)}`)
}

export function listInstalledThemes(): Promise<InstalledThemeInfo[]> {
  return invoke<{ themes: InstalledThemeInfo[] }>("/themes/installed").then(
    (r) => r.themes
  )
}

export function importInstalledTheme(id: string): Promise<ImportedTheme> {
  return invoke<ImportedTheme>("/themes/import", {
    method: "POST",
    body: { kind: "installed", id },
  })
}

export function importThemeText(input: {
  text: string
  name?: string
  source: "file" | "paste"
  label?: string
}): Promise<ImportedTheme> {
  return invoke<ImportedTheme>("/themes/import", {
    method: "POST",
    body: { kind: "text", ...input },
  })
}

export function deleteImportedTheme(id: string): Promise<{ deleted: boolean }> {
  return invoke(`/themes/${encodeURIComponent(id)}`, { method: "DELETE" })
}
