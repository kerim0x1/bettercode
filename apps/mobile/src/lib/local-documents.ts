/**
 * Small JSON documents the app keeps between launches: the composer's
 * settings per chat and the queued messages. Nothing secret goes here; the
 * pairing lives in the keychain (secure-session.ts).
 *
 * The storage behind them is chosen once at start: AppRuntime installs the
 * app's document folder (file-documents.ts). Until then, and in tests,
 * documents live in memory.
 */

export interface DocumentStorage {
  /** The document's text, or `null` when there is none. May throw. */
  read(name: string): string | null
  /** Replaces the document. May throw; callers decide whether that matters. */
  write(name: string, text: string): void
}

export function memoryDocumentStorage(): DocumentStorage {
  const stored = new Map<string, string>()
  return {
    read: (name) => stored.get(name) ?? null,
    write: (name, text) => {
      stored.set(name, text)
    },
  }
}

let storage: DocumentStorage = memoryDocumentStorage()

export function setDocumentStorage(next: DocumentStorage): void {
  storage = next
}

export const documents: DocumentStorage = {
  read: (name) => storage.read(name),
  write: (name, text) => storage.write(name, text),
}
