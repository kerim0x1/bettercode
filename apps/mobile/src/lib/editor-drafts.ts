import { documents } from "@/lib/local-documents"

/**
 * Edits not yet saved on the desktop, kept on the phone so that leaving the
 * editor, a crash or a lost connection does not lose them. Each draft
 * remembers the file's SHA-256 it was made from, so saving it later still
 * finds out when the file changed on the desktop meanwhile. Drafts belong to
 * the pairing (AppRuntime forgets them when it ends) and the newest 20 are
 * kept.
 */

const DOCUMENT = "editor-drafts.json"
export const MAX_DRAFTS = 20

export interface EditorDraft {
  root: string
  /** The file, relative to the root. */
  path: string
  text: string
  /** The SHA-256 of the file the edits were made on. */
  baseSha256: string
  savedAt: string
}

function isDraft(value: unknown): value is EditorDraft {
  if (!value || typeof value !== "object") return false
  const draft = value as Record<string, unknown>
  return ["root", "path", "text", "baseSha256", "savedAt"].every(
    (key) => typeof draft[key] === "string"
  )
}

function readAll(): EditorDraft[] {
  try {
    const saved: unknown = JSON.parse(documents.read(DOCUMENT) ?? "[]")
    return Array.isArray(saved) ? saved.filter(isDraft) : []
  } catch {
    return []
  }
}

function writeAll(drafts: EditorDraft[]): void {
  documents.write(DOCUMENT, JSON.stringify(drafts))
}

const sameFile = (draft: EditorDraft, root: string, path: string) =>
  draft.root === root && draft.path === path

export function draftFor(root: string, path: string): EditorDraft | null {
  return readAll().find((draft) => sameFile(draft, root, path)) ?? null
}

/** Keeps the draft, newest first; the oldest go beyond MAX_DRAFTS. */
export function saveDraft(draft: EditorDraft): void {
  writeAll(
    [
      draft,
      ...readAll().filter((other) => !sameFile(other, draft.root, draft.path)),
    ].slice(0, MAX_DRAFTS)
  )
}

export function clearDraft(root: string, path: string): void {
  const drafts = readAll()
  const kept = drafts.filter((draft) => !sameFile(draft, root, path))
  if (kept.length !== drafts.length) writeAll(kept)
}

export function forgetAllDrafts(): void {
  writeAll([])
}
