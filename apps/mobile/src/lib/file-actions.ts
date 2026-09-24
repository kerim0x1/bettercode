import { describeRemoteError } from "@/lib/remote-errors"
import { RemoteApiError } from "@/transport/live/http"

/**
 * Creating, renaming and deleting files from the phone, in the desktop's
 * words where the desktop has them (its Explorer's delete question).
 */

/** Why a name cannot be used for a file or folder, or null when it can. */
export function fileNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "Enter a name."
  if (/[\\/]/.test(trimmed)) return "A name cannot contain / or \\."
  if (trimmed === "." || trimmed === "..") return "Choose another name."
  if (trimmed.length > 255) return "The name is too long."
  return null
}

/** A path relative to the project, from a folder's and a name. */
export function childPath(folder: string, name: string): string {
  return folder ? `${folder}/${name.trim()}` : name.trim()
}

export function deleteConfirmation(entry: { name: string; isDir: boolean }) {
  return {
    title: `Delete ${entry.isDir ? "folder" : "file"}?`,
    message: `"${entry.name}" will be permanently deleted.`,
    action: "Delete",
  }
}

/**
 * What went wrong with a file action, in words. The desktop answers a name
 * that is taken with 409 and a code, without saying so in words.
 */
export function fileActionError(
  error: unknown,
  action: "create" | "rename" | "delete"
): { title: string; message: string } {
  if (
    action !== "delete" &&
    error instanceof RemoteApiError &&
    error.status === 409 &&
    (error.code === "WORKSPACE_PATH_CHANGED" || error.code === "EEXIST")
  ) {
    return {
      title: "Name already taken",
      message: "A file or folder with this name already exists here.",
    }
  }
  const described = describeRemoteError(error)
  return {
    title:
      described.title === "Request failed" ||
      described.title === "Desktop error"
        ? action === "create"
          ? "Could not create it"
          : action === "rename"
            ? "Could not rename it"
            : "Could not delete it"
        : described.title,
    message: described.message,
  }
}
