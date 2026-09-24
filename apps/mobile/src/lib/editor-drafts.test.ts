import { afterEach, describe, expect, it } from "vitest"
import {
  clearDraft,
  draftFor,
  forgetAllDrafts,
  MAX_DRAFTS,
  saveDraft,
  type EditorDraft,
} from "./editor-drafts"
import {
  documents,
  memoryDocumentStorage,
  setDocumentStorage,
} from "./local-documents"

afterEach(() => setDocumentStorage(memoryDocumentStorage()))

const draft = (path: string, text = "edited\n"): EditorDraft => ({
  root: "/repo",
  path,
  text,
  baseSha256: "a".repeat(64),
  savedAt: "2026-09-24T10:00:00.000Z",
})

describe("editor drafts", () => {
  it("keep one draft a file, the newest, until it is cleared", () => {
    setDocumentStorage(memoryDocumentStorage())
    saveDraft(draft("src/a.ts", "first\n"))
    saveDraft(draft("src/a.ts", "second\n"))
    saveDraft(draft("src/b.ts"))
    expect(draftFor("/repo", "src/a.ts")?.text).toBe("second\n")
    expect(draftFor("/other", "src/a.ts")).toBeNull()
    clearDraft("/repo", "src/a.ts")
    expect(draftFor("/repo", "src/a.ts")).toBeNull()
    expect(draftFor("/repo", "src/b.ts")).not.toBeNull()
  })

  it(`keep the newest ${MAX_DRAFTS}, and all go with the pairing`, () => {
    setDocumentStorage(memoryDocumentStorage())
    for (let index = 0; index <= MAX_DRAFTS; index += 1) {
      saveDraft(draft(`file-${index}.ts`))
    }
    expect(draftFor("/repo", "file-0.ts")).toBeNull()
    expect(draftFor("/repo", `file-${MAX_DRAFTS}.ts`)).not.toBeNull()
    forgetAllDrafts()
    expect(draftFor("/repo", `file-${MAX_DRAFTS}.ts`)).toBeNull()
  })

  it("read a damaged document as no drafts", () => {
    setDocumentStorage(memoryDocumentStorage())
    documents.write("editor-drafts.json", "{ not json")
    expect(draftFor("/repo", "src/a.ts")).toBeNull()
    documents.write("editor-drafts.json", JSON.stringify([{ root: "/repo" }]))
    expect(draftFor("/repo", "src/a.ts")).toBeNull()
  })
})
