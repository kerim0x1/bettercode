import { create } from "zustand"

/**
 * Who is writing: the Git identity of the active project, as the sidebar
 * footer shows it. `githubUser` is the GitHub login when Git names one
 * (`github.user`, a noreply address or a handle-like user name).
 */
interface UserIdentityState {
  name: string
  githubUser: string
  setIdentity: (identity: { name: string; githubUser: string }) => void
}

export const useUserIdentityStore = create<UserIdentityState>((set) => ({
  name: "",
  githubUser: "",
  setIdentity: ({ name, githubUser }) => set({ name, githubUser }),
}))

/** The GitHub avatar for a login, at twice the shown size for sharpness. */
export function githubAvatarUrl(githubUser: string, size: number): string {
  return `https://github.com/${encodeURIComponent(githubUser)}.png?size=${size * 2}`
}

/** One or two initials for an avatar without a picture. */
export function identityInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  const first = parts[0]?.charAt(0) ?? ""
  const last = parts.length > 1 ? (parts.at(-1)?.charAt(0) ?? "") : ""
  return `${first}${last}`.toUpperCase() || "U"
}
