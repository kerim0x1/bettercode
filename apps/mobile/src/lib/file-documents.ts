import { File, Paths } from "expo-file-system"
import type { DocumentStorage } from "./local-documents"

/** Documents in the app's own document folder, which the OS keeps across updates. */
export const fileDocumentStorage: DocumentStorage = {
  read(name) {
    const file = new File(Paths.document, name)
    return file.exists ? file.textSync() : null
  },
  write(name, text) {
    const file = new File(Paths.document, name)
    if (!file.exists) file.create()
    file.write(text)
  },
}
