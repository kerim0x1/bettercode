import { HttpError } from "@/lib/errors/types"
import { createDirectory, writeFile } from "@/services/backend"

/**
 * "New file" and "New folder" in the Explorer. A new file never replaces an
 * existing one: it is written with `expectedSha256: null`, so the backend
 * refuses (409) when the name is taken instead of emptying that file.
 */
export async function createTreeEntry(
  cwd: string,
  name: string,
  type: "file" | "folder"
): Promise<void> {
  if (type === "file") {
    await writeFile(cwd, name, "", { expectedSha256: null })
  } else {
    await createDirectory(cwd, name)
  }
}

/** What to tell the user when creating failed. */
export function treeCreateErrorMessage(error: unknown): string {
  if (error instanceof HttpError && error.status === 409) {
    return "A file or folder with this name already exists."
  }
  return error instanceof Error && error.message
    ? error.message
    : "It could not be created."
}
